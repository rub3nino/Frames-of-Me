# RePhoto contracts

Frozen MVP contract. Clarify wording only by editing this file in a follow-up; do not rename fields, routes, env vars, table columns, or job payload keys.

Region assumption: `eu-central-1`. No Qdrant. No GPU. No SQS in the local/MVP code path.

## Monorepo

npm workspaces (`apps/*`, `packages/*`):

| Path | Package | Role |
| --- | --- | --- |
| `apps/api` | `@rephoto/api` | Hono on Node, port **8787**. HTTP only. |
| `apps/worker` | `@rephoto/worker` | Polls Postgres `jobs`. No HTTP server. |
| `apps/web` | `@rephoto/web` | Next.js, port **3000**, Italian UI. |
| `packages/contracts` | `@rephoto/contracts` | Zod schemas + `FaceEngine` **types** and `rekognitionCollectionId`. No AWS SDK. |
| `packages/db` | `@rephoto/db` | SQL migrations, `migrate`, `seed`. |
| `packages/face-engine` | `@rephoto/face-engine` | `FaceEngine` implementations (`fake`, `rekognition`). No caller imports the AWS SDK except this package. |

Callers depend on `FaceEngine` from `@rephoto/face-engine` (`packages/face-engine/src/types.ts`). Swapping InsightFace in later means a new class in that package plus `FACE_ENGINE`. Callers stay unchanged. `@rephoto/contracts` does not declare a second engine interface.

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

