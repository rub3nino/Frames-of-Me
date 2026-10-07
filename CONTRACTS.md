# RePhoto contracts

Frozen v3 contract. Clarify wording only by editing this file in a follow-up; do not rename fields, routes, env vars, table columns, or job payload keys. This file describes the code as it is; `docs/v2-spec.md` and `docs/v3-uploader-spec.md` are the design notes that led to it and are not authoritative where they differ from this file (known deviation: original-stage `init` for a photo whose original is already present is `409`, not `400`).

Region assumption: `eu-central-1`. No Qdrant. No GPU. No SQS: the queue is the Postgres `jobs` table on every path, local and AWS.

## Monorepo

npm workspaces (`apps/*`, `packages/*`):

| Path | Package | Role |
| --- | --- | --- |
| `apps/api` | `@rephoto/api` | Hono on Node, port **8787**. HTTP only. Runs migrations and the demo seed at boot. |
| `apps/worker` | `@rephoto/worker` | Polls Postgres `jobs`, `WORKER_CONCURRENCY` jobs in flight. No HTTP server. Runs migrations and the demo seed at boot. |
| `apps/web` | `@rephoto/web` | Next.js, port **3000**, Italian UI, `output: "standalone"`. Proxies `/v1/*` to the API. |
| `packages/contracts` | `@rephoto/contracts` | Zod schemas (HTTP, jobs, env), `FaceEngine` input **types**, `objectKeys`, `rekognitionCollectionId`, `DEFAULT_MATCH_THRESHOLD`. No AWS SDK. |
| `packages/db` | `@rephoto/db` | SQL migrations, `migrate`, `seedDemo`, `PostgresDatabase`, `MemoryDatabase` (tests). |
| `packages/face-engine` | `@rephoto/face-engine` | `FaceEngine` implementations (`fake`, `rekognition`) and the per-process rate limiter. The only package that imports the Rekognition SDK. |

Outside the workspaces: `infra/cdk` (reference AWS stack, own `package.json`), `scripts/loadtest` (k6).

Callers depend on `FaceEngine` from `@rephoto/face-engine` (`packages/face-engine/src/types.ts`). Swapping another engine in later means a new class in that package plus a `FACE_ENGINE` value. `@rephoto/contracts` does not declare a second engine interface.

## FaceEngine

```ts
export interface Box { left: number; top: number; width: number; height: number } // normalized 0..1

export interface IndexedFace {
  externalFaceId: string;
  bbox: Box;
  confidence: number; // 0..100
}

export interface SearchHit {
  externalFaceId: string;
  photoId: string;
  similarity: number; // 0..100
}

export interface SearchFacesInput { eventId: string; externalFaceId: string }

export interface FaceEngine {
  indexPhoto(input: { eventId: string; photoId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<IndexedFace[]>;
  search(input: { eventId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<SearchHit[]>;
  /** Faces of the event similar to an already indexed face. The input face itself is excluded. */
  searchFaces(input: SearchFacesInput): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
  deleteCollection(eventId: string): Promise<void>;
}
```

- The engine speaks Rekognition's **0–100** scale. `REKOGNITION_MIN_SIMILARITY` defaults to **90** (0–100) and is applied inside the Rekognition adapter as `FaceMatchThreshold` for both `SearchFacesByImage` and `SearchFaces`; hits below it are dropped again client-side. The fake adapter returns similarity **99** for a hit.
- The worker divides engine confidence and similarity by 100 before writing Postgres. `faces.confidence` and `gallery_items.score` are **0–1**. A gallery row is kept only when its score is `>= DEFAULT_MATCH_THRESHOLD` (**0.8**).
- Rekognition `BoundingBox` (`Left`, `Top`, `Width`, `Height`, already 0..1) maps to `{ left, top, width, height }`. Postgres stores the same box as `{ x, y, width, height }`.
- `externalFaceId` is the vendor face id (Rekognition `FaceId`, or `fake-{photoId}`). It is **not** the photo id.
- Rekognition `ExternalImageId` is the **photoId** unchanged. `SearchHit.photoId` is that value.
- `search` = `SearchFacesByImage` on selfie bytes; `searchFaces` = `SearchFacesCommand({ CollectionId, FaceId, MaxFaces, FaceMatchThreshold })` on a face already in the collection. Both use `MaxFaces = REKOGNITION_SEARCH_MAX_FACES` (default **500**, 1–4096). `IndexFaces` uses `MaxFaces = 50`, `QualityFilter = AUTO`. A missing collection or face (`ResourceNotFoundException`) makes `search`, `searchFaces`, `deleteFaces` and `deleteCollection` succeed with no hits.
- `deleteFaces` deletes by `externalFaceId` inside the event collection, chunked at 4096 ids. An empty list is a no-op.
- `deleteCollection(eventId)` deletes that event's Rekognition collection. The fake adapter deletes that event's `face_index` rows.
- A selfie is never passed to `indexPhoto`; the worker refuses to index an object under `selfies/`.
- `IndexFaces`, `SearchFacesByImage` are called with image **bytes**, which Rekognition caps at **5 MB**. `index` sends `web/{photoId}.jpg` (long edge 1600, JPEG quality 80), re-encoded smaller when that derivative exceeds 5 MB. `match` builds an EXIF-oriented JPEG under 5 MB from the selfie (long edge 2048 down to 480, quality 85 down to 55). Selfie uploads may be up to 8 MiB; the shrink is in the worker.
- Throttling (`ProvisionedThroughputExceededException`, `ThrottlingException`, `TooManyRequestsException`) is rethrown as `RekognitionThrottleError`; any other Rekognition error is rethrown with image bytes stripped from the message. `AWS_REGION` other than `eu-central-1` makes the adapter throw at construction.
- Do not persist raw embeddings. Not in Postgres, not in object storage, not in logs.

### Rate limiter

`createFaceEngine(env)` wraps the Rekognition engine in `RateLimitedFaceEngine`: two token buckets per **process**, `REKOGNITION_INDEX_TPS` (default 5) for `indexPhoto` and `REKOGNITION_SEARCH_TPS` (default 5) shared by `search` and `searchFaces`. Capacity is `max(1, ceil(tps))`, refill is continuous, waiters are FIFO. Deletes are not limited. The fake engine is not wrapped. With N worker instances the account-level rate is N times these values; the Rekognition quota is per account, so set the envs to `quota / instances`.

### Collection id (frozen function)

Rekognition collection ids must match `[a-zA-Z0-9_.\-]` and be 1–255 characters. Hyphens are legal, so UUID hyphens in `eventId` are **kept**. Strip a character only when it is outside that set. The only legal builder is `rekognitionCollectionId` in `@rephoto/contracts`:

```ts
const COLLECTION_ID_PATTERN = /^[a-zA-Z0-9_.\-]+$/;

/** Prefix defaults to env REKOGNITION_COLLECTION_PREFIX or "rephoto-". */
export function rekognitionCollectionId(eventId: string, prefix = "rephoto-"): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const safeEventId = eventId.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const id = `${safePrefix}${safeEventId}`;
  if (!COLLECTION_ID_PATTERN.test(id) || id.length > 255) {
    throw new Error(`Invalid Rekognition collection id for event ${eventId}`);
  }
  return id;
}
```

