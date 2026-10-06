# RePhoto contracts

Status: **FROZEN**. Implement HTTP, jobs, persistence, and `FaceEngine` against this file and `@rephoto/contracts`. Similarity is Rekognition's scale **0–100**. The default match threshold is **90** (`REKOGNITION_MIN_SIMILARITY`), inclusive (`>=`). Do not rescale to 0–1.

Region is **AWS eu-central-1 only**. There is no Qdrant, no GPU host, and no InsightFace runtime. InsightFace may later replace the Rekognition adapter behind the same `FaceEngine` interface.

## 1. Environments

| | Local compose | Production |
| --- | --- | --- |
| `FACE_ENGINE` | `fake` | `rekognition` |
| Objects | MinIO, bucket `rephoto`, private | S3 `eu-central-1`, private bucket |
| Mail | SMTP to Mailpit | SES in `eu-central-1` |
| Queue | Postgres table `jobs` | SQS. Message body is the same JSON as `jobs.payload` |
| AWS calls | none | Rekognition + S3 + SES, all `eu-central-1` |

`AWS_REGION` and `S3_REGION` are always `eu-central-1`. Reject any other region.

### Env vars

Validated by `envSchema` in `@rephoto/contracts`.

| Name | Local example | Rule |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://rephoto:rephoto@localhost:5432/rephoto` | required |
| `S3_ENDPOINT` | `http://localhost:9000` | required for MinIO (`FACE_ENGINE=fake`). Omit in production so the AWS SDK uses S3 in `eu-central-1` |
| `S3_BUCKET` | `rephoto` | one private bucket |
| `S3_ACCESS_KEY_ID` | `rephoto` | MinIO root user locally. IAM in production |
| `S3_SECRET_ACCESS_KEY` | dev placeholder | secret, env only |
| `S3_REGION` | `eu-central-1` | literal |
| `MAIL_TRANSPORT` | `smtp` | `smtp` or `ses` |
| `MAILPIT_SMTP_HOST` | `localhost` | required when `MAIL_TRANSPORT=smtp`. Inside compose: `mailpit` |
| `MAILPIT_SMTP_PORT` | `1025` | required when `MAIL_TRANSPORT=smtp` |
| `MAILPIT_UI_URL` | `http://localhost:8025` | local UI only |
| `FACE_ENGINE` | `fake` | `fake` or `rekognition` |
| `REKOGNITION_COLLECTION_PREFIX` | `rephoto` | charset `[A-Za-z0-9_.\-]+` |
| `REKOGNITION_MIN_SIMILARITY` | `90` | number 0–100, default 90 |
| `AWS_REGION` | `eu-central-1` | literal |
| `SESSION_SECRET` | placeholder, min 16 chars | signs nothing user-facing; hashes are sha256. Still required and env-only |
| `EVENT_SLUG` | `demo` | seed event |
| `ADMIN_EMAIL` | `admin@example.com` | seed admin |
| `PUBLIC_WEB_URL` | `http://localhost:3000` | links in email |
| `API_PORT` | `3001` | API listen port |

Secrets never go in the repo, the database, logs, or Rekognition `ExternalImageId`.

## 2. FaceEngine

TypeScript source of truth: `packages/face-engine/src/types.ts` (`@rephoto/face-engine/types`).

```ts
export type ImageContentType = "image/jpeg" | "image/png";
export interface Box { left: number; top: number; width: number; height: number } // normalized 0..1
export interface IndexPhotoInput {
  eventId: string;
  photoId: string;
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}
export interface IndexedFace {
  externalFaceId: string;
  bbox: Box;
  confidence: number; // 0..100
}
export interface SearchInput {
  eventId: string;
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}
export interface SearchHit {
  externalFaceId: string;
  photoId: string;
  similarity: number; // 0..100
}
export interface FaceEngine {
  indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]>;
  search(input: SearchInput): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
}
```

Rules for every adapter:

- `indexPhoto` indexes one **event photo**. It must never be called with a selfie.
- `search` is the only call that receives selfie bytes. It must not call `IndexFaces` and must not write the selfie into a collection or into `face_index`.
- Returned hits have `similarity >= REKOGNITION_MIN_SIMILARITY`. The worker applies the same filter again.
- `deleteFaces` removes engine-side records only. The worker deletes rows in `faces`.
- `bbox` is normalized 0..1 (Rekognition `BoundingBox`). `confidence` and `similarity` are 0..100.
- A photo with no face returns `[]` and is still a successful index.

Collection name (Rekognition adapter):

```text
safe = eventId with every char outside [a-zA-Z0-9_.\-] replaced by "_"
name = REKOGNITION_COLLECTION_PREFIX + "-" + safe
```

Example: event `11111111-1111-4111-8111-111111111111` → `rephoto-11111111-1111-4111-8111-111111111111`. Create the collection on first index if missing. Length must be ≤ 255.

### 2.1 Fake adapter (`FACE_ENGINE=fake`)

Local and tests only. Do not use it in production.

Subject key = quantized average color of the image (PNG or JPEG):

```text
Read every pixel as RGB. Ignore alpha.
avgR = round(sum(R) / pixelCount)   # integer 0..255, same for G and B
quant(c) = floor(c / 16) * 16       # 0, 16, 32, …, 240
```

`pixelCount = 0` → `indexPhoto` returns `[]` and writes nothing.

`indexPhoto` writes one row into `face_index` (table owned by the API migration; the fake adapter reads and writes it):

| column | value |
| --- | --- |
| `external_face_id` | `fake-{photoId}` |
| `photo_id` | input `photoId` |
| `event_id` | input `eventId` |
| `r`, `g`, `b` | quantized averages, each in {0,16,…,240} |

Return one `IndexedFace`: that `externalFaceId`, `confidence: 99`, `bbox: { left: 0, top: 0, width: 1, height: 1 }`.

`search` computes the same quantized color and returns every `face_index` row of that `event_id` with equal `r,g,b`. Each hit: `similarity: 99`, `photoId` and `externalFaceId` from the row. No color match → `[]`.

`deleteFaces` deletes `face_index` rows for that `event_id` whose `external_face_id` is in the list. Unknown ids are ignored.

### 2.2 Rekognition adapter (`FACE_ENGINE=rekognition`)

One collection per event, named as above.

- `indexPhoto`: `IndexFaces` on the photo bytes. `ExternalImageId = photoId`. `MaxFaces = 50`. Quality filter `AUTO`. Map each face: `externalFaceId = FaceId`, `bbox` from `BoundingBox` (already 0..1), `confidence = Confidence` (0..100).
- `search`: `SearchFacesByImage` only. `FaceMatchThreshold = REKOGNITION_MIN_SIMILARITY`. `MaxFaces = 50`. `photoId = Face.ExternalImageId`, `externalFaceId = Face.FaceId`, `similarity = Similarity`. Never `IndexFaces` the selfie.
- `deleteFaces`: `DeleteFaces` in that collection. Missing collection → no-op.

The worker, before a re-index, loads existing `faces.external_face_id` for the photo and calls `deleteFaces`, then `indexPhoto`, then replaces `faces` rows. `indexPhoto` does not delete old faces itself.

## 3. HTTP

Base path `/api`. JSON bodies except the selfie upload. Cookie session, not bearer tokens.

Cookie `rephoto_session`:

- value: opaque random token (store only `sha256(token)` in `sessions.token_hash`)
- `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000` (30 days)
- `Secure` when `PUBLIC_WEB_URL` is `https`, otherwise omit `Secure` (local http)
- host-only (no `Domain`)

The web app is served on `PUBLIC_WEB_URL` and **proxies `/api` to the API**, so the cookie is first-party. CORS is not required for that setup. If an `Origin` header is present and is not `PUBLIC_WEB_URL`, respond `403 forbidden`.

