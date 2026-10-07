# Frames of Me v2 — implementation spec

Target: one conference, 12 photographers, ~150k JPEG over 3 days, ~6,000 participants searching by selfie, browsing their matches, picking photos and downloading them. This document is the single source of truth for the v2 changes. `CONTRACTS.md` is updated at the end of the work to match this spec; where they differ during the work, this file wins.

Language of code, comments, identifiers: English. UI strings: Italian. Error messages returned by the API: Italian (see `apps/api/src/errors.ts`).

Conventions kept from v1: npm workspaces, Hono API on 8787, Next.js on 3000, Postgres `jobs` table as the queue on the local path, `FaceEngine` abstraction, Zod contracts in `packages/contracts`, SQL in `packages/db/migrations`, tests with `node --test` + `MemoryDatabase`.

---

## 1. Schema — migration `packages/db/migrations/003_v2.sql`

Additive only. Never drop or rename a v1 column.

```sql
-- jobs: priority queue + dedupe
alter table jobs add column priority smallint not null default 50;
alter table jobs add column dedupe_key text null;
create index jobs_claim_priority_idx on jobs (priority, run_after, created_at) where status = 'queued';
create unique index jobs_dedupe_active_idx on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
create index jobs_done_created_idx on jobs (created_at) where status = 'done';

-- photos: indexing time + failure reason
alter table photos add column indexed_at timestamptz null;
alter table photos add column error text null;
create index photos_event_status_idx on photos (event_id, status);

-- upload_sessions: declared size, enforced at complete
alter table upload_sessions add column bytes bigint null;
create index upload_sessions_photographer_event_idx on upload_sessions (photographer_id, event_id, created_at desc);

-- galleries: anchors for incremental attach + notification throttle
alter table galleries add column anchor_face_ids text[] not null default '{}';
alter table galleries add column matched_at timestamptz null;
alter table galleries add column notified_at timestamptz null;
create index galleries_anchor_gin_idx on galleries using gin (anchor_face_ids);
create index galleries_event_idx on galleries (event_id);

-- gallery_items: provenance
alter table gallery_items add column source text not null default 'match' check (source in ('match', 'attach'));
alter table gallery_items add column created_at timestamptz not null default now();
create index gallery_items_gallery_score_idx on gallery_items (gallery_id, score desc, photo_id);

-- magic links: rate limiting by ip
alter table magic_links add column ip text null;
alter table magic_links add column created_at timestamptz not null default now();
create index magic_links_email_created_idx on magic_links (email, created_at desc);
create index magic_links_ip_created_idx on magic_links (ip, created_at desc);

-- events: access policy
alter table events add column access text not null default 'open' check (access in ('open', 'list'));

-- who may upload to an event
create table event_photographers (
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- participant allowlist (used when events.access = 'list')
create table event_participants (
  event_id uuid not null references events (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, email)
);
```

Seed additions (idempotent): `event_photographers (demo event, seeded photographer)`.

`jobs.priority` values (lower runs first): `match` 0, `email` 10, `attach` 30, `derive` 50, `index` 60, `retention` 90.

---

## 2. Jobs

Types: `derive`, `index`, `attach`, `match`, `email`, `retention`.

| type | payload | priority | dedupe_key |
| --- | --- | --- | --- |
| `derive` | `{ photoId }` | 50 | `derive:{photoId}` |
| `index` | `{ photoId }` | 60 | `index:{photoId}` |
| `attach` | `{ photoId }` | 30 | `attach:{photoId}` |
| `match` | `{ userId, eventId, selfieKey }` | 0 | none |
| `email` | `{ userId, eventId, galleryPath, kind: "ready" \| "new" }` | 10 | `email:{kind}:{userId}:{eventId}` |
| `retention` | `{ eventId, actorId }` | 90 | `retention:{eventId}` |

`enqueueJob(type, payload, opts?: { priority?, dedupeKey?, runAfter? })`. Priority defaults by type (table above). Enqueue with a `dedupeKey` that already has an active (`queued`/`running`) row returns the existing job id and inserts nothing.