Example: event `550e8400-e29b-41d4-a716-446655440000` → collection `rephoto-550e8400-e29b-41d4-a716-446655440000`.

One collection per event. Created lazily on first `indexPhoto` (`ResourceAlreadyExistsException` is success); the engine remembers created collections per process.

### `FACE_ENGINE=fake`

No AWS calls.

- Subject key = average color quantized to 16 levels per channel. Two images with the same key in the same event are the same person. `indexPhoto` stores one row per photo in `face_index` (`external_face_id = fake-{photoId}`, `event_id`, `photo_id`, `r`, `g`, `b`) and returns one full-frame face with confidence 99. `search` returns similarity **99** for the rows with the same key and nothing otherwise. `searchFaces` looks the anchor up by id and returns the same-key rows of the same event, excluding the anchor. Tests construct `FakeFaceEngine` with an injected store; with `DATABASE_URL` the engine persists `face_index` in Postgres, otherwise in memory.
- `deleteFaces` removes those ids from the store and does not itself delete `faces` rows (the caller does).
- `deleteCollection` removes every `face_index` row for that event.

## Environment

`.env.example` only. Never commit real secrets. Parsed by `envSchema` in `packages/contracts/src/env.ts`; the API and the worker refuse to boot on an invalid value.

| Variable | Local value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://rephoto:rephoto@localhost:5432/rephoto` | Required |
| `DATABASE_POOL_MAX` | `10` | Pool size per process (`postgres` `max`). The API passes it to `createSql`; the worker uses the default 10. Keep `api × pool + worker × pool` under the RDS limit |
| `S3_ENDPOINT` | `http://localhost:9000` | Optional; omit on ECS so the task role is used |
| `S3_BUCKET` | `rephoto` | Required |
| `S3_ACCESS_KEY` | `rephoto` | Required only when `S3_ENDPOINT` is set |
| `S3_SECRET_KEY` | `rephoto-secret` | Local MinIO only; required only when `S3_ENDPOINT` is set |
| `S3_REGION` | `eu-central-1` | Literal; any other value is rejected |
| `S3_FORCE_PATH_STYLE` | `true` | Default `true` when `S3_ENDPOINT` is set, `false` on real AWS |
| `SESSION_SECRET` | long random string (min 16 chars) | Dev placeholder in `.env.example` |
| `FACE_ENGINE` | `fake` locally, `rekognition` in AWS | Exactly one of the two |
| `AWS_REGION` | `eu-central-1` | Literal, default `eu-central-1` |
| `REKOGNITION_COLLECTION_PREFIX` | `rephoto-` | |
| `REKOGNITION_SEARCH_MAX_FACES` | `500` | 1–4096. `SearchFacesByImage` and `SearchFaces` |
| `REKOGNITION_MIN_SIMILARITY` | unset (= `90`) | 0–100. Read by the Rekognition adapter directly, not by `envSchema` |
| `REKOGNITION_INDEX_TPS` | `5` | Positive number. `IndexFaces` per second **per worker process** |
| `REKOGNITION_SEARCH_TPS` | `5` | Positive number. `SearchFacesByImage` + `SearchFaces` per second **per worker process** |
| `MAIL_TRANSPORT` | `smtp` (Mailpit) | `ses` sends with SESv2 in `AWS_REGION` and does not require SMTP host or port |
| `SMTP_HOST` | `localhost` | Required when `MAIL_TRANSPORT=smtp` |
| `SMTP_PORT` | `1025` | Required when `MAIL_TRANSPORT=smtp` |
| `SMTP_FROM` | `noreply@rephoto.local` | Sender for both transports |
| `SEED_DEMO` | unset locally | `false`, or `NODE_ENV=production`, skips the demo seed |
| `WEB_ORIGIN` | `http://localhost:3000` | Base of e-mailed links; CORS allow-origin; `Origin` check on ZIP; cookie `Secure` when `https:` |
| `API_ORIGIN` | `http://localhost:8787` | |
| `TRUSTED_PROXY_HOPS` | `1` | Integer ≥ 0. How many trusted proxies append to `x-forwarded-for` before the API. See *Client IP* |
| `WORKER_CONCURRENCY` | `4` | 1–32. Jobs in flight per worker process |
| `WORKER_PUBLISH_METRICS` | `false` | `true` publishes `rephoto/QueueDepth` to CloudWatch every 30 s (needs `cloudwatch:PutMetricData`) |

Web-only (Next.js; `NEXT_PUBLIC_*` are inlined at build time):

| Variable | Local value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_EVENT_SLUG` | `demo` | Event the `/selfie` and `/gallery` pages point at |
| `NEXT_PUBLIC_MEDIA_ORIGINS` | `http://localhost:9000` | Space-separated origins that serve presigned URLs; goes into CSP `img-src` / `connect-src` |
| `NEXT_PUBLIC_WEB_ORIGIN` | `http://localhost:3000` | HSTS is sent when it is `https://` |
| `API_PROXY_TARGET` | `http://localhost:8787` | Where `/v1/*` is forwarded (`NEXT_PUBLIC_API_URL` is the fallback name) |

## Object keys

| Object | Key | Notes |
| --- | --- | --- |
| Original | `originals/{eventId}/{photoId}` | No extra extension. Stored `Content-Type` is the declared one (`image/jpeg` or `image/png`). Absent while `photos.original_status = 'pending'` (the key is reserved at the web stage, see *Two-stage upload*). |
| Thumb | `thumbs/{photoId}.jpg` | Long edge 480, JPEG quality 80, EXIF-rotated. `Cache-Control: public, max-age=86400, immutable`. Always written by the worker (`derive`), from the original or, for a pending photo, from the web derivative. |
| Web | `web/{photoId}.jpg` | Long edge 1600, JPEG quality 80, EXIF-rotated. Written by the worker (`derive`, same `Cache-Control` as the thumb) **or by the browser** at the web stage (presigned PUT bound to `Content-Length` and `image/jpeg`; no `Cache-Control` is set on that object). Not rewritten when the original arrives later. |
| Selfie | `selfies/{eventId}/{userId}/{uuid}` | Deleted by the `match` job after `search` returns. |

Derivative `kind` is `thumb` or `web` and matches those keys. The `objectKeys` helper in `@rephoto/contracts` is the only builder.

On `search` success (including zero matches), the match job deletes the selfie object before the job is marked `done`. On a thrown search, the object is kept for retry. After the final failed attempt, `applyFinalFailure` deletes the selfie anyway. The AWS bucket adds a 2-day lifecycle expiry on `selfies/` as a safety net (not applied by MinIO).

Presigned GET URLs (`thumbUrl`, `webUrl`, download) expire after **30 minutes** (`SIGNED_URL_TTL_SECONDS`) and are signed with a `signingDate` rounded down to a **10-minute** window (`SIGNED_URL_WINDOW_SECONDS`), so the same key yields the same URL inside the window and browsers can cache thumbnails. Presigned PUT and `UploadPart` URLs also expire after 30 minutes; the single PUT is bound to the declared `Content-Length` and `Content-Type`.

## Jobs

Jobs live in Postgres table `jobs`. The `JobQueue` interface (`apps/api/src/queue.ts`) is the only seam; swapping the runner must keep these payload shapes.