Validation failures use zod schemas from `@rephoto/contracts`. Unknown JSON fields are rejected (schemas are `.strict()`).

Error body (every 4xx/5xx that has a body):

```json
{ "error": { "code": "validation_error", "message": "Dati non validi." } }
```

`code` is stable English. `message` is Italian and safe to show in the UI.

| code | HTTP | when |
| --- | --- | --- |
| `validation_error` | 400 | zod failure, bad multipart, `accepted` not `true` |
| `unauthorized` | 401 | missing or expired session |
| `forbidden` | 403 | role cannot call this route |
| `consent_required` | 403 | selfie without a stored consent for this event and current text version |
| `not_found` | 404 | missing event, search, photo, upload, or user (also when the row exists but is not owned, so ownership does not leak) |
| `conflict` | 409 | invite role clash, upload already completed, consent `textVersion` ≠ event's current version |
| `rate_limited` | 429 | magic link or selfie limits |

Success responses below are the entire JSON body. `204` has no body.

IDs in JSON are UUID strings. Timestamps in Postgres are `timestamptz`. Client-supplied hashes are lowercase hex sha256 (64 chars). The API does **not** re-hash bytes in v1; dedup trusts the client sha256 within one event.

### 3.1 Auth

`POST /api/auth/request-link`

- Auth: none
- Body: `{ "email": string, "eventSlug": string }`
- `202`: `{ "ok": true }`
- Unknown `eventSlug` → `404`. Known event → always `202`, even if the email is new (no account enumeration).
- New email: create `users.role = participant` and an `event_memberships` row.
- Existing user: do not change `role`. Still send the link.
- Insert `magic_links` (store `token_hash` only), expiry 30 minutes, single use.
- Send mail immediately (not the `email` job). Text body is only the URL `${PUBLIC_WEB_URL}/verifica?token=${token}`. Subject: `Accedi a RePhoto`. No images.
- Rate limit: 5 links per email per 15 minutes, and 30 per `request_ip` per 15 minutes. Count rows in `magic_links`.

`POST /api/auth/verify`

- Auth: none
- Body: `{ "token": string }`
- `200`: the user `{ "id", "email", "role" }` and `Set-Cookie`
- Token must match an unused, unexpired hash. Set `used_at`. Second use → `400`.
- Insert `sessions`.

`POST /api/auth/logout`

- Auth: session optional
- `204`. Delete the session row if the cookie matches. Clear the cookie.

`GET /api/me`

- Auth: session
- `200`: `{ "id", "email", "role" }` with `role` one of `participant`, `photographer`, `admin`

### 3.2 Consent and selfie

Current consent copy is version `2026-10-06`, stored on the event:

> Acconsento al confronto temporaneo del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.

`POST /api/events/:slug/consent`

- Auth: `participant`
- Body: `{ "textVersion": string, "accepted": true }`
- `accepted` must be the boolean `true`. Anything else → `400`.
- `textVersion` must equal `events.consent_text_version` → else `409`.
- `201`: `{ "ok": true }`
- Insert `consents` with `text_version`, `accepted=true`, `accepted_at`, client IP, and `User-Agent`. Required before selfie. Keep the row even if a newer search happens (legal record). A selfie is allowed when at least one consent exists for `(user, event, current text version)`.

`POST /api/events/:slug/selfie`

- Auth: `participant` with consent, else `403 consent_required`
- `multipart/form-data`, file field name **`image`**
- Content type `image/jpeg` or `image/png`. Max **8 MiB**. Else `400`.
- `202`: `{ "searchId": uuid }`
- Insert `searches` with `status=queued`, `selfie_key` set. Store the object at `selfies/{eventId}/{searchId}`.
- Enqueue job `{ "type": "search", "searchId" }`. Do not call `FaceEngine` in the request.
- Rate limit: 10 searches per user per 60 minutes, and 30 per IP per 60 minutes. Count `searches` rows (`request_ip` column).