Claim order: `priority asc, run_after asc, created_at asc`, `FOR UPDATE SKIP LOCKED`. Stale-running recovery as v1 (10 min).

Pipeline:

1. upload complete → `photos.status = uploaded` → enqueue `derive`.
2. `derive`: downloads the original, **verifies sha256 against `photos.sha256`** (mismatch → throw `ShaMismatchError`, non-retryable → photo `error` with `error = "sha256 mismatch"`), writes `thumb` (480) and `web` (1600, q80) with `Cache-Control: public, max-age=86400, immutable`, sets `processing`, enqueues `index`.
3. `index`: as v1 (`indexPhoto` on web derivative), then sets `indexed` + `indexed_at = now()`, enqueues `attach`.
4. `attach`: for each face of the photo (`faces.external_id`), calls `engine.searchFaces({ eventId, externalFaceId })`. For each hit with `similarity/100 >= DEFAULT_MATCH_THRESHOLD`, finds galleries of that event whose `anchor_face_ids` contain `hit.externalFaceId` (one query with `= any(anchor_face_ids)` / `&&`), and inserts `gallery_items (photoId, faceId = this photo's face row id, score, source = 'attach')` with `on conflict (gallery_id, photo_id) do update set score = greatest(...)`. For galleries that gained at least one item and whose `notified_at` is older than 6 hours (or null), enqueue `email` kind `new` (deduped) and set `notified_at = now()`. Attach is skipped (no-op) when the event has no galleries with anchors.
5. `POST .../selfie` stores the selfie and enqueues `match` (as v1).
6. `match`: as v1, plus: anchors = the `external_id`s of the best 5 hits (distinct photos, score desc); `replaceGallery` now writes `anchor_face_ids`, `matched_at = now()`, `notified_at = now()`, and keeps items with `source = 'match'`. Deletes selfie. Enqueues `email` kind `ready`.
7. `email`: kind `ready` → subject "Le tue foto sono pronte"; kind `new` → subject "Ci sono nuove foto per te". Body: the gallery link only.
8. `retention`: as v1, also removes the anchors that referenced deleted faces (`anchor_face_ids = array_remove(...)` for each deleted external id — or simply filter on read; implement as a single `update galleries set anchor_face_ids = (select array_agg(x) from unnest(anchor_face_ids) x where x <> all($deleted))` per batch).

Non-retryable errors: `ShaMismatchError`, `UnsupportedImageError` (sharp cannot decode) → immediate terminal failure (status `error`, `attempts = JOB_MAX_ATTEMPTS`) and `applyFinalFailure`. Rekognition throttle: requeue without attempt (v1).

Worker runtime (`apps/worker/src/index.ts`):

- `WORKER_CONCURRENCY` (default 4): up to N jobs in flight per process; claim loop fills free slots; idle sleep 500 ms with jitter.
- Graceful shutdown: stop claiming, wait for in-flight (max 60 s).
- Housekeeping every 10 minutes (any instance, idempotent): `db.pruneJobs({ doneOlderThanDays: 7 })` and `db.abortStaleUploads({ olderThanHours: 24 })` (open sessions → `aborted`; also abort the S3 multipart upload when `s3_upload_id` is set).
- Logs: one JSON line per job (`{ ts, job, type, ms, outcome }`), no payload bytes.

Face engine rate limiting (`packages/face-engine/src/limiter.ts`): `RateLimitedFaceEngine(inner, { indexTps, searchTps })` token-bucket per process. Env `REKOGNITION_INDEX_TPS` (default 5), `REKOGNITION_SEARCH_TPS` (default 5). `createFaceEngine` wraps the Rekognition engine with it; the fake engine is not wrapped. Document that the quota is per worker instance.

---

## 3. FaceEngine additions