| `type` | `payload` | `priority` | `dedupe_key` |
| --- | --- | --- | --- |
| `derive` | `{ photoId }` | 50 | `derive:{photoId}` |
| `index` | `{ photoId }` | 60 | `index:{photoId}` |
| `attach` | `{ photoId }` | 30 | `attach:{photoId}` |
| `match` | `{ userId, eventId, selfieKey }` | 0 | none |
| `email` | `{ userId, eventId, galleryPath, kind: "ready" \| "new" }` | 10 | `email:{kind}:{userId}:{eventId}` |
| `verify` | `{ photoId }` | 70 | `verify:{photoId}` |
| `retention` | `{ eventId, actorId }` | 90 | `retention:{eventId}` |

Lower priority runs first. `JOB_PRIORITY` and `jobDedupeKey(type, payload)` are in `packages/contracts/src/jobs.ts`. Every enqueue uses `jobDedupeKey` except `match`, which has no key: a second `retention/run` for the same event while one is queued or running returns the existing job id.

Row: `id`, `type`, `payload` jsonb, `status` (`queued` \| `running` \| `done` \| `error`), `attempts`, `run_after`, `last_error`, `created_at`, `claimed_at`, `priority` smallint default 50, `dedupe_key` text null.

`enqueueJob(type, payload, { priority?, dedupeKey?, runAfter? })`: `priority` defaults to the table above. With a `dedupeKey` that already has a `queued` or `running` row (partial unique index `jobs_dedupe_active_idx`), the insert is skipped and the existing job id is returned.

Worker claim (one transaction): first, every `running` row whose `claimed_at` (or `created_at` if never claimed) is older than **10 minutes** goes back to `queued` without incrementing `attempts` and without marking the photo `error`. Then one `queued` row with `run_after <= now()` is set to `running`, `claimed_at = now()`, chosen by `priority asc, run_after asc, created_at asc` with `FOR UPDATE SKIP LOCKED` (index `jobs_claim_priority_idx`).

Outcomes, in `apps/worker/src/run.ts`:

- Payload that fails its Zod schema → `failTerminal` (`error`, `attempts = 5`, `last_error = "Payload non valido."`), log outcome `invalid`.
- Success → `done`.
- Rekognition throttle (`RekognitionThrottleError`, `ProvisionedThroughputExceededException`, `ThrottlingException`) → `requeue`: back to `queued` with `run_after = now() + 5 s`, `attempts` **not** incremented, log outcome `requeued`.
- `NonRetryableError` (`sha256 mismatch`, `unsupported image`) → `failTerminal` + `applyFinalFailure`, log outcome `error`.
- Any other error → `attempts + 1`, `last_error`; when `attempts >= 5` (`JOB_MAX_ATTEMPTS`) the row becomes `error` and `applyFinalFailure` runs (log `error`); otherwise back to `queued` with `run_after = now() + attempts × 30 s` (log `retry`).

`applyFinalFailure`: `derive` and `index` set the photo to `error` with `photos.error = last error text`; `match` deletes the selfie object; other types (`verify` included) do nothing: a photo whose `verify` keeps failing stays as it is and keeps serving its web derivative.

Pipeline:

1. Upload complete inserts `photos.status = uploaded` and enqueues `derive`. After a web stage the row has `original_status = 'pending'` and the `web` derivative row already points at the client-written object; the later original stage does not enqueue `derive` again, it enqueues `verify` (see *Two-stage upload*).
2. `derive`: sets `processing`. With `original_status = 'present'`: downloads the original, **verifies sha256 against `photos.sha256`** (mismatch → non-retryable), renders `thumb` and `web` (a decode failure → non-retryable `unsupported image`), writes both objects with the derivative `Cache-Control`, upserts `derivatives`, enqueues `index`. With `original_status = 'pending'`: reads `web/{photoId}.jpg` (missing → retryable `Web derivative missing`), renders only `thumb` from it, upserts the `thumb` derivative, leaves the web derivative untouched, no sha256 check, enqueues `index`. Either way the photo is searchable after `index`; `FaceId`s are never recomputed when the original arrives.
3. `index`: no-op when the photo is already `indexed` and has `faces`. Otherwise reads `web/{photoId}.jpg`, shrinks it under 5 MB if needed, calls `deleteFaces` on any existing `faces` external ids, calls `indexPhoto` with JPEG bytes, replaces the `faces` rows (confidence ÷ 100), sets `indexed` + `indexed_at = now()`, enqueues `attach`.
4. `attach`: for each `faces` row of the photo, calls `searchFaces`. Hits on the same photo are ignored; a hit is kept when `similarity / 100 >= 0.8`, remembering per hit external id the best (faceId of this photo, score). `findGalleriesByAnchors(eventId, hitExternalIds)` returns the galleries whose `anchor_face_ids` overlap (`&&`, GIN index). For each such gallery the best score among its anchors is upserted into `gallery_items` as `(photoId, faceId, score, source = 'attach')` with `score = greatest(existing, new)`. When the row was new and the gallery's `notified_at` is null or older than **6 hours**, enqueue `email` kind `new` (deduped) and set `notified_at = now()`. No faces, no hits, or no anchored galleries → no-op.
5. `POST .../selfie` stores the selfie object and enqueues `match`.
6. `match`: shrinks the selfie to an oriented JPEG under 5 MB, calls `search`, loads the hit faces with one `faces` query (`external_id = any(...)`, index `faces_event_external_idx`) and the hit photos, keeps a hit only when the face belongs to that photo, the photo is in the event and `indexed`, and `similarity / 100 >= 0.8`; keeps the best score per photo. Anchors = the external ids of the best **5** photos by score. `replaceGallery` upserts `galleries` (`anchor_face_ids`, `matched_at = now()`, `notified_at = now()`), deletes the old items and inserts the new ones with `source = 'match'`. Then deletes the selfie object and enqueues `email` kind `ready` (deduped).
7. `email`: subject `Le tue foto sono pronte` (`ready`) or `Ci sono nuove foto per te` (`new`); body is only `${WEB_ORIGIN}${galleryPath}`, with `galleryPath = /e/{slug}`.
8. `verify` (two-stage upload only): no-op unless the photo exists and `original_status = 'present'`. Reads the original (missing → sets `original_status = 'pending'` and `photos.error = "original missing"`, job done, no retry), compares its byte length with `photos.bytes` and its sha256 with `photos.sha256`. Match → clears `photos.error` when it was `sha256 mismatch` or `original missing`. Mismatch → deletes the original object, sets `original_status = 'pending'`, sets `photos.error = "sha256 mismatch"` (`photos.status` unchanged, the photo stays indexed and served from the web derivative), logs `{ verify: "mismatch", photoId, eventId }`. The uploader then resends the original (a new original-stage `init` is accepted again because the status is back to `pending`).
9. `retention`: cutoff = `now() - events.retention_days`. In batches of 50 photos of that event with `created_at < cutoff`: `deleteFaces` in chunks of 1000, `removeAnchors(eventId, externalIds)` (drops those ids from every `anchor_face_ids` of the event), deletes the original and derivative objects, deletes each photo row (gallery items, faces, `face_index`) and writes `audit_log` `photo.deleted` with `meta { eventId, retention: true }` and `actor_id = payload.actorId`. When the event has no photos left, calls `deleteCollection`.