`GET /api/events/:slug/searches/:searchId`

- Auth: the participant who owns the search. Others, including admin, → `404`.
- `200`: `{ "status": "queued" | "done" | "error", "galleryReady": boolean }`
- `galleryReady` is `true` only when `status === "done"` (including zero matches).

### 3.3 Gallery

`GET /api/events/:slug/gallery`

- Auth: `participant`
- `200`: `{ "items": [{ "photoId", "thumbUrl", "webUrl", "score" }] }`
- Only that user's gallery for the event. `score` is similarity 0–100. One item per photo (maximum score). Sort `score` descending, then `photoId` ascending.
- `thumbUrl` and `webUrl` are signed GET URLs, TTL **15 minutes**, for derivative kinds `thumb` and `web`.

`POST /api/events/:slug/gallery/download`

- Auth: `participant`
- Body: `{ "photoIds": uuid[] }` length 1–100
- `200`: `{ "urls": string[] }` same order as `photoIds`
- Each URL is a signed GET of the **original** object, TTL 15 minutes.
- If any id is not in the caller's gallery for that event → `403` for the whole request (no partial URLs).

### 3.4 Photographer upload

`eventSlug` is required on create. Dedup scope is that event. This is the frozen clarification of "dedup same sha256 per event".

`POST /api/uploads`