```ts
export interface SearchFacesInput { eventId: string; externalFaceId: string }
export interface FaceEngine {
  // v1 methods unchanged
  /** Faces in the event collection similar to an already indexed face. The input face itself is excluded. */
  searchFaces(input: SearchFacesInput): Promise<SearchHit[]>;
}
```

- Rekognition: `SearchFacesCommand({ CollectionId, FaceId, MaxFaces: REKOGNITION_SEARCH_MAX_FACES, FaceMatchThreshold: minSimilarity })`. `ResourceNotFoundException` (collection or face missing) → `[]`.
- Fake: look up the row by `external_face_id`, return rows of the same event with the same `(r,g,b)` excluding itself, similarity 99.
- `REKOGNITION_MIN_SIMILARITY` default stays 90; `DEFAULT_MATCH_THRESHOLD` stays 0.8.

---

## 4. HTTP changes (`packages/contracts/src/http.ts`, `apps/api/src/routes.ts`)

Existing routes keep their shapes unless listed.

| Method | Path | Change |
| --- | --- | --- |
| `POST` | `/v1/auth/request-link` | Rate limit: max 3 links per email per hour, max 20 per IP per hour → `429`. Still always `202` otherwise. `magic_links.ip` stored. |
| `POST` | `/v1/auth/accept-invite` | New. Body `{ token }`. Consumes an unused, unexpired `invites` row, creates the `photographer` user if missing, inserts `event_photographers`, marks `used_at`, creates a session, sets cookie. `200 { user }`. Invalid → `400` generic. |
| `POST` | `/v1/admin/photographers/invite` | Now also sends the mail `"${WEB_ORIGIN}/invito?token=…"`. If the user already exists, still inserts `event_photographers` immediately (so re-inviting an existing photographer to another event works). |
| `POST` | `/v1/admin/participants/import` | New. Body `{ eventId, emails: string[] (1..5000) }`. Upserts `event_participants`. `200 { inserted }`. Admin only. |
| `PATCH` | `/v1/admin/events/:id` | New. Body `{ access?: "open"\|"list", retentionDays?: int }`. Admin only. `200` event. |
| `GET` | `/v1/events/:slug` | Adds `access`. |
| `POST` | `/v1/events/:slug/selfie` | If `event.access = 'list'` and the user's email is not in `event_participants` → `403`. |
| `GET` | `/v1/events/:slug/gallery` | Query `?cursor=&limit=` (limit default 60, max 200). Response `{ status, total, items, nextCursor: string \| null }`. Cursor is opaque base64url of `score|photoId`. **One SQL query** joins `gallery_items` + `derivatives` (both kinds) ordered by `score desc, photo_id`. Each item: `{ photoId, thumbUrl, webUrl, score, source, createdAt }`. `thumbUrl`/`webUrl` are presigned GET URLs signed with a `signingDate` rounded down to a 10-minute window and `expiresIn` 1800 s, so identical URLs are returned inside the window and the browser caches thumbnails (object `Cache-Control` is set by the worker). |
| `POST` | `/v1/events/:slug/gallery/download` | Body `{ photoIds (1..100), variant: "original" \| "web" }` (variant default `original`). Returns `{ urls }` as v1. Ownership check is one query (`photoIds = any(...)` against the caller's gallery). |
| `POST` | `/v1/events/:slug/gallery/zip` | New. Accepts `application/x-www-form-urlencoded` (`ids` = comma-separated uuids, 1..500; `variant` = `original`\|`web`) **or** JSON `{ photoIds, variant }`. Verifies `Origin` (when present) equals `WEB_ORIGIN`. Streams `application/zip` (`archiver`, store mode, no compression), `Content-Disposition: attachment; filename="rephoto-{slug}.zip"`, entries named `{slug}-{index:04}.jpg`. Only owned photos; unknown ids → `403`. Objects are streamed from S3 (`ObjectStore.stream(key)` → `Readable`), never buffered whole. |
| `POST` | `/v1/uploads/init` | Requires `event_photographers` membership (else `403`). Stores `bytes` on the session. `single` mode presigns the PUT with `ContentLength = bytes` and `ContentType`. Max `bytes` 60 MiB → `400` above. |
| `POST` | `/v1/uploads/:id/complete` | After `head`, requires `stored.bytes === session.bytes` (else `400` and session `aborted`). |
| `GET` | `/v1/uploads` | Adds `?cursor=&limit=` (default 50, max 200), response adds `nextCursor`. Default order `created_at desc`. |
| `GET` | `/v1/uploads/summary` | New. `?eventId=`. `{ sessions: { open, completed, aborted }, photos: { uploaded, processing, indexed, error } }` for the caller's own uploads, one query each. |
| `GET` | `/v1/admin/metrics` | Adds `jobsRunning`, `jobsError`, `photosByStatus: { uploaded, processing, indexed, error }`, `galleries`. |
| `GET` | `/health` and `/v1/health` | Run `select 1` with a 2 s timeout; `503 { ok: false }` on failure. |

Client IP: `TRUSTED_PROXY_HOPS` env (int, default 1). With `x-forwarded-for = a, b, c` and hops 1, the client IP is `c` (the entry appended by the first trusted proxy); hops 2 → `b`. Without the header → the socket address if available, else `"unknown"`. The Next.js proxy forwards `x-forwarded-for` unchanged.

Security headers: API keeps v1 headers. Next.js adds (`next.config.ts` `headers()`): `Content-Security-Policy` (`default-src 'self'; img-src 'self' blob: data: ${NEXT_PUBLIC_MEDIA_ORIGINS}; connect-src 'self' ${NEXT_PUBLIC_MEDIA_ORIGINS}; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(self)`, HSTS when `NEXT_PUBLIC_WEB_ORIGIN` is https. `NEXT_PUBLIC_MEDIA_ORIGINS` is a space-separated list of origins that serve presigned URLs (local: `http://localhost:9000`).

Magic-link verify page no longer consumes the token on load: it renders a button "Entra" and POSTs on click (defeats link scanners).

---

## 5. Database interface additions (`packages/db/src/types.ts`)

Implemented by both `PostgresDatabase` and `MemoryDatabase`.

```ts
enqueueJob(type, payload, opts?: { priority?: number; dedupeKey?: string; runAfter?: Date }): Promise<string>;
failJobTerminal(id: string, error: string): Promise<void>;           // sets error, attempts = JOB_MAX_ATTEMPTS
pruneJobs(input: { doneOlderThan: Date }): Promise<number>;
abortStaleUploads(input: { olderThan: Date }): Promise<Array<{ id; objectKey; s3UploadId }>>;  // marks open → aborted, returns the rows
countMagicLinksSince(input: { email?: string; ip?: string; since: Date }): Promise<number>;
insertMagicLink(input + ip: string | null)
consumeInvite(tokenHash): Promise<{ email; role; eventId } | null>;
addEventPhotographer(eventId, userId): Promise<void>;
isEventPhotographer(eventId, userId): Promise<boolean>;
upsertEventParticipants(eventId, emails: string[]): Promise<number>;
isEventParticipant(eventId, email): Promise<boolean>;
updateEvent(id, patch: { access?: "open" | "list"; retentionDays?: number }): Promise<EventRow | null>;
setPhotoIndexed(id): Promise<void>;                                   // status indexed + indexed_at
setPhotoError(id, error: string): Promise<void>;
findFaceRowsByPhoto(photoId): Promise<Array<{ id; externalId }>>;
replaceGallery(userId, eventId, items, anchors: string[]): Promise<void>;   // sets anchor_face_ids, matched_at, notified_at
findGalleriesByAnchors(eventId, externalFaceIds: string[]): Promise<Array<{ id; userId; anchorFaceIds; notifiedAt }>>;
addGalleryItems(galleryId, items: Array<{ photoId; faceId; score; source: "attach" }>): Promise<number>;  // returns inserted count, upsert greatest(score)
markGalleryNotified(galleryId, at: Date): Promise<void>;
findGalleryByUser(userId, eventId): Promise<{ id; anchorFaceIds; matchedAt } | null>;
listGalleryPage(userId, eventId, input: { limit; cursor?: { score; photoId } }): Promise<{ total; items: Array<{ photoId; score; source; createdAt; thumbKey; webKey }> }>;  // one query
listOwnedPhotos(userId, eventId, photoIds): Promise<PhotoRow[]>;       // photos in the caller's gallery, one query
listUploadSessionsPage(photographerId, eventId, input: { limit; cursor?: { createdAt; id } }): Promise<{ items; nextCursor }>;
uploadSummary(photographerId, eventId): Promise<{ sessions: {...}; photos: {...} }>;
insertUploadSession(input + bytes: number)
removeAnchors(eventId, externalFaceIds: string[]): Promise<void>;
ping(): Promise<void>;
metrics(): extended shape (see §4)
```

`EventRow` gains `access: "open" | "list"`. `PhotoRow` gains `indexedAt: Date | null`, `error: string | null`. `UploadSessionRow` gains `bytes: number | null`.

`createSql`: `max` from `DATABASE_POOL_MAX` (default 10), `connect_timeout 10`, `prepare: true`.

`migrate()`: takes `pg_advisory_lock(727312)` for the whole run (transaction-level lock inside a wrapping transaction, or session lock + unlock in `finally`) so several instances booting together do not race. Bootstrap of `schema_migrations` happens under the same lock.

---

## 6. Web (`apps/web`)

Uploader (`/upload`):

- Up to `4` files in flight (`UPLOAD_PARALLEL`), each file's parts sequential. Hashing with `hash-wasm` (`createSHA256`, streamed in 4 MiB slices) so memory stays flat for 60 MiB files.
- Local persistence (IndexedDB, store `rephoto-uploads`): fingerprint `name|size|lastModified` → `{ sha256, photoId?, status }`. On re-drop: skip hashing when the fingerprint is known; skip upload when the server says `409` or the fingerprint status is `sent`.
- Resume: a file in `error` keeps a "Riprova" action; "Riprova tutti" re-runs every failed file.
- The list is windowed (render only visible rows; simple windowing, no dependency) and progress is aggregated: `caricate / totali`, MB/s, ETA.
- Status panel polls `GET /v1/uploads/summary` every 10 s (not the full list). The list of past sessions is paged behind a "Mostra storico" button.
- Validation: jpeg/png only; max 60 MiB; empty files rejected; duplicate fingerprints inside one drop are collapsed.

Gallery (`/e/[slug]`):

- Paged, infinite scroll via `IntersectionObserver`, `nextCursor` chain. Grid cells lazy-load thumbnails.
- Two groups by score: "Le tue foto" (score ≥ 0.9) and "Forse sei tu" (0.8 ≤ score < 0.9), collapsible.
- Selection: tap/click on the checkbox; "Seleziona tutte (gruppo)", "Annulla". Count shown in the action bar.
- Download: action bar offers "Scarica ZIP" with a variant choice ("Originali" / "Per il web"). ZIP = hidden `<form method="post" action="/v1/events/{slug}/gallery/zip">` with `ids` and `variant` fields, submitted as a navigation (browser handles the streamed download). Max 500 per ZIP; over that, the UI asks to select fewer. Single photo from the viewer: `download` endpoint → open URL.
- Status banner when `status = queued` ("Confronto in corso…") polling every 5 s until `ready`; when ready and items grew since last load, a toast "Nuove foto".
- "Nuove foto" badge on items with `source = attach` and `createdAt` newer than the last visit (stored in `localStorage` per slug).

Auth pages: `/verify` renders a button "Entra" and only then POSTs; `/invito` (new) accepts a photographer invite via `POST /v1/auth/accept-invite` on click and then redirects to `/upload`.

Admin (`/admin`): adds event access toggle (open/list), participant import (textarea, one email per line → `POST /v1/admin/participants/import`), extended metrics.

Dev-only S3 PUT proxy (`/api/s3-put`): keep, but respond `404` when `NODE_ENV === 'production'`, stream the body (`request.body` → `fetch(..., { duplex: 'half' })`), and keep the localhost:9000 allowlist. Compose sets `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000` so the proxy is a fallback only.

---

## 7. Infra, ops, docs

- `apps/api/Dockerfile`, `apps/worker/Dockerfile`: multi-stage, `npm ci --workspaces --include-workspace-root`, `node:22-bookworm-slim`, non-root user, `NODE_ENV=production`, `HEALTHCHECK` on `/health` for the API.
- `apps/web/Dockerfile`: npm (no pnpm), `next build` with `output: "standalone"`, non-root.
- `docker-compose.yml`: keep infra services; add MinIO CORS env; add an optional `profiles: ["app"]` trio (api, worker, web) built from the Dockerfiles for an end-to-end local run.
- `infra/cdk` (TypeScript, aws-cdk-lib v2): one stack, eu-central-1: VPC (2 AZ, private subnets, S3 gateway endpoint, interface endpoints for ECR/logs/Secrets Manager/Rekognition/SES/SQS? — v2 keeps the Postgres queue, so no SQS), RDS Postgres 16 `db.t4g.medium` Multi-AZ off + RDS Proxy, S3 bucket (private, KMS, lifecycle 2 days on `selfies/`, abort incomplete multipart after 2 days), CloudFront in front of ALB for the web/API, ECS Fargate services `api` (min 2, max 6, CPU target scaling) and `worker` (min 1, max 8, scaled on a custom CloudWatch metric `rephoto/QueueDepth` that the worker publishes every 30 s — add `WORKER_PUBLISH_METRICS=true`), Secrets Manager for `SESSION_SECRET` and `DATABASE_URL`, task roles with least-privilege IAM (`rekognition:*Faces*`/`*Collection*` on `collection/rephoto-*`, `s3` on the bucket, `ses:SendEmail`), CloudWatch alarms (queue depth > 2000 for 15 min, job error rate, API 5xx, RDS CPU/connections), AWS WAF with a rate rule on `/v1/auth/*`. `cdk synth` must pass (`npm run synth` in `infra/cdk`). It is a reference stack, not applied automatically.
- `scripts/loadtest/`: k6 scripts: `upload.js` (12 virtual photographers, 2 MB synthetic JPEG, measure init/complete latency), `selfie.js` (1,000 selfies in 10 minutes, poll gallery until ready, measure time-to-ready). README with how to run against local or staging.
- Docs: `CONTRACTS.md` updated to v2; `docs/DPIA.md` rewritten to match the real routes, tables, keys, scores, the attach job (what is stored: Rekognition FaceIds of the participant's own matched faces as `anchor_face_ids`, no vectors), the list-based access control, and Face Liveness as a planned control; `docs/aws.md` replaced by `docs/infra.md`; `RUN.md` updated (`WORKER_CONCURRENCY`, profiles, summary endpoint); `README.md` short overview.
- Explicitly out of scope for this pass (documented as next steps): Rekognition Face Liveness (needs Amplify UI + session API), a desktop folder-sync uploader, SQS swap.

---

## 8. Ownership during the work

| Area | Paths |
| --- | --- |
| foundation | `packages/contracts/**`, `packages/db/**`, `packages/face-engine/**` |
| worker | `apps/worker/**` (incl. tests) |
| api | `apps/api/**` |
| web | `apps/web/**` |
| infra/docs | `infra/**`, `scripts/**`, Dockerfiles, `docker-compose.yml`, `docs/**`, `CONTRACTS.md`, `RUN.md`, `README.md`, `.env.example` |

If an area needs something from another area that is not in this spec, add it in the smallest additive way and note it in the final report.
