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

Callers depend on `FaceEngine` from `@rephoto/contracts`. Swapping InsightFace in later means a new class in `packages/face-engine` plus `FACE_ENGINE`. Callers stay unchanged.

## FaceEngine

```ts
export type BBox = { x: number; y: number; width: number; height: number }; // 0..1 relative

export interface IndexFace {
  externalId: string;
  bbox: BBox;
  confidence: number; // 0..1
}

export interface FaceMatch {
  externalId: string;
  photoId: string;
  similarity: number; // 0..1
}

export interface FaceEngine {
  indexPhoto(input: { eventId: string; photoId: string; imageBytes: Uint8Array }): Promise<IndexFace[]>;
  searchSelfie(input: { eventId: string; imageBytes: Uint8Array; threshold: number }): Promise<FaceMatch[]>;
  deleteFaces(input: { eventId: string; externalIds: string[] }): Promise<void>;
}
```

- Default `threshold` is **0.8** (0..1). Callers pass 0..1 only.
- Rekognition `Similarity` and `Confidence` are 0–100. The adapter divides by 100 at the boundary before returning `FaceMatch.similarity` or `IndexFace.confidence`. The adapter multiplies `threshold` by 100 when it sets Rekognition `FaceMatchThreshold`.
- Rekognition `BoundingBox` (`Left`, `Top`, `Width`, `Height`, already 0..1) maps to `{ x: Left, y: Top, width: Width, height: Height }`.
- `IndexFace.externalId` is the vendor face id (Rekognition `FaceId`). It is **not** the photo id.
- Rekognition `ExternalImageId` is the **photoId** unchanged. `FaceMatch.photoId` is that value. `FaceMatch.externalId` is the matched `FaceId`.
- `deleteFaces` deletes by `externalId` inside the event collection. Empty `externalIds` is a no-op.
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

- `indexPhoto` returns one face: `externalId` `fake-${photoId}`, `bbox` `{ x: 0.25, y: 0.2, width: 0.3, height: 0.4 }`, `confidence` `0.99`.
- `searchSelfie` reads rows from Postgres `faces` for `eventId` (via `DATABASE_URL`) and returns one `FaceMatch` per row with that `externalId`, the row's `photoId`, and `similarity` `0.99`, dropping rows below `threshold`. This is how the demo works across the API and worker processes. It must not read or write an embedding.
- `deleteFaces` resolves successfully and does not itself delete SQL rows (the caller does).

## Environment

`.env.example` only. Never commit real secrets.

| Variable | Local value |
| --- | --- |
| `DATABASE_URL` | `postgres://rephoto:rephoto@localhost:5432/rephoto` |
| `S3_ENDPOINT` | `http://localhost:9000` |
| `S3_BUCKET` | `rephoto` |
| `S3_ACCESS_KEY` | `rephoto` |
| `S3_SECRET_KEY` | `rephoto-secret` (local MinIO only) |
| `S3_REGION` | `eu-central-1` |
| `S3_FORCE_PATH_STYLE` | `true` |
| `SESSION_SECRET` | long random string; dev placeholder in `.env.example` |
| `FACE_ENGINE` | `fake` locally, `rekognition` in AWS |
| `AWS_REGION` | `eu-central-1` |
| `REKOGNITION_COLLECTION_PREFIX` | `rephoto-` |
| `SMTP_HOST` | `localhost` |
| `SMTP_PORT` | `1025` |
| `SMTP_FROM` | `noreply@rephoto.local` |
| `WEB_ORIGIN` | `http://localhost:3000` |
| `API_ORIGIN` | `http://localhost:8787` |

`FACE_ENGINE` is exactly `fake` or `rekognition`.

## Object keys

| Object | Key | Notes |
| --- | --- | --- |
| Original | `originals/{eventId}/{photoId}` | No extra extension. |
| Thumb | `thumbs/{photoId}.jpg` | Long edge 480, JPEG. |
| Web | `web/{photoId}.jpg` | Long edge 1600, JPEG quality 80. |
| Selfie | `selfies/{eventId}/{userId}/{uuid}` | Deleted after a successful `searchSelfie`. |

Derivative `kind` is `thumb` or `web` and matches those keys.

On `searchSelfie` success (including zero matches), the match job deletes the selfie object before it marks the job `done`. On a thrown search, keep the object for retry. After the final failed attempt, delete the selfie anyway.

## Jobs

Jobs live in Postgres table `jobs`, not SQS, on the local/MVP path. Production may swap the job runner for SQS without changing payload shapes.

Payloads:

| `type` | `payload` |
| --- | --- |
| `derive` | `{ photoId }` |
| `index` | `{ photoId }` |
| `match` | `{ userId, eventId, selfieKey }` |
| `email` | `{ userId, eventId, galleryPath }` |

Row: `id`, `type`, `payload` jsonb, `status` (`queued` \| `running` \| `done` \| `error`), `attempts`, `run_after`, `last_error`, `created_at`.

Worker claim: `UPDATE` one `queued` row whose `run_after <= now()` to `running`, using `FOR UPDATE SKIP LOCKED`. On success, `done`. On failure, increment `attempts`, set `last_error`, and either requeue (`queued`, `run_after` in the future) or set `error` when `attempts` reaches **5**.

Pipeline:

1. Upload complete inserts `photos.status = uploaded` and enqueues `derive`.
2. `derive` writes both derivatives, sets `processing`, enqueues `index`.
3. `index` calls `indexPhoto`, inserts `faces`, sets `indexed`.
4. `POST .../selfie` stores the selfie object and enqueues `match`.
5. `match` calls `searchSelfie`, upserts `galleries` / `gallery_items` (score = similarity), deletes the selfie object, enqueues `email`.
6. `email` sends the gallery link. `galleryPath` is `/e/{slug}` on `WEB_ORIGIN`.

Terminal job failure on `derive` or `index` sets the photo to `error`.

## Postgres

`packages/db/migrations/001_init.sql`. The migrate script may keep a `schema_migrations` bookkeeping table; that table is not a domain table.

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
| `GET` | `/v1/admin/metrics` | | `200` `{ events, photos, faces, users, jobsQueued }` counts |
| `POST` | `/v1/admin/photographers/invite` | `{ email, eventId }` | `201` `{ inviteId }` |
| `DELETE` | `/v1/admin/photos/:id` | | `204` |
| `DELETE` | `/v1/admin/participants/:id` | | `204` |
| `POST` | `/v1/admin/retention/run` | `{ eventId }` | `200` `{ deletedPhotoIds }` |

`role` is `participant` \| `photographer` \| `admin`.

Auth rules:

- `request-link` always returns `202` `{ status: "sent" }` (no account enumeration). Mail is sent only when the role is allowed: `participant` always; `photographer` or `admin` only when that `(email, role)` user already exists. Verify creates a `participant` user on first use. Verify for `photographer` or `admin` fails with the same generic `400` `{ error }` if that user does not exist. A photographer is created by accepting an invite (seed, or a future accept step). This MVP's accept path is the seed; `POST /v1/admin/photographers/invite` only inserts an unused `invites` row with role `photographer`.
- Magic-link and invite tokens expire. Verify rejects expired or already used links.
- Participant: only the gallery, consent, and selfie for the signed-in user.
- Photographer: only upload routes, and only their own `upload_sessions` and photos (`photographer_id`).
- Admin: metrics, photographer invites, photo delete, participant delete, retention run.
- Selfie requires a consent row for this user and event with `withdrawn_at` null. Otherwise `403`.
- Rate-limit selfie: **5 per hour per email** (the session user's email). `429` over the limit.
- Gallery `status` is `empty` (no match job and no items), `queued` (a `match` job for this user+event is `queued` or `running`), or `ready` (latest such job is `done` or `error`). `items` lists `gallery_items` with signed `thumbUrl` and `webUrl`. `score` is the stored similarity.
- Download signs **original** keys. Only photo ids already in the caller's gallery. URLs expire in 15 minutes.
- `uploads/init`: when `bytes` <= 8388608 (8 MiB), `mode` is `single` and `url` is a presigned PUT. Otherwise `mode` is `multipart`, `partSize` is 8388608, and `url` is omitted. `objectKey` is `originals/{eventId}/{photoId}` using a new photo id reserved at init time. Complete creates the `photos` row (`uploaded`) and enqueues `derive`. Single-PUT complete sends `parts: []`.
- `contentType` for uploads is `image/jpeg` or `image/png`.
- `DELETE /v1/admin/photos/:id` deletes the photo row, derivatives, faces, gallery items, S3 objects, and calls `deleteFaces` with the stored `external_id`s. Writes `audit_log`.
- `DELETE /v1/admin/participants/:id` deletes that `participant` user and dependent galleries, consents, sessions, magic links. Photos stay. Writes `audit_log`.
- `retention/run` deletes photos of `eventId` whose `created_at` is older than `retention_days`. Same erasure path as photo delete. Not a job type. Response lists deleted photo ids.

Signed URL helpers and the Rekognition client stay out of `packages/contracts`.