- Auth: `photographer` who has `event_memberships` for `eventSlug`. Admin → `403`. Unknown event or missing membership → `404`.
- Body: `{ "eventSlug", "filename", "contentType", "byteSize", "sha256" }`
- `contentType`: `image/jpeg` | `image/png`
- `byteSize`: integer 1 … 31457280 (30 MiB)
- `sha256`: `/^[a-f0-9]{64}$/`
- `filename`: 1–200 chars, no `/` or `\`, not `.` or `..`
- If a `photos` row already exists for `(event, sha256)` → `200`:

```json
{ "deduped": true, "photoId": "<uuid>" }
```

Do not create an upload session and do not re-index. The caller does not become the owner.

- Otherwise `201`:

```json
{
  "deduped": false,
  "uploadId": "<uuid>",
  "key": "originals/<eventId>/uploads/<uploadId>",
  "partSize": 8388608,
  "parts": [{ "partNumber": 1, "url": "https://..." }]
}
```

- `partSize` is always 8388608. `parts.length = ceil(byteSize / partSize)`. The last part may be shorter. Part URLs are presigned PUT, TTL 15 minutes. Insert `upload_sessions.status = open`.

`POST /api/uploads/:uploadId/complete`

- Auth: the photographer who owns the session
- Body: `{ "parts": [{ "partNumber": number, "etag": string }] }`
- The set of `partNumber` must equal `1..N` exactly.
- `200`: `{ "photoId", "status": "queued" }`
- Complete the multipart upload, insert `photos` (`status=queued`, `object_key` = the upload key, `photographer_user_id` = caller), mark the session `completed`, enqueue `{ "type": "derive", "photoId" }`.
- Second complete → `409`.

`GET /api/photos`

- Auth: `photographer` only (admin → `403`)
- `200`: `{ "photos": [{ "photoId", "filename", "status", "error?" }] }`
- `status`: `queued` | `processing` | `indexed` | `error`
- Only rows where `photographer_user_id` is the caller. `error` is present only when `status` is `error`.

### 3.5 Admin

`GET /api/admin/metrics`

- Auth: `admin`
- `200`: `{ "photos", "indexed", "participants", "queueDepth" }`
- `photos`: count of `photos` rows
- `indexed`: count where `status = indexed`
- `participants`: count of users with `role = participant`
- `queueDepth`: count of `jobs` where `status = queued`
- No vectors, face ids, or image bytes in this payload. The database has no embedding column.

`POST /api/admin/photographers`

- Auth: `admin`
- Body: `{ "email", "eventSlug" }`
- Unknown event → `404`
- Email new: create `role=photographer`, membership, magic link, send the same login mail as request-link. `202` `{ "ok": true }`
- Email already `photographer`: ensure membership, send a new magic link. `202`
- Email exists with another role → `409`. Do not change role.

`DELETE /api/admin/photos/:photoId`

- Auth: `admin`
- `204`
- Delete the original object, both derivatives, `FaceEngine.deleteFaces` for that photo's external ids, rows in `faces`, `gallery_items` for that photo, and the `photos` row. Other photos stay.

`DELETE /api/admin/participants/:userId`

- Auth: `admin`
- Target must have `role=participant`, else `404`
- `204`
- Delete the user account, sessions, magic links, consents, searches (and any leftover selfie object), galleries, and `gallery_items` for that user.
- Do **not** delete event photos, derivative objects, or `faces` rows. Group photos stay in the event.

`POST /api/admin/retention`

- Auth: `admin`
- Body: `{ "eventSlug" }`
- `200`: `{ "photosDeleted", "facesDeleted", "searchesDeleted" }`
- Cutoff = `now() - events.retention_days` (default 90).
- For photos of that event with `created_at < cutoff`: same deletion as `DELETE /admin/photos/:photoId`.
- For searches of that event with `created_at < cutoff`: delete selfie object if `selfie_key` is still set, delete those searches, and delete gallery items that belonged only to removed photos. Do not delete `users` or `consents` or `audit_log`.
- Synchronous in v1. No extra job type.

### 3.6 Authorization

| Route | participant | photographer | admin | anonymous |
| --- | --- | --- | --- | --- |
| request-link, verify | | | | yes |
| logout, GET /me | yes | yes | yes | |
| consent, selfie, search status, gallery, download | yes | | | |
| uploads, complete, GET /photos | | own event / own photos | | |
| metrics, invite, delete photo, delete participant, retention | | | yes | |

A participant cannot upload or call admin routes. A photographer cannot read galleries or another photographer's photos. An admin cannot receive raw vectors (none are stored).

## 4. Jobs

Local stand-in: table `jobs`. Production: SQS queue `rephoto-jobs` in `eu-central-1`. **The JSON body is identical.** Do not run ElasticMQ.

`jobs.payload` and the SQS body are a `jobEnvelopeSchema`:

```json
{ "type": "derive", "photoId": "<uuid>" }
{ "type": "index", "photoId": "<uuid>" }
{ "type": "search", "searchId": "<uuid>" }
{ "type": "email", "to": "a@b.c", "template": "gallery_ready", "searchId": "<uuid>" }
```

`jobs.type` duplicates `payload.type` for indexing.

Worker claim (local): `SELECT … FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED`. Set `status=running`, `locked_at=now()`, `attempts = attempts + 1`.

Retry: on a thrown error, if `attempts < 5`, set `status=queued` and `run_at = now() + attempts * 30 seconds`. Else `status=error` and `last_error` set. Domain status side effects below happen on the final failure only, except where noted.

| Job | Success | Final failure |
| --- | --- | --- |
| `derive` | Write derivatives `thumb` (max edge 480, JPEG) and `web` (max edge 1600, JPEG). Set `photos.status=processing`. Enqueue `index`. | `photos.status=error`, `photos.error` set |
| `index` | `deleteFaces` of previous ids (if any), `indexPhoto`, replace `faces` rows. Set `photos.status=indexed`, `error=null`. Zero faces is success. | `photos.status=error` |
| `search` | `search`, drop similarity &lt; threshold, one gallery item per photo at max score, replace that user's event gallery, delete the selfie object, set `selfie_key=null`, `searches.status=done`, enqueue `email`. | Delete the selfie anyway, `selfie_key=null`, `searches.status=error` |
| `email` | `Mailer.send` with the gallery link only | job `error` only. Search stays `done` |

`derive` sets `processing` as soon as it starts (not only on success), so photographers see progress. If it fails finally, status becomes `error`.

`search` has no `processing` value. It stays `queued` until `done` or `error`.

Idempotency:

- `derive` / `index`: safe to run again. Index replaces faces for that photo.
- `search`: if `searches.status` is already `done`, the job succeeds without sending another email.
- `email`: a retry may send a second letter. Acceptable for v1.

Object keys:

| object | key |
| --- | --- |
| original | `originals/{eventId}/uploads/{uploadId}` |
| thumb | `derivatives/{eventId}/{photoId}/thumb.jpg` |
| web | `derivatives/{eventId}/{photoId}/web.jpg` |
| selfie | `selfies/{eventId}/{searchId}` |

Bucket `S3_BUCKET` (`rephoto`). No public policy, no public ACL. All reads go through 15-minute signed URLs.

Selfie deletion is mandatory on both search success and search failure, including process crashes recovered by a retry: the retry deletes the object if `selfie_key` is still set, then nulls it. The selfie is never indexed.

Gallery link in the `gallery_ready` mail (even when there are zero matches):

```text
${PUBLIC_WEB_URL}/eventi/${eventSlug}/galleria
```

Subject: `Le tue foto sono pronte`. Body: that URL and nothing else. No attachments, no image parts.

## 5. Mailer

```ts
interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}
```

- `MAIL_TRANSPORT=smtp`: SMTP to `MAILPIT_SMTP_HOST`:`MAILPIT_SMTP_PORT` (Mailpit). No auth locally.
- `MAIL_TRANSPORT=ses`: SES in `eu-central-1`.
- Messages are `text` only. Never attach photos or the selfie.

Login and photographer-invite mails are sent inside the API request. Only `gallery_ready` uses the `email` job.

## 6. Data model

The API agent writes SQL. No embedding / vector column anywhere. Columns:

### `users`

`id uuid pk`, `email text not null unique`, `role text not null` (`participant`|`photographer`|`admin`), `created_at timestamptz not null default now()`

### `sessions`

`id uuid pk`, `user_id uuid not null` → users on delete cascade, `token_hash text not null unique`, `expires_at timestamptz not null`, `created_at timestamptz not null default now()`

### `magic_links`

`id uuid pk`, `user_id uuid not null`, `event_id uuid null`, `email text not null`, `token_hash text not null unique`, `request_ip text null`, `expires_at timestamptz not null`, `used_at timestamptz null`, `created_at timestamptz not null default now()`

### `consents`

`id uuid pk`, `user_id uuid not null`, `event_id uuid not null`, `text_version text not null`, `accepted boolean not null` check `accepted`, `ip text not null`, `user_agent text not null`, `accepted_at timestamptz not null default now()`

### `events`

`id uuid pk`, `slug text not null unique`, `name text not null`, `retention_days int not null default 90`, `consent_text_version text not null`, `consent_text text not null`, `created_at timestamptz not null default now()`

### `event_memberships`

Needed because invite and upload are per event. `user_id uuid`, `event_id uuid`, `created_at timestamptz not null default now()`, primary key `(user_id, event_id)`.

### `photos`

`id uuid pk`, `event_id uuid not null`, `photographer_user_id uuid not null`, `filename text not null`, `content_type text not null`, `byte_size bigint not null`, `sha256 text not null`, `object_key text not null`, `status text not null`, `error text null`, `created_at timestamptz not null default now()`, unique `(event_id, sha256)`

### `derivatives`

`id uuid pk`, `photo_id uuid not null` on delete cascade, `kind text not null` (`thumb`|`web`), `object_key text not null`, `content_type text not null`, `byte_size bigint not null`, unique `(photo_id, kind)`

### `faces`

`id uuid pk`, `photo_id uuid not null`, `event_id uuid not null`, `external_face_id text not null`, `bbox_left double precision not null`, `bbox_top double precision not null`, `bbox_width double precision not null`, `bbox_height double precision not null`, `confidence double precision not null`, unique `(event_id, external_face_id)`. **No embedding column.**

### `face_index`

Fake engine only. `external_face_id text pk`, `photo_id uuid not null`, `event_id uuid not null`, `r smallint not null`, `g smallint not null`, `b smallint not null`, unique `(event_id, photo_id)`.

### `galleries`

`id uuid pk`, `user_id uuid not null`, `event_id uuid not null`, `search_id uuid null`, `updated_at timestamptz not null`, unique `(user_id, event_id)`

### `gallery_items`

`id uuid pk`, `gallery_id uuid not null` on delete cascade, `photo_id uuid not null`, `user_id uuid not null`, `score double precision not null`, unique `(gallery_id, photo_id)`

### `upload_sessions`

`id uuid pk`, `event_id uuid not null`, `user_id uuid not null`, `filename text not null`, `content_type text not null`, `byte_size bigint not null`, `sha256 text not null`, `object_key text not null`, `part_size int not null`, `status text not null` (`open`|`completed`|`aborted`), `created_at timestamptz not null default now()`

### `searches`

`id uuid pk`, `user_id uuid not null`, `event_id uuid not null`, `status text not null`, `selfie_key text null`, `error text null`, `request_ip text null`, `created_at timestamptz not null default now()`, `finished_at timestamptz null`

### `jobs`

`id uuid pk`, `type text not null`, `payload jsonb not null`, `status text not null default 'queued'` (`queued`|`running`|`done`|`error`), `attempts int not null default 0`, `max_attempts int not null default 5`, `run_at timestamptz not null default now()`, `locked_at timestamptz null`, `locked_by text null`, `last_error text null`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`