Worker runtime (`apps/worker/src/index.ts`, `loop.ts`):

- Up to `WORKER_CONCURRENCY` jobs in flight; the loop claims while a slot is free, sleeps 500 ms ±25 % when the queue is empty or every slot is busy, and wakes early when a job finishes.
- `SIGINT` / `SIGTERM`: stop claiming, wait up to **60 s** for in-flight jobs, then log how many were abandoned (the 10-minute stale rule recovers them).
- Housekeeping at boot and every **10 minutes** on every instance (idempotent): delete `done` jobs older than **7 days** (`pruneJobs`); set `open` upload sessions older than **24 hours** to `aborted` and abort their S3 multipart upload when `s3_upload_id` is set.
- With `WORKER_PUBLISH_METRICS=true`: at boot and every **30 s** publish CloudWatch metric namespace `rephoto`, name `QueueDepth`, value = count of `queued` jobs, no dimensions. Publish errors are logged, never thrown.
- Logs: one JSON line per finished job `{ ts, job, type, ms, outcome, error? }` with `outcome` in `done` \| `requeued` \| `retry` \| `error` \| `invalid`; `error` is the message truncated to 500 characters. No payload, no image bytes.

Terminal job failure on `derive` or `index` sets the photo to `error` and stores the reason in `photos.error`.

## Postgres

Migrations in `packages/db/migrations`: `001_init.sql` (domain tables), `002_scale.sql` (`jobs.claimed_at`, `faces_event_external_idx`, `jobs_match_user_event_idx`), `003_v2.sql` (additive only; below), `004_two_stage.sql` (additive only: `photos.original_status`, `upload_sessions.stage` / `photo_id` / `original_content_type` / `original_bytes`, index `photos_event_original_pending_idx`). `migrate()` runs all pending files inside one transaction under `pg_advisory_xact_lock(727312)`, so several instances booting together do not race; bookkeeping table `schema_migrations` (not a domain table). `createSql`: `max = DATABASE_POOL_MAX`, `idle_timeout 20`, `connect_timeout 10`, `prepare: true`.

Photo status: `uploaded` \| `processing` \| `indexed` \| `error`.

```text
events(id uuid pk, slug unique, name, retention_days int default 90, access text default 'open' check in open|list, created_at)
users(id uuid pk, email, role text check in participant|photographer|admin, created_at, unique email+role)
magic_links(id, email, role, token_hash unique, expires_at, used_at, ip text null, created_at)
sessions(id, user_id fk, token_hash unique, expires_at)
consents(id, user_id, event_id, text_version, granted_at, withdrawn_at, ip, user_agent)
photos(id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, original_status text default 'present' check in pending|present, indexed_at null, error text null, created_at, unique event_id+sha256)
derivatives(id, photo_id, kind check in thumb|web, s3_key, unique photo_id+kind)
faces(id, photo_id, event_id, external_id, bbox jsonb, confidence real, created_at, unique photo_id+external_id)  -- NO embedding column
face_index(external_face_id pk, photo_id, event_id, r, g, b, unique event_id+photo_id)  -- fake engine only
galleries(id, user_id, event_id, anchor_face_ids text[] default '{}', matched_at null, notified_at null, unique user_id+event_id)
gallery_items(id, gallery_id, photo_id, face_id, score double precision, source text default 'match' check in match|attach, created_at, unique gallery_id+photo_id)
upload_sessions(id, event_id, photographer_id, s3_upload_id null, object_key, sha256, content_type, status check in open|completed|aborted, bytes bigint null, stage text default 'original' check in original|web, photo_id uuid null fk photos on delete set null, original_content_type text null, original_bytes bigint null, created_at)
jobs(id, type, payload jsonb, status, attempts, run_after, last_error, created_at, claimed_at, priority smallint default 50, dedupe_key text null)
audit_log(id, actor_id null, action, target, created_at, meta jsonb)
invites(id, email, event_id, token_hash unique, role, expires_at, used_at)
event_photographers(event_id, user_id, created_at, pk event_id+user_id)
event_participants(event_id, email, created_at, pk event_id+email)
```

Indexes added by `003_v2.sql`:

| Index | Definition |
| --- | --- |
| `jobs_claim_priority_idx` | `jobs (priority, run_after, created_at) where status = 'queued'` |
| `jobs_dedupe_active_idx` | unique `jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running')` |
| `jobs_done_created_idx` | `jobs (created_at) where status = 'done'` (housekeeping prune) |
| `photos_event_status_idx` | `photos (event_id, status)` |
| `upload_sessions_photographer_event_idx` | `upload_sessions (photographer_id, event_id, created_at desc)` |
| `galleries_anchor_gin_idx` | GIN on `galleries (anchor_face_ids)` |
| `galleries_event_idx` | `galleries (event_id)` |
| `gallery_items_gallery_score_idx` | `gallery_items (gallery_id, score desc, photo_id)` (keyset paging) |
| `magic_links_email_created_idx` | `magic_links (email, created_at desc)` |
| `magic_links_ip_created_idx` | `magic_links (ip, created_at desc)` |

Index added by `004_two_stage.sql`:

| Index | Definition |
| --- | --- |
| `photos_event_original_pending_idx` | `photos (event_id) where original_status = 'pending'` (`originalsPending` counts, pending lookups) |

Clarifications (column names unchanged):

- Ids are `uuid` default `gen_random_uuid()` unless a seed inserts a fixed id.
- Timestamps are `timestamptz` default `now()` where the column is a creation or grant time. `used_at`, `withdrawn_at`, `indexed_at`, `matched_at`, `notified_at` are nullable.
- `token_hash` is hex SHA-256 of the raw token. Raw tokens are never stored.
- `faces.bbox` is `{ "x", "y", "width", "height" }` numbers in 0..1. No `embedding` column, ever.
- `gallery_items.score` is the match similarity in 0..1. `source` says whether the `match` job (selfie) or the `attach` job (later upload) added the row.
- `galleries.anchor_face_ids` holds Rekognition `FaceId`s (or fake ids) of faces **in event photos** that matched the participant's selfie: identifiers, not vectors. They let `attach` find the gallery without keeping the selfie. `matched_at` is the last `match`; `notified_at` throttles the `new` e-mail.
- `upload_sessions.bytes` is the size declared at `init` and enforced at `complete` (at the web stage it is the size of the 1600 px JPEG). `photos.bytes` and `photos.sha256` are **always the original's**: the size S3 reports after a plain upload, or the `originalBytes` / `sha256` declared at the web stage, enforced at the original-stage `complete` (size) and by `verify` (size and sha256). `photos.content_type` is the original's type.
- `photos.original_status` is `present` for every v2 photo (column default) and `pending` from a web stage until the original-stage `complete`; `verify` can set it back to `pending`.
- `upload_sessions.stage` says what the session transfers; `photo_id` is set only on the original stage of a web-first photo (it links the session to the existing `photos` row; `on delete set null`). `original_content_type` / `original_bytes` are set only on a web-stage session and are copied into `photos` at `complete`.
- `photos.error` is the last worker error text for a photo in `error`.
- `magic_links.ip` is null when the client IP is `unknown`.
- `events.access = 'list'` restricts the selfie to e-mails in `event_participants`.