export interface FaceEngine {
  indexPhoto(input: { eventId: string; photoId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<IndexedFace[]>;
  search(input: { eventId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
  deleteCollection(eventId: string): Promise<void>;
}
```

- The engine speaks Rekognition's **0–100** scale. `REKOGNITION_MIN_SIMILARITY` defaults to **90** and is applied inside the Rekognition adapter as `FaceMatchThreshold`. The fake adapter returns similarity **99** for a hit.
- The worker divides engine confidence and similarity by 100 before writing Postgres. `faces.confidence` and `gallery_items.score` are **0–1**. A stored score is kept only when it is `>= DEFAULT_MATCH_THRESHOLD` (**0.8**).
- Rekognition `BoundingBox` (`Left`, `Top`, `Width`, `Height`, already 0..1) maps to `{ left, top, width, height }`. Postgres stores the same box as `{ x, y, width, height }`.
- `externalFaceId` is the vendor face id (Rekognition `FaceId`, or the fake id). It is **not** the photo id.
- Rekognition `ExternalImageId` is the **photoId** unchanged. `SearchHit.photoId` is that value.
- `deleteFaces` deletes by `externalFaceId` inside the event collection. An empty list is a no-op. Rekognition calls are chunked at 4096 ids.
- `deleteCollection(eventId)` deletes that event's Rekognition collection. A missing collection is success. The fake adapter deletes that event's `face_index` rows.
- A selfie is never passed to `indexPhoto`.
- `IndexFaces` and `SearchFacesByImage` are called with image **bytes**. Bytes over **5 MB** are rejected (15 MB applies only to `S3Object`, which this path does not use). `index` sends `web/{photoId}.jpg` (long edge 1600, JPEG quality 80), not the original. The original stays in the bucket for download. `match` builds an EXIF-oriented JPEG under 5 MB from the selfie and passes those bytes to `search`. Selfie uploads may still be up to 8 MB; the shrink is in the worker.
- Before a new `indexPhoto`, if the photo already has `faces` rows and is not yet `indexed`, the worker calls `deleteFaces` on those external ids and then replaces the rows. A job retry of a photo that is already `indexed` with faces does not call `indexPhoto` again.
- Rekognition `SearchFacesByImage` `MaxFaces` is `REKOGNITION_SEARCH_MAX_FACES` (default **500**, allowed 1–4096). `IndexFaces` `MaxFaces` stays **50**.
- Do not persist raw embeddings. Not in Postgres, not in object storage, not in logs.

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

One collection per event. Create it lazily on first `indexPhoto`.

### `FACE_ENGINE=fake`

No AWS calls.

- Subject key = average color quantized to 16 levels per channel. Two images with the same key in the same event are the same person. `indexPhoto` stores that key in `face_index` (`external_face_id`, `event_id`, `photo_id`, `r`, `g`, `b`). `search` returns similarity **99** for those rows and nothing otherwise. Tests construct `FakeFaceEngine` with an injected store; with `DATABASE_URL` the engine can persist `face_index`.
- `deleteFaces` removes those ids from the store and does not itself delete `faces` rows (the caller does).
- `deleteCollection` removes every `face_index` row for that event.

## Environment

`.env.example` only. Never commit real secrets.

| Variable | Local value |
| --- | --- |
| `DATABASE_URL` | `postgres://rephoto:rephoto@localhost:5432/rephoto` |
| `S3_ENDPOINT` | `http://localhost:9000` (optional; omit on ECS so the task role is used) |
| `S3_BUCKET` | `rephoto` |
| `S3_ACCESS_KEY` | `rephoto` (required only when `S3_ENDPOINT` is set) |
| `S3_SECRET_KEY` | `rephoto-secret` (local MinIO only; required only when `S3_ENDPOINT` is set) |
| `S3_REGION` | `eu-central-1` |
| `S3_FORCE_PATH_STYLE` | `true` with MinIO. Default is `true` when `S3_ENDPOINT` is set, `false` on real AWS |
| `SESSION_SECRET` | long random string; dev placeholder in `.env.example` |
| `FACE_ENGINE` | `fake` locally, `rekognition` in AWS |
| `AWS_REGION` | `eu-central-1` |
| `REKOGNITION_COLLECTION_PREFIX` | `rephoto-` |
| `REKOGNITION_SEARCH_MAX_FACES` | `500` (1–4096). `SearchFacesByImage` only |
| `MAIL_TRANSPORT` | `smtp` locally (Mailpit). `ses` sends with SESv2 in `AWS_REGION` and does not require SMTP host or port |
| `SMTP_HOST` | `localhost` (required when `MAIL_TRANSPORT=smtp`) |
| `SMTP_PORT` | `1025` (required when `MAIL_TRANSPORT=smtp`) |
| `SMTP_FROM` | `noreply@rephoto.local` |
| `SEED_DEMO` | unset locally. `false`, or `NODE_ENV=production`, skips the demo seed |
| `WEB_ORIGIN` | `http://localhost:3000` |
| `API_ORIGIN` | `http://localhost:8787` |

`FACE_ENGINE` is exactly `fake` or `rekognition`.

## Object keys

| Object | Key | Notes |
| --- | --- | --- |
| Original | `originals/{eventId}/{photoId}` | No extra extension. |
| Thumb | `thumbs/{photoId}.jpg` | Long edge 480, JPEG. |
| Web | `web/{photoId}.jpg` | Long edge 1600, JPEG quality 80. |
| Selfie | `selfies/{eventId}/{userId}/{uuid}` | Deleted after `search` returns. |

Derivative `kind` is `thumb` or `web` and matches those keys.

On `search` success (including zero matches), the match job deletes the selfie object before it marks the job `done`. On a thrown search, keep the object for retry. After the final failed attempt, delete the selfie anyway.

## Jobs

Jobs live in Postgres table `jobs`, not SQS, on the local/MVP path. Production may swap the job runner for SQS without changing payload shapes.

Payloads:

| `type` | `payload` |
| --- | --- |
| `derive` | `{ photoId }` |
| `index` | `{ photoId }` |
| `match` | `{ userId, eventId, selfieKey }` |
| `email` | `{ userId, eventId, galleryPath }` |
| `retention` | `{ eventId, actorId }` |

Row: `id`, `type`, `payload` jsonb, `status` (`queued` \| `running` \| `done` \| `error`), `attempts`, `run_after`, `last_error`, `created_at`, `claimed_at` (set when a worker claims the row; migration `002_scale.sql`).

Worker claim: first, any `running` row whose `claimed_at` (or `created_at` if never claimed) is older than **10 minutes** goes back to `queued` without incrementing `attempts` and without marking the photo `error`. Then `UPDATE` one `queued` row whose `run_after <= now()` to `running`, set `claimed_at = now()`, using `FOR UPDATE SKIP LOCKED`. On success, `done`. On failure, increment `attempts`, set `last_error`, and either requeue (`queued`, `run_after` in the future) or set `error` when `attempts` reaches **5**. A Rekognition throttle (`ProvisionedThroughputExceededException`, `ThrottlingException`, or `RekognitionThrottleError`) is requeued with a short delay and does **not** increment `attempts`.

Pipeline:

1. Upload complete inserts `photos.status = uploaded` and enqueues `derive`.
2. `derive` writes both derivatives, sets `processing`, enqueues `index`.
3. `index` reads `web/{photoId}.jpg` and calls `indexPhoto` with those JPEG bytes. It inserts `faces` and sets `indexed`. If faces already exist and the photo is not yet `indexed`, it `deleteFaces` those external ids first. If the photo is already `indexed` and faces exist, it does nothing.
4. `POST .../selfie` stores the selfie object and enqueues `match`.
5. `match` shrinks the selfie to an oriented JPEG under 5 MB, calls `search`, keeps the best hit per photo with stored score `similarity / 100` when that score is `>= 0.8`, upserts `galleries` / `gallery_items`, deletes the selfie object, enqueues `email`. Hits are loaded with one `faces` query (`external_id = any(...)`), using index `faces_event_external_idx`.
6. `email` sends the gallery link. `galleryPath` is `/e/{slug}` on `WEB_ORIGIN`.

Terminal job failure on `derive` or `index` sets the photo to `error`.

## Postgres

`packages/db/migrations/001_init.sql`. `002_scale.sql` adds `jobs.claimed_at`, index `faces (event_id, external_id)`, and expression index `jobs_match_user_event_idx`. The migrate script may keep a `schema_migrations` bookkeeping table; that table is not a domain table.

Photo status: `uploaded` \| `processing` \| `indexed` \| `error`.

```text
events(id uuid pk, slug unique, name, retention_days int default 90, created_at)
users(id uuid pk, email, role text check in participant|photographer|admin, created_at, unique email+role)
magic_links(id, email, role, token_hash, expires_at, used_at)
sessions(id, user_id fk, token_hash, expires_at)
consents(id, user_id, event_id, text_version, granted_at, withdrawn_at, ip, user_agent)
photos(id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at, unique event_id+sha256)
derivatives(id, photo_id, kind check in thumb|web, s3_key)
faces(id, photo_id, event_id, external_id, bbox jsonb, confidence real, created_at)  -- NO embedding column
galleries(id, user_id, event_id, unique user_id+event_id)
gallery_items(id, gallery_id, photo_id, face_id, score, unique gallery_id+photo_id)
upload_sessions(id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status, created_at)
jobs as above
audit_log(id, actor_id, action, target, created_at, meta jsonb)
invites(id, email, event_id, token_hash, role, expires_at, used_at)
```

Clarifications (column names unchanged):

- Ids are `uuid` default `gen_random_uuid()` unless a seed inserts a fixed id.
- Timestamps are `timestamptz` default `now()` where the column is a creation or grant time. `used_at` and `withdrawn_at` are nullable.
- `token_hash` is hex SHA-256 of the raw token. Raw tokens are never stored.
- `faces.bbox` is `{ "x", "y", "width", "height" }` numbers in 0..1. No `embedding` column, ever.
- `gallery_items.score` is the match similarity in 0..1.
- `upload_sessions.status` is `open` \| `completed` \| `aborted`. `s3_upload_id` is null for a single PUT.
- `upload_sessions.bytes` is not a column; byte size lives on `photos.bytes` after complete. Init still receives `bytes` in the HTTP body.
- Unique `(photo_id, kind)` on `derivatives`. Unique `(photo_id, external_id)` on `faces`.

Seed (`npm run db:seed`, idempotent):

- Event slug `demo`, name `Demo`, `retention_days` 90, id `00000000-0000-4000-8000-000000000001`.
- Admin user `admin@rephoto.local`, id `00000000-0000-4000-8000-000000000002`.
- Photographer user `photographer@rephoto.local`, id `00000000-0000-4000-8000-000000000003`.
- Invite for that photographer email + demo event, role `photographer`, `used_at` set (already accepted), id `00000000-0000-4000-8000-000000000004`.

API and worker boot call `seedDemo()`. That insert is skipped when `NODE_ENV=production` or `SEED_DEMO=false`. Local compose does not set either, so the seed still runs. `npm run db:seed` uses the same guard.

## HTTP

Base: `API_ORIGIN`. JSON unless noted. Cookie session:

- name `rephoto_session`
- `httpOnly`
- `SameSite=Lax`
- `Path=/`
- `Secure` when `WEB_ORIGIN` is `https:`

Cookie value is the raw session token. `sessions.token_hash` stores its SHA-256 hex. Logout deletes the session row and clears the cookie.

Error body: `{ "error": string }` with `400` validation, `401` unauthenticated, `403` forbidden, `404` missing, `409` duplicate `(event_id, sha256)`, `429` rate limit.

| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/request-link` | `{ email, role }` | `202` `{ status: "sent" }` |
| `POST` | `/v1/auth/verify` | `{ token }` | `200` `{ user: { id, email, role } }` + `Set-Cookie` |
| `POST` | `/v1/auth/logout` | | `204` empty |
| `GET` | `/v1/events/:slug` | | `200` `{ id, slug, name, retentionDays }` |
| `POST` | `/v1/events/:slug/consent` | `{ textVersion, accepted: true }` | `201` `{ id, grantedAt }` |
| `POST` | `/v1/events/:slug/selfie` | multipart field `selfie`, `image/jpeg` or `image/png` | `202` `{ status: "queued" }` |
| `GET` | `/v1/events/:slug/gallery` | | `200` `{ status, items: [{ photoId, thumbUrl, webUrl, score }] }` |
| `POST` | `/v1/events/:slug/gallery/download` | `{ photoIds }` | `200` `{ urls: [{ photoId, url }] }` signed |
| `POST` | `/v1/uploads/init` | `{ eventId, filename, contentType, sha256, bytes }` | `201` `{ id, objectKey, mode, url?, partSize? }` |
| `POST` | `/v1/uploads/:id/parts` | `{ partNumber }` | `200` `{ url, partNumber }` |
| `POST` | `/v1/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }` | `201` `{ photoId, status: "uploaded" }` |
| `GET` | `/v1/uploads` | `?eventId=` | `200` `{ uploads: [{ id, objectKey, sha256, contentType, status, createdAt }] }` |
| `GET` | `/health` | | `200` `{ ok: true }`. No Rekognition call. ALB uses this on the API |
| `GET` | `/v1/health` | | `200` `{ ok: true }`. Same check, for the web `/v1` proxy |
| `GET` | `/v1/admin/metrics` | | `200` `{ events, photos, faces, users, jobsQueued }` counts |
| `POST` | `/v1/admin/photographers/invite` | `{ email, eventId }` | `201` `{ inviteId }` |
| `DELETE` | `/v1/admin/photos/:id` | | `204` |
| `DELETE` | `/v1/admin/participants/:id` | | `204` |
| `POST` | `/v1/admin/retention/run` | `{ eventId }` | `202` `{ jobId }` |

`role` is `participant` \| `photographer` \| `admin`.

Auth rules:

- `request-link` always returns `202` `{ status: "sent" }` (no account enumeration). Mail is sent only when the role is allowed: `participant` always; `photographer` or `admin` only when that `(email, role)` user already exists. Verify creates a `participant` user on first use. Verify for `photographer` or `admin` fails with the same generic `400` `{ error }` if that user does not exist. A photographer is created by accepting an invite (seed, or a future accept step). This MVP's accept path is the seed; `POST /v1/admin/photographers/invite` only inserts an unused `invites` row with role `photographer`.
- Magic-link and invite tokens expire. Verify rejects expired or already used links.
- Participant: only the gallery, consent, and selfie for the signed-in user.
- Photographer: only upload routes, and only their own `upload_sessions` and photos (`photographer_id`).
- Admin: metrics, photographer invites, photo delete, participant delete, retention run.
- Selfie requires a consent row for this user and event with `withdrawn_at` null. Otherwise `403`.
- Rate-limit selfie: **5 per hour per email** (the session user's email). `429` over the limit.
- Gallery `status` is `empty` (no match job and no items), `queued` (a `match` job for this user+event is `queued` or `running`), or `ready` (latest such job is `done` or `error`). That lookup is indexed by `jobs_match_user_event_idx` on `payload->>'userId'`, `payload->>'eventId'`, `created_at` where `type = 'match'`. `items` lists `gallery_items` with signed `thumbUrl` and `webUrl`. `score` is the stored similarity.
- Download signs **original** keys. Only photo ids already in the caller's gallery. URLs expire in 15 minutes.
- `uploads/init`: when `bytes` <= 8388608 (8 MiB), `mode` is `single` and `url` is a presigned PUT. Otherwise `mode` is `multipart`, `partSize` is 8388608, and `url` is omitted. `objectKey` is `originals/{eventId}/{photoId}` using a new photo id reserved at init time. Complete creates the `photos` row (`uploaded`) and enqueues `derive`. Single-PUT complete sends `parts: []`.
- `contentType` for uploads is `image/jpeg` or `image/png`.
- `DELETE /v1/admin/photos/:id` deletes the photo row, derivatives, faces, gallery items, S3 objects, and calls `deleteFaces` with the stored `external_id`s. Writes `audit_log`.
- `DELETE /v1/admin/participants/:id` deletes that `participant` user and dependent galleries, consents, sessions, magic links. Photos stay. Writes `audit_log`.
- `retention/run` enqueues a `retention` job and returns `202` `{ jobId }`. It does not walk photos inside the HTTP request. The worker deletes photos of `eventId` whose `created_at` is older than `retention_days`, in batches: `deleteFaces` in chunks, then the original and derivative objects, then the photo row (gallery links included). Same erasure as photo delete. Participant delete still does not destroy group photos. When the event has no photos left, the worker calls `deleteCollection`. Photos still inside the retention window keep their FaceIds.

Signed URL helpers and the Rekognition client stay out of `packages/contracts`.