### `audit_log`

`id uuid pk`, `actor_user_id uuid null`, `action text not null`, `entity_type text not null`, `entity_id uuid null`, `metadata jsonb not null default '{}'`, `ip text null`, `created_at timestamptz not null default now()`

Write an audit row for: `consent.accepted`, `photo.deleted`, `participant.deleted`, `retention.purged`, `photographer.invited`. Metadata must not contain image bytes, tokens, or biometric templates.

### Seed

On API startup, if missing:

- Event `slug=demo` (from `EVENT_SLUG`), `name=Conferenza europea`, `retention_days=90`, `consent_text_version=2026-10-06`, `consent_text` as in §3.2.
- User `email=ADMIN_EMAIL`, `role=admin`. No password. They sign in with a magic link.

## 7. Security

- Zod on every JSON body and on env at process start.
- Signed URLs expire after 15 minutes. Presigned upload part URLs too.
- Secrets only via env. `.env` is gitignored. `.env.example` has placeholders only.
- Rate-limit magic links and selfies as in §3.1 and §3.2.
- Helmet-style headers on every API response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`. `Strict-Transport-Security` only when `PUBLIC_WEB_URL` is `https`.
- Buckets are private. MinIO init creates `rephoto` and does not set an anonymous policy.
- Do not log tokens, cookies, `SESSION_SECRET`, selfie bytes, or face ids at info level.
- Admin responses never include vectors. There is no vector column to return.

## 8. UI notes for the web agent (not implemented here)

Language: Italian. Mobile-first, light, airy, one primary action per screen.

Routes the mails already point at:

- `/verifica?token=` reads the token and `POST /api/auth/verify`
- `/eventi/:slug/galleria` is the gallery

The web server proxies `/api` to `http://api:3001` (compose) or `http://localhost:3001` (host).

## 9. Scale

Target: 6000 users, 100–150k JPEG/PNG, about 1.2 TB. One Postgres, one private bucket, one face collection per event, a `jobs` table locally and one SQS queue in production. Do not add search clusters, GPU nodes, or a second queue.