Seed (`npm run db:seed`, idempotent):

- Event slug `demo`, name `Demo`, `retention_days` 90, `access` `open`, id `00000000-0000-4000-8000-000000000001`.
- Admin user `admin@rephoto.local`, id `00000000-0000-4000-8000-000000000002`.
- Photographer user `photographer@rephoto.local`, id `00000000-0000-4000-8000-000000000003`.
- Invite for that photographer e-mail + demo event, role `photographer`, `used_at` set (already accepted), id `00000000-0000-4000-8000-000000000004`.
- `event_photographers (demo event, seeded photographer)`.

API and worker boot call `seedDemo()`. That insert is skipped when `NODE_ENV=production` or `SEED_DEMO=false`. Local compose does not set either, so the seed still runs. `npm run db:seed` uses the same guard.

## HTTP

Base: `API_ORIGIN`. JSON unless noted. Cookie session:

- name `rephoto_session`
- `httpOnly`
- `SameSite=Lax`
- `Path=/`
- `Secure` when `WEB_ORIGIN` is `https:`
- `Max-Age` 30 days (session TTL)

Cookie value is the raw session token. `sessions.token_hash` stores its SHA-256 hex. Logout deletes the session row and clears the cookie.

CORS: when `Origin` equals `WEB_ORIGIN` the API answers with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`, `Vary: Origin`; `OPTIONS` returns `204` with methods `GET,POST,PATCH,DELETE,OPTIONS` and header `Content-Type`. The browser normally talks to the Next.js `/v1/*` proxy (same origin), which streams bodies both ways and forwards headers, `x-forwarded-for` included, unchanged.

Security headers on every API response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=15552000` when `WEB_ORIGIN` is `https:`. The web adds a CSP (`default-src 'self'; img-src 'self' blob: data: ${NEXT_PUBLIC_MEDIA_ORIGINS}; connect-src 'self' ${NEXT_PUBLIC_MEDIA_ORIGINS}; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`), `Permissions-Policy: camera=(self)` and HSTS when `NEXT_PUBLIC_WEB_ORIGIN` is `https://`.

Error body: `{ "error": string }` (Italian text from `apps/api/src/errors.ts`) with `400` validation, `401` unauthenticated, `403` forbidden / not on list / consent missing, `404` missing, `409` conflict (duplicate `(event_id, sha256)`, session not `open`), `429` rate limit, `500` `Errore interno.`, `503` on health only. The two-stage upload adds no new code: `409` also covers an original-stage `init` for a photo whose original is already present, and `400` an original-stage `init` whose `sha256` / `bytes` differ from the stored ones.

| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/request-link` | `{ email, role }` | `202` `{ status: "sent" }` |
| `POST` | `/v1/auth/verify` | `{ token }` | `200` `{ user: { id, email, role } }` + `Set-Cookie` |
| `POST` | `/v1/auth/accept-invite` | `{ token }` | `200` `{ user: { id, email, role } }` + `Set-Cookie` |
| `POST` | `/v1/auth/logout` | | `204` empty |
| `GET` | `/v1/events/:slug` | | `200` `{ id, slug, name, retentionDays, access }` |
| `POST` | `/v1/events/:slug/consent` | `{ textVersion, accepted: true }` | `201` `{ id, grantedAt }` |
| `POST` | `/v1/events/:slug/selfie` | multipart field `selfie`, `image/jpeg` or `image/png`, ≤ 8 MiB | `202` `{ status: "queued" }` |
| `GET` | `/v1/events/:slug/gallery` | `?cursor=&limit=` (default 60, max 200) | `200` `{ status, total, items: [{ photoId, thumbUrl, webUrl, score, source, createdAt, originalReady }], nextCursor }` |
| `POST` | `/v1/events/:slug/gallery/download` | `{ photoIds (1..100), variant?: "original" \| "web" }` | `200` `{ urls: [{ photoId, url }] }` signed |
| `POST` | `/v1/events/:slug/gallery/zip` | form `ids=<csv>&variant=` or JSON `{ photoIds (1..500), variant? }` | `200` `application/zip` stream |
| `POST` | `/v1/uploads/init` | `{ eventId, filename, contentType, sha256, bytes, stage?: "original", photoId? }` or `{ eventId, filename, contentType: "image/jpeg", sha256, bytes, stage: "web", originalContentType, originalBytes }` (union on `stage`) | `201` `{ id, objectKey, mode, url?, partSize? }` |
| `POST` | `/v1/uploads/:id/parts` | `{ partNumber }` | `200` `{ url, partNumber }` |
| `POST` | `/v1/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }` | `201` `{ photoId, status: "uploaded" \| "original_received" }` |
| `GET` | `/v1/uploads/lookup` | `?eventId=&sha256=` | `200` `{ photoId, originalStatus, status }` or `404` |
| `GET` | `/v1/uploads` | `?eventId=&cursor=&limit=` (default 50, max 200) | `200` `{ uploads: [{ id, objectKey, sha256, contentType, status, createdAt }], nextCursor }` |
| `GET` | `/v1/uploads/summary` | `?eventId=` | `200` `{ sessions: { open, completed, aborted }, photos: { uploaded, processing, indexed, error, originalsPending } }` |
| `GET` | `/health` | | `200` `{ ok: true }` or `503` `{ ok: false }`. ALB / container health check |
| `GET` | `/v1/health` | | Same, for the web `/v1` proxy |
| `GET` | `/v1/admin/metrics` | | `200` `{ events, photos, faces, users, jobsQueued, jobsRunning, jobsError, photosByStatus: { uploaded, processing, indexed, error }, galleries, originalsPending }` |
| `POST` | `/v1/admin/photographers/invite` | `{ email, eventId }` | `201` `{ inviteId }` |
| `POST` | `/v1/admin/participants/import` | `{ eventId, emails: string[] (1..5000) }` | `200` `{ inserted }` |
| `PATCH` | `/v1/admin/events/:id` | `{ access?: "open" \| "list", retentionDays?: int > 0 }` | `200` event (as `GET /v1/events/:slug`) |
| `DELETE` | `/v1/admin/photos/:id` | | `204` |
| `DELETE` | `/v1/admin/participants/:id` | | `204` |
| `POST` | `/v1/admin/retention/run` | `{ eventId }` | `202` `{ jobId }` |

`role` is `participant` \| `photographer` \| `admin`. All bodies are `.strict()`: unknown keys are `400`.

Auth rules:

- `request-link`: e-mail is lower-cased. Rate limit, checked before anything else and counted on `magic_links` rows: **3 per e-mail per hour** and **20 per IP per hour** → `429`. Otherwise always `202` `{ status: "sent" }` (no account enumeration). Mail is sent only when the role is allowed: `participant` always; `photographer` or `admin` only when that `(email, role)` user already exists. The link is `${WEB_ORIGIN}/verifica?token=…` (the web redirects `/verifica` → `/verify`), subject `Accedi a RePhoto`, valid **20 minutes**, single use. `magic_links.ip` is stored.
- `verify`: consumes an unused, unexpired link; creates a `participant` user on first use; for `photographer` or `admin` a missing user is the same generic `400`. Starts a **30-day** session. The web page renders a button and POSTs only on click, so mail scanners do not consume the token.
- `accept-invite`: consumes an unused, unexpired `invites` row (**7-day** TTL), creates the user for the invite's role if missing, inserts `event_photographers` when the role is `photographer`, starts a session. Invalid → generic `400`.
- Participant: only the gallery, consent, selfie, download and zip for the signed-in user. Photographer: only upload routes, and only their own `upload_sessions` (`404` otherwise). Admin: the `/v1/admin/*` routes. A wrong role is `403`.
- `consent`: participant only. `textVersion` must equal `CONSENT_TEXT_VERSION` (`packages/contracts/src/http.ts`, currently `2026-10-06`), otherwise `400`. Stores `ip` (see *Client IP*) and `user-agent`. No route withdraws a consent.
- `selfie`, checks in this order: event `access = 'list'` and the user's e-mail not in `event_participants` → `403`; no consent row for this user and event with `withdrawn_at` null → `403`; **5 selfies per user per hour** (counted on `match` jobs with that `userId`) → `429`; then the image is validated (field `selfie`, `image/jpeg` or `image/png`, 1 byte to 8 MiB) → `400`. Stores `selfies/{eventId}/{userId}/{uuid}` and enqueues `match`.
- Gallery `status` is `queued` when the latest `match` job for this user+event is `queued` or `running` (index `jobs_match_user_event_idx`); `ready` when a gallery row exists or the latest job is `done` or `error`; `empty` otherwise. `items` come from one keyset query over `gallery_items` joined to both derivatives (`score desc, photo_id asc`); a photo missing a derivative is skipped and not counted in `total`. `nextCursor` is set when the page is full, else `null`. The cursor is opaque base64url of `score|photoId` (`encodeGalleryCursor` in `@rephoto/contracts`); a malformed cursor is `400`.
- `download`: `variant` defaults to `original`; `web` signs `web/{photoId}.jpg`. `original` signs `originals/{eventId}/{photoId}` when `original_status = 'present'` and **falls back to `web/{photoId}.jpg` while it is `pending`** (`variantKey`); the response does not say which one was signed, the gallery item's `originalReady` does. Ownership is one query (`listOwnedPhotos`); any id not in the caller's gallery for that event → `403` for the whole request. URLs expire in 30 minutes.
- `zip`: when an `Origin` header is present it must equal `WEB_ORIGIN` (else `403`). Accepts `application/json` `{ photoIds, variant }`, or `application/x-www-form-urlencoded` / `multipart/form-data` with `ids` = comma-separated uuids and optional `variant`; other content types are `400`. 1..500 distinct ids, all owned (else `403`). Streams `application/zip`, `Content-Disposition: attachment; filename="rephoto-{slug}.zip"`, `Cache-Control: no-store`, store mode (no compression), entries `{slug}-{index:04}.jpg` (`.png` when `variant = original`, the photo is PNG **and** its original is present), in request order. With `variant = original` a photo whose original is still `pending` contributes its web derivative (same `variantKey` fallback as `download`), always as `.jpg`. Objects are streamed from S3 one at a time, never buffered whole. A missing object is skipped (count logged); a client abort aborts the archive. Nothing is written to `audit_log`.
- `uploads/init`: photographer only; the event must exist (`404`) and the caller must be in `event_photographers` (`403`). Without `stage` (or `stage: "original"` without `photoId`) this is the v2 path: `bytes` 1..62,914,560 (60 MiB) → `400` above. Duplicate `(event_id, sha256)` → `409`. When `bytes <= 8,388,608` (8 MiB) `mode` is `single` and `url` is a presigned PUT bound to `Content-Length = bytes` and `Content-Type`. Otherwise `mode` is `multipart`, `partSize` is 8,388,608 and `url` is omitted. `objectKey` is `originals/{eventId}/{photoId}` with a photo id reserved at init. The session stores `bytes`, `stage = 'original'`, `photo_id = null`. The other two bodies are described under *Two-stage upload*.
- `uploads/:id/parts`: only for a multipart session (`400` otherwise).
- `uploads/:id/complete`: the session must be `open` (`409`). Multipart requires a non-empty `parts` list and completes the S3 upload; single PUT requires `parts: []`. The API then `HEAD`s the object: missing or empty → `400`; size different from the declared `bytes` → session `aborted`, object deleted, `400` (`sizeMismatch`). A duplicate `(event_id, sha256)` at insert → session `aborted`, `409`. Otherwise `photos` row (`uploaded`, `original_status = 'present'`, `bytes` from S3), `derive` enqueued, session `completed`, `{ photoId, status: "uploaded" }`. Web-stage and original-stage sessions of a web-first photo differ as described under *Two-stage upload*.
- `uploads/lookup`: photographer only; `404` unless a photo with that `(eventId, sha256)` exists **and** belongs to the caller (`findOwnPhotoBySha`). Returns `photoId`, `originalStatus` and the photo `status`. It is how the browser resumes the original stage after losing its IndexedDB cache, and how it resolves a `409` at `init`.
- `uploads`: newest first (`created_at desc, id desc`); cursor is base64url of `createdAt|id`; `nextCursor` null on the last page. Web-stage sessions are listed like any other (their `objectKey` starts with `web/`); the list does not expose `stage`. `uploads/summary`: counts for the caller's own sessions and photos in that event; `photos.originalsPending` is the number of the caller's photos in that event with `original_status = 'pending'` (index `photos_event_original_pending_idx`). `admin/metrics.originalsPending` is the same count over every event and photographer.
- `contentType` for uploads is `image/jpeg` or `image/png`.
- `photographers/invite`: inserts an unused `invites` row (role `photographer`, 7 days); if a `photographer` user with that e-mail already exists, inserts `event_photographers` immediately; sends `Invito a caricare foto: {event.name}` with the link `${WEB_ORIGIN}/invito?token=…`.
- `participants/import`: e-mails are trimmed and lower-cased by the schema, de-duplicated, upserted into `event_participants`; `inserted` counts the new rows.
- `admin/events/:id`: `PATCH` with an empty object is a valid no-op; `404` when the event does not exist.
- `DELETE /v1/admin/photos/:id`: `deleteFaces` with the stored `external_id`s, deletes the original and derivative objects, the photo row (with gallery items, faces, `face_index`). Writes `audit_log` `photo.deleted` with `meta { eventId }`.
- `DELETE /v1/admin/participants/:id`: only a `participant` user (`404` otherwise). Deletes gallery items, galleries, consents, sessions, magic links of that e-mail+role, and the user. Photos and `event_participants` rows stay. Writes `audit_log` `participant.deleted`.
- `retention/run`: enqueues a `retention` job and returns `202` `{ jobId }`; the HTTP request walks nothing. See the job description.
- `/health`, `/v1/health`: `select 1` with a **2 s** timeout; `503` `{ ok: false }` on failure. No Rekognition or S3 call.

### Two-stage upload

Optional per-batch flow chosen by the uploader ("Prima il web, poi gli originali"): the browser sends a 1600 px JPEG first so the photo is indexed within seconds, and the original later. Everything else (derivatives, indexing, galleries, downloads) keeps working on the same rows and keys.

`POST /v1/uploads/init` is a union discriminated on `stage` (a body without `stage` is the original stage):

```ts
// original stage, fresh photo (v2 behaviour)
{ eventId, filename, contentType, sha256, bytes, stage?: "original" }
// original stage of a web-first photo
{ eventId, filename, contentType, sha256, bytes, stage: "original", photoId }
// web stage
{ eventId, filename, contentType: "image/jpeg", sha256, bytes, stage: "web",
  originalContentType: "image/jpeg" | "image/png", originalBytes }
```

- Web stage: `contentType` / `bytes` describe the JPEG being sent now; `sha256`, `originalContentType`, `originalBytes` describe the original that follows (`originalBytes` ≤ 60 MiB). `bytes` is at most **8 MiB** (`WEB_STAGE_MAX_BYTES`, `400` above), so `mode` is always `single`; `objectKey` is `web/{photoId}.jpg` with the photo id reserved at init; `url` is a presigned PUT bound to `Content-Length = bytes` and `image/jpeg`. Duplicate `(event_id, sha256)` → `409` whatever the existing photo's `original_status`. The session stores `stage = 'web'`, `bytes`, `original_content_type`, `original_bytes`.
- Original stage with `photoId`: the photo must exist, belong to the caller and be in `eventId` (`404` otherwise); `original_status` must be `pending` (`409` when the original is already present: the client treats it as sent); `sha256` and `bytes` must equal `photos.sha256` / `photos.bytes` (`400` otherwise). `objectKey = photos.original_key`; single / multipart by size as in v2. The session stores `stage = 'original'`, `photo_id`.
- `POST /v1/uploads/:id/complete`, web-stage session: `HEAD` size must equal the session `bytes` (else `aborted`, object deleted, `400`); a session without `original_content_type` / `original_bytes` is `400` the same way. Inserts `photos` `{ id = photoId from the key, eventId, photographerId, sha256, originalKey: originals/{eventId}/{photoId}, contentType: originalContentType, bytes: originalBytes, status: uploaded, originalStatus: pending }`; duplicate `(event_id, sha256)` → `aborted`, object deleted, `409` (a concurrent `complete` of the same session returns `201` instead). Upserts derivative `web` = the session `objectKey`, enqueues `derive` (deduped), marks the session `completed`, answers `201 { photoId, status: "uploaded" }`.
- `POST /v1/uploads/:id/complete`, original-stage session with `photo_id`: the photo must still exist and belong to the caller (else `aborted`, object deleted, `404`); `HEAD` size must equal `photos.bytes` (else `aborted`, object deleted, `400`). If the photo is no longer `pending` (a concurrent session already completed), the session is marked `completed` and the same `201` is answered without enqueuing anything. Otherwise sets `original_status = 'present'`, enqueues `verify` (deduped), marks the session `completed`, answers `201 { photoId, status: "original_received" }`. **No `derive`, no `index`** — the thumb, the web derivative, the `faces` rows and the Rekognition `FaceId`s stay as they are — with one exception: when `photos.status = 'error'` (the client-made web object could not be decoded), `photos.error` is cleared and `derive` is enqueued so the present path rebuilds thumb and web from the original and indexes.
- Until the original is present: `GET .../gallery` items carry `originalReady: false` (the web shows them as «solo web»); `download` and `zip` with `variant = original` serve the web derivative for those photos (see the two bullets above); `uploads/summary` and `admin/metrics` count them in `originalsPending`. `DELETE /v1/admin/photos/:id` and `retention` are unchanged (deleting a missing original key is a no-op).
- Worker side: `derive` on a pending photo builds only the thumb from the client-written web derivative; `verify` checks the original once it arrives (section *Jobs*). A photo can therefore be `indexed` with `original_status = 'pending'` and `photos.error = "sha256 mismatch"` at the same time: searchable, served as web, waiting for a correct original.

### Web uploader

Behaviour of `/upload` (`apps/web/lib/upload-queue.ts`, `folder-watch.ts`, `upload-store.ts`, `image-resize.ts`, `upload.ts`) that the server contract above relies on. Nothing here is enforced by the API; it describes what a well-behaved client does.

- **Modes**: `original` (v2: one task per file, `init` → PUT → `complete`) and `web-first` (two tasks per file: `web` = render + web stage, `original` = original stage with `photoId`). The toggle «Prima il web, poi gli originali» defaults to on when the browser can render (`OffscreenCanvas` + `createImageBitmap` + `Worker`) and is remembered in `localStorage` (`rephoto.upload.mode`); without that support the queue silently runs in `original` mode. A file the browser cannot decode (`UnsupportedImageError`) is sent as a plain original instead.
- **Render**: `renderWebJpeg(file)` in a Worker pool (`navigator.hardwareConcurrency - 1`, max 4): EXIF-oriented decode, long edge 1600 (never upscaled), JPEG quality 0.8. The sha256 sent at the web stage is the **original's** (`sha256Hex`, streamed in 4 MiB slices); `bytes` is the rendered blob's size, `originalBytes` the file's.
- **Web-first scheduling**: web tasks always run before original tasks; an original starts only when no web task is waiting; a new web task (drop or folder scan) pre-empts further originals while running ones finish. Each web-stage success pushes the same file onto the originals queue.
- **Adaptive concurrency**: slots start at **2**; every **5 s** the queue compares the 5-second throughput with the last step: no error and growth ≥ 10 % → +1 (max **6**, only while there is demand); any network error or XHR timeout (120 s per PUT / part) → −1 (min **1**) with a **10 s** cool-down. HTTP ≥ 500 counts as an error for the step without lowering concurrency. Progress snapshots reach the UI at most 10 times per second.
- **Pause / resume / stop**: pausing aborts in-flight XHRs and puts those files back at the front of their stage queue; stop aborts the transfers in flight and the scan timer (the folder stays chosen until «Rimuovi cartella»). `beforeunload` warns while a transfer is active; a Wake Lock (`screen`) is held while running and re-acquired on `visibilitychange`.
- **Fingerprint cache** (IndexedDB `rephoto`, store `rephoto-uploads`, key `name|size|lastModified`): records `{ sha256, status: hashed | web-sent | sent | deduped | error, photoId?, originalStatus?, updatedAt }`. On add: `sent` / `deduped` → skipped without hashing; `web-sent` with `photoId` → straight to the originals queue; `hashed` / `error` / incomplete → hash reused, then `GET /v1/uploads/lookup` decides (present → skipped, pending → originals queue, unknown → normal flow). Every status change is written back. IndexedDB missing or full degrades to no cache, never to an error.
- **Resume via lookup**: a `409` at web-stage `init` or at a fresh original `init` is resolved with `lookup`: `present` → done (`deduped`), `pending` → only the original is due. A `409` at original-stage `init` with `photoId` means the original is already there → `sent`. Nothing is uploaded twice; the server's `(event_id, sha256)` uniqueness is the source of truth.
- **Watched folder** (Chrome / Edge, `window.showDirectoryPicker`, read permission): the `FileSystemDirectoryHandle` is stored in IndexedDB store `rephoto-folders` (`{ eventId, handle, name, addedAt }`), one folder per event. While running the folder is listed recursively every **10 s** (`SCAN_INTERVAL_MS`): jpeg / png by extension, dotfiles and dot-directories skipped, files modified less than **3 s** ago skipped (still being written), depth ≤ 12, at most 50,000 files per scan. New fingerprints enter the queue; removed files are ignored; a file that failed is retried by a later scan after 60 s (a re-drop retries at once). After a browser restart the stored handle needs a click («Riprendi») to re-request permission; a `NotAllowedError` during a scan stops the queue and asks for that click.
- **PWA**: `app/manifest.ts` (`RePhoto Upload`, `display: standalone`, `start_url: /upload`, icons `public/icon-192.png` / `icon-512.png`) and `public/sw.js` registered from `/upload` only with scope `/upload`. The service worker caches nothing and intercepts no fetch: it exists for installability. «Installa come app» appears when the browser fires `beforeinstallprompt`.
- **Summary**: the page polls `GET /v1/uploads/summary` every 10 s and shows `originalsPending`; the gallery shows «solo web» on items with `originalReady: false` and warns, before an «Originali» ZIP, how many selected photos will come as web version.

Client IP (`TRUSTED_PROXY_HOPS`): with `x-forwarded-for: a, b, c` and hops 1 the client is `c` (the entry appended by the first trusted proxy); hops 2 → `b`. When the header has fewer entries than hops the first entry is used. With hops 0 or no header → the socket address, else `"unknown"`. The Next.js proxy forwards the header unchanged; the CDK stack sets 2 (CloudFront appends the client, the ALB appends the edge).

Web routes (`apps/web/app`): `/` (participant e-mail form), `/verify` (and `/verifica` redirect), `/invito`, `/selfie`, `/gallery` (event from `NEXT_PUBLIC_EVENT_SLUG`), `/e/[slug]`, `/eventi/[slug]/galleria` (redirect to `/e/[slug]`), `/upload`, `/admin`, `/v1/[...path]` (API proxy), `/api/s3-put` (dev-only PUT proxy to `localhost:9000`; `404` in production), `/manifest.webmanifest` (from `app/manifest.ts`) and the static `/sw.js`. After verify the web lands on `/selfie`, `/upload` or `/admin` by role.

Signed URL helpers and the Rekognition client stay out of `packages/contracts`.

## Changes from v1

- `FaceEngine.searchFaces` (Rekognition `SearchFaces` by `FaceId`); `RateLimitedFaceEngine` with `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` per process.
- New env: `DATABASE_POOL_MAX`, `WORKER_CONCURRENCY`, `REKOGNITION_INDEX_TPS`, `REKOGNITION_SEARCH_TPS`, `TRUSTED_PROXY_HOPS`, `WORKER_PUBLISH_METRICS`; web `NEXT_PUBLIC_EVENT_SLUG`, `NEXT_PUBLIC_MEDIA_ORIGINS`, `NEXT_PUBLIC_WEB_ORIGIN`, `API_PROXY_TARGET`.
- Signed URL TTL 15 → **30 minutes**, signed in 10-minute windows; derivatives carry `Cache-Control: public, max-age=86400, immutable`.
- Jobs: new type `attach`; `priority` and `dedupe_key` columns, priority claim order, dedupe on enqueue; `email.kind` (`ready` \| `new`); non-retryable errors fail on the first attempt; `derive` verifies sha256; `photos.indexed_at` / `photos.error`; worker concurrency, graceful shutdown, housekeeping (prune done jobs 7 d, abort open uploads 24 h), `QueueDepth` metric, JSON job log.
- Galleries: `anchor_face_ids` (top 5 FaceIds from the selfie match), `matched_at`, `notified_at`; `gallery_items.source` / `created_at`; retention removes anchors of deleted faces.
- Schema `003_v2.sql`: the above plus `events.access`, `event_photographers`, `event_participants`, `upload_sessions.bytes`, `magic_links.ip` / `created_at`, and the indexes listed. `migrate()` under an advisory lock.
- HTTP: `POST /v1/auth/accept-invite`, `POST /v1/admin/participants/import`, `PATCH /v1/admin/events/:id`, `POST /v1/events/:slug/gallery/zip`, `GET /v1/uploads/summary`; gallery paging (`cursor`, `limit`, `total`, `nextCursor`, `source`, `createdAt`); `download.variant` and a 100-id cap; `GET /v1/events/:slug` returns `access`; selfie `403` for `access = 'list'`; magic-link rate limits (3/e-mail/h, 20/IP/h); upload max 60 MiB (was 30 in the DPIA draft, 8 MiB single-PUT threshold unchanged), `event_photographers` check at init, size check at complete; `GET /v1/uploads` paging; extended `admin/metrics`; health runs `select 1` with a 2 s timeout and can return `503`; invites are e-mailed and expire in 7 days; `TRUSTED_PROXY_HOPS` client IP rule; magic-link TTL 20 minutes; session 30 days.
- Web: `/verify` consumes the token on click; `/invito`; paged gallery with ZIP; uploader with streamed hashing, local dedupe and resume; admin access toggle and participant import; CSP and other headers; standalone Docker build.
- Infra: Dockerfiles for api, worker, web; compose `app` profile; `infra/cdk` reference stack (`docs/infra.md`); k6 scripts (`scripts/loadtest`).

## Changes from v2

- Two-stage upload (`docs/v3-uploader-spec.md`): `POST /v1/uploads/init` is a union on `stage` (`web` body with `originalContentType` / `originalBytes`, 8 MiB cap `WEB_STAGE_MAX_BYTES`, always single PUT to `web/{photoId}.jpg`; `original` body with optional `photoId`); `complete` answers `status: "uploaded" | "original_received"`; new `GET /v1/uploads/lookup`; `uploads/summary.photos.originalsPending` and `admin/metrics.originalsPending`; gallery items carry `originalReady`; `download` / `zip` with `variant = original` fall back to the web derivative while the original is pending (ZIP entry extension follows the object served). Known deviation from the spec: original-stage `init` on an already present original is `409`, not `400`.
- Schema `004_two_stage.sql` (additive): `photos.original_status` (`pending` | `present`, default `present`), `upload_sessions.stage` / `photo_id` / `original_content_type` / `original_bytes`, index `photos_event_original_pending_idx`. `photos.sha256` / `bytes` / `content_type` always describe the original.
- Jobs: new type `verify` (priority 70, `verify:{photoId}`): one read of the original, size + sha256 check, mismatch → original deleted, `original_status` back to `pending`, `photos.error = "sha256 mismatch"`, photo status unchanged. `derive` on a pending photo renders only the thumb from the client-written web derivative; the original stage never re-derives or re-indexes.
- Object keys: `web/{photoId}.jpg` may be written by the browser (no `Cache-Control` on that object); `originals/{eventId}/{photoId}` may not exist yet for a photo row.
- Web: continuous uploader on `/upload`: watched folder (Chrome / Edge, File System Access, scan every 10 s, handle persisted in IndexedDB), «Prima il web, poi gli originali» toggle, web-first scheduling, adaptive concurrency 1–6, pause / resume / stop, fingerprint cache with `web-sent` state and resume through `lookup`, Wake Lock, `beforeunload` guard, PWA manifest + no-op service worker, «solo web» tag in the gallery and viewer. See *Web uploader*.
