# RePhoto contracts

Frozen v5 contract. Clarify wording only by editing this file in a follow-up; do not rename fields, routes, env vars, table columns, or job payload keys. This file describes the code as it is; `docs/v2-spec.md`, `docs/v3-uploader-spec.md`, `docs/v4-selfhost-spec.md` and `docs/v5-test-readiness-spec.md` (with its analysis `docs/test-readiness.md`) are the design notes that led to it and are not authoritative where they differ from this file (known deviations: original-stage `init` for a photo whose original is already present is `409`, not `400`; the InsightFace engine checks its table on first use, not at boot; the v5 spec's `MAGIC_LINK_PER_EMAIL` has no "0 = off" but the code treats 0 as off for both magic-link limits; `admin/photos/requeue` has no shared Zod schema, it is parsed in `routes.ts`).

v5 is additive: the test-campaign tooling (admin console, match log, kept selfies, importer, evaluation scripts) sits next to the v4 flows. Three v5 behaviours change what a v4 reader expects and are called out where they apply: the selfie **vector is stored** on the gallery (`galleries.query_embedding`) so later uploads attach even when nothing matched at selfie time; `index` detects on a **2560 px** rendition of the original, not on the 1600 px web derivative; the recognition thresholds moved to **0.50 / 0.70**.

Primary deployment: one self-hosted VPS (`deploy/`), no AWS: InsightFace on CPU behind an HTTP service, vectors in Postgres + pgvector, objects in MinIO, mail through a provider's SMTP. `S3_REGION` / `AWS_REGION` stay the literal `eu-central-1` (SigV4 needs a region string; the AWS adapters refuse anything else). No Qdrant. No GPU. No SQS: the queue is the Postgres `jobs` table on every path, local, VPS and AWS.

## Monorepo

npm workspaces (`apps/*`, `packages/*`):

| Path | Package | Role |
| --- | --- | --- |
| `apps/api` | `@rephoto/api` | Hono on Node, port **8787**. HTTP only. Runs migrations and the demo seed at boot. |
| `apps/worker` | `@rephoto/worker` | Polls Postgres `jobs`, `WORKER_CONCURRENCY` jobs in flight. No HTTP server. Runs migrations and the demo seed at boot. |
| `apps/web` | `@rephoto/web` | Next.js, port **3000**, Italian UI, `output: "standalone"`. Proxies `/v1/*` to the API. |
| `packages/contracts` | `@rephoto/contracts` | Zod schemas (HTTP, jobs, env), `FaceEngine` input **types**, `objectKeys`, `rekognitionCollectionId`, `DEFAULT_MATCH_THRESHOLD`. No AWS SDK. |
| `packages/db` | `@rephoto/db` | SQL migrations, `migrate`, `seedDemo`, `PostgresDatabase`, `MemoryDatabase` (tests). |
| `packages/face-engine` | `@rephoto/face-engine` | `FaceEngine` implementations (`fake`, `rekognition`, `insightface`) and the per-process rate limiter. The only package that imports the Rekognition SDK; the only one that talks to `face_vectors`. |
| `apps/face-service` | (Python, not an npm workspace) | FastAPI + onnxruntime + insightface on CPU, port **8090**. Embeddings and the optional silent-face liveness check. No persistence. See *`FACE_ENGINE=insightface`*. |

Outside the workspaces: `deploy/` (production Compose stack, Caddyfile, scripts; `compose.test.yml` + `scripts/status.sh` + `scripts/reset-event.sh` for the test campaign), `infra/cdk` (AWS stack, kept as an alternative, own `package.json`), `scripts/loadtest` (k6), `scripts/ingest` (server-side importer, `npm run ingest`), `scripts/seed-test.ts` (`npm run seed:test`), `scripts/eval` (Python: `offline-search.py`, `evaluate.py`, `synth.py`, the null-selfie protocol).

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
  /** v5: raw cosine (-1..1) when the engine has one (InsightFace, fake); absent for Rekognition. */
  cosine?: number;
}

export interface SearchFacesInput { eventId: string; externalFaceId: string }

export interface LivenessInput { imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }
export interface LivenessResult { live: boolean; score: number /* 0..1 */; method: string /* "silent-face" | "none" */ }

// v5
export interface EmbedSelfieInput { imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }
export interface SelfieFace { bbox: Box; score: number /* 0..1 */; quality: number /* 0..1 */; embedding: number[] }
export interface EmbedSelfieResult { faces: SelfieFace[]; width: number; height: number } // pixel size the engine detected on; 0 when unknown
export interface SearchByVectorInput { eventId: string; embedding: number[]; minCosine?: number; maxFaces?: number }
export type VectorHit = SearchHit & { cosine: number };

export interface FaceEngine {
  indexPhoto(input: { eventId: string; photoId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<IndexedFace[]>;
  search(input: { eventId: string; imageBytes: Uint8Array; contentType: "image/jpeg" | "image/png" }): Promise<SearchHit[]>;
  /** Faces of the event similar to an already indexed face. The input face itself is excluded. */
  searchFaces(input: SearchFacesInput): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
  deleteCollection(eventId: string): Promise<void>;
  /** Presentation-attack check on a selfie. Optional: only the InsightFace engine implements it. */
  checkLiveness?(input: LivenessInput): Promise<LivenessResult>;
  /** v5. Faces of a selfie with their embeddings, nothing stored. InsightFace and fake; Rekognition falls back to `search`. */
  embedSelfie?(input: EmbedSelfieInput): Promise<EmbedSelfieResult>;
  /** v5. Nearest faces of the event to a raw embedding, raw cosine on every hit. */
  searchByVector?(input: SearchByVectorInput): Promise<VectorHit[]>;
  /** v5. Stored embedding of an indexed face, null when unknown. Used by `attach` for the selfie-vector path. */
  faceEmbedding?(input: SearchFacesInput): Promise<number[] | null>;
}
```

`@rephoto/face-engine` also exports `cosineSimilarity(a, b)` (plain dot product over norms, 0 when either vector is empty or zero) and `fakeEmbedding` for tests. The three optional v5 methods are implemented by `InsightFaceEngine` and `FakeFaceEngine`; the Rekognition adapter has none of them, so with `FACE_ENGINE=rekognition` the `match` job keeps the v4 path (`search`, no selfie gate, no stored vector) and `attach` uses anchors only.

`FACE_ENGINE` is exactly one of `fake` | `rekognition` | `insightface`. Rules common to every engine:

- The engine speaks a **0–100** similarity scale. The worker divides engine confidence and similarity by 100 before writing Postgres. `faces.confidence` and `gallery_items.score` are **0–1**. A gallery row is kept only when its score is `>= DEFAULT_MATCH_THRESHOLD` (**0.8**); the gallery UI splits at **0.9** («Le tue foto» / «Forse sei tu»).
- Boxes are `{ left, top, width, height }` normalized 0..1. Postgres stores the same box as `{ x, y, width, height }`.
- `externalFaceId` is the engine's face id (Rekognition `FaceId`, `face_vectors.external_face_id`, or `fake-{photoId}`). It is **not** the photo id. `SearchHit.photoId` is the photo the face was indexed from.
- A selfie is never passed to `indexPhoto`; the worker refuses to index an object under `selfies/`.
- `index` sends, with `FACE_INDEX_SOURCE=original` (the default for `insightface`), a **detection JPEG** rendered by the worker from the original (EXIF-oriented, long edge `FACE_DETECT_LONG_EDGE`, default **2560**, quality 85, shrunk until it fits 8 MiB for the face service or 5 MB for Rekognition) or from `web/{photoId}.jpg` while the original is still `pending`; nothing is cached, the bytes exist for one request. With `FACE_INDEX_SOURCE=web` (the default for `fake` and `rekognition`) it sends `web/{photoId}.jpg` (long edge 1600, JPEG quality 80), re-encoded smaller when that derivative exceeds 5 MB, as in v4. `faces.bbox` is normalised either way, so nothing downstream depends on the choice. `match` builds an EXIF-oriented JPEG under 5 MB from the selfie (long edge 2048 down to 480, quality 85 down to 55). Selfie uploads may be up to 8 MiB; the shrink is in the worker.
- `deleteFaces` with an empty list is a no-op. `deleteCollection(eventId)` removes everything the engine holds for that event.
- **Embeddings.** Raw embeddings are persisted in exactly two places, both only when `FACE_ENGINE=insightface`: the `face_vectors` table (one row per indexed face of an event photo) and, from v5, `galleries.query_embedding` (the vector of the participant's **selfie**, one per gallery, written by `match`, read by `attach`). Never in `faces`, never in logs, never in object storage, never in the HTTP API (`match_hits` stores cosines, not vectors). A `face_vectors` row lives as long as its photo: `deleteFaces` (admin delete, re-index, retention, reset), `deleteCollection` (retention on an empty event, reset) and, since 006, the `on delete cascade` foreign key to `photos` remove it. A `query_embedding` lives as long as its gallery row: it is replaced by every `match`, and goes with `DELETE /v1/admin/galleries/:userId/:eventId`, `DELETE /v1/admin/participants/:id` and the `reset` job. Retention does **not** clear it (galleries survive retention, see *Jobs*). With Rekognition the vectors live only in the AWS collection and `query_embedding` stays null; with `fake` the memory store holds the number arrays.

### `FACE_ENGINE=rekognition`

- `REKOGNITION_MIN_SIMILARITY` defaults to **90** (0–100) and is applied inside the adapter as `FaceMatchThreshold` for both `SearchFacesByImage` and `SearchFaces`; hits below it are dropped again client-side.
- Rekognition `BoundingBox` (`Left`, `Top`, `Width`, `Height`, already 0..1) maps to `{ left, top, width, height }`.
- Rekognition `ExternalImageId` is the **photoId** unchanged. `SearchHit.photoId` is that value.
- `search` = `SearchFacesByImage` on selfie bytes; `searchFaces` = `SearchFacesCommand({ CollectionId, FaceId, MaxFaces, FaceMatchThreshold })` on a face already in the collection. Both use `MaxFaces = REKOGNITION_SEARCH_MAX_FACES` (default **500**, 1–4096). `IndexFaces` uses `MaxFaces = 50`, `QualityFilter = AUTO`. A missing collection or face (`ResourceNotFoundException`) makes `search`, `searchFaces`, `deleteFaces` and `deleteCollection` succeed with no hits.
- `deleteFaces` deletes by `externalFaceId` inside the event collection, chunked at 4096 ids. An empty list is a no-op.
- `deleteCollection(eventId)` deletes that event's Rekognition collection.
- `IndexFaces`, `SearchFacesByImage` are called with image **bytes**, which Rekognition caps at **5 MB** (hence the worker shrink above).
- Throttling (`ProvisionedThroughputExceededException`, `ThrottlingException`, `TooManyRequestsException`) is rethrown as `RekognitionThrottleError`; any other Rekognition error is rethrown with image bytes stripped from the message. `AWS_REGION` other than `eu-central-1` makes the adapter throw at construction.
- No `checkLiveness`: with `LIVENESS_CHECK=true` the `match` job simply skips the check.

### `FACE_ENGINE=insightface`

`InsightFaceEngine` (`packages/face-engine/src/insightface.ts`): embeddings from the HTTP face service, storage and nearest-neighbour search in Postgres + pgvector, in the **same database** as the app (`DATABASE_URL`, own `postgres` client, `max: 4`, one client per URL per process).

**Face service HTTP contract** (`apps/face-service`, port 8090, no persistence, image bytes never logged):

| Method | Path | Input | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200 { ok: true, model: "buffalo_l", providers: ["CPUExecutionProvider"] }`; `503 { ok: false }` while the model is not loaded |
| `GET` | `/metrics` | | `200` `text/plain`, one `name value` per line (v5): `face_service_model`, `_providers`, `_uvicorn_workers`, `_model_concurrency`, `_decode_concurrency`, `_det_size`, `_det_long_edge`, `_uptime_seconds`, `_embed_requests_total`, `_embed_errors_total`, `_embed_faces_detected_total`, `_embed_faces_returned_total`, `_embed_latency_window`, `_embed_latency_ms_p50` / `_p95` / `_max`, `_liveness_requests_total`, `_liveness_errors_total`, `_liveness_latency_ms_p50` / `_p95`. Percentiles over the last **500** calls (decode + inference, upload excluded). Counters are **per process**: with `UVICORN_WORKERS > 1` the answer is the worker that served the scrape. No Prometheus client; not exposed by Caddy |
| `POST` | `/v1/embed` | multipart `image` (JPEG/PNG, ≤ 8 MiB, ≤ 120 MP); query `max_faces` 1–**150** (default 150, `MAX_FACES_CAP`), `min_size` px (default 20) | `200 { width, height, faces: [{ bbox: { left, top, width, height } /* 0..1 */, score /* detector 0..1 */, quality /* 0..1 */, embedding: number[512] /* L2-normalised */, norm /* v5: L2 norm of the raw ArcFace output, typically 15–35 */, yaw /* v5: [-1, 1] or null */ }] }` sorted by bbox area desc |
| `POST` | `/v1/liveness` | multipart `image` | `200 { live: boolean, score: 0..1, method: "silent-face" \| "none" }` |

- Decoding: Pillow, EXIF-oriented, at most `DECODE_CONCURRENCY` (default 4) decodes in flight per process; long edge resized to **`DET_LONG_EDGE`** (default **2560**; 1600 was the v4 value) before detection; `width` / `height` are the oriented original's, `bbox` is normalised against them. `quality = min(1, bbox_long_edge_px / 80) × score`, computed on the resized image (so the same face scores higher at 2560 than at 1600); faces with long edge < `min_size` on that image are dropped. `norm` is the pre-normalisation embedding norm (low = blurred, occluded or tiny face; it does not enter `quality`); `yaw = (nose_x − eye_centre_x) / eye_distance` from the five SCRFD landmarks, clamped to [−1, 1], **positive = nose towards the image's right edge**, `null` without landmarks. The engine reads neither `norm` nor `yaw` yet. Model pack `buffalo_l` (SCRFD detector + ArcFace `w600k_r50`, 512-d), onnxruntime CPU, `ONNX_THREADS` intra-op threads (default CPU count), `DET_SIZE` **1024** (640 in v4), `UVICORN_WORKERS` processes (default 1, read by the Dockerfile `CMD`; each loads its own model, ≈ 1–1.5 GB RSS), `asyncio.Semaphore(MODEL_CONCURRENCY)` (default 2) around the model per process. Models are downloaded at **image build** into `/models`; the running container needs no network. `deploy/compose.yml` and the root `docker-compose.yml` map these to `FACE_SERVICE_WORKERS`, `FACE_DET_SIZE`, `FACE_DET_LONG_EDGE`, `FACE_MODEL_CONCURRENCY`, `FACE_DECODE_CONCURRENCY`.
- Errors: `400 { detail: { code: "undecodable_image" | "empty_image" } }`, `413` (`payload_too_large` > 8 MiB, `image_too_large` > 120 MP), `422` (bad query / missing field), `503` (`model_not_loaded`). Bodies never echo image bytes.
- `/v1/liveness`: MiniFASNet (Silent-Face-Anti-Spoofing architecture) ONNX weights from `hairymax/Face-AntiSpoofing` (pinned commit, SHA-256 verified at build; that repository publishes **no licence file**). Largest detected face, square crop 1.5× the bbox, 128×128; `score` = P(live), `live = score ≥ LIVENESS_THRESHOLD` (default 0.5); no face → `{ live: false, score: 0 }`. Built with `--build-arg WITH_LIVENESS=0`, or with `LIVENESS_MODEL` pointing nowhere, the endpoint always answers `{ live: true, score: 0, method: "none" }`.

**Engine environment** (parsed by `envSchema`; `createFaceEngine` reads the same names from `process.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACE_SERVICE_URL` | `http://localhost:8090` | Base URL of the face service, `http(s)` only, trailing slashes stripped |
| `INSIGHTFACE_MIN_COSINE` | `0.50` (v4: 0.45) | Cosine below which a pair is not a match (0–1) |
| `INSIGHTFACE_SURE_COSINE` | `0.70` (v4: 0.65) | Cosine at/above which the pair is certain (0–1); must be `> MIN`, else boot fails |
| `INSIGHTFACE_ATTACH_MIN_COSINE` | `0.55` | v5. `attach`: an anchor ↔ face cosine below this never adds a photo to a gallery (read by the worker, not by the engine) |
| `INSIGHTFACE_ANCHOR_MIN_COSINE` | = `INSIGHTFACE_SURE_COSINE` | v5. `match`: only hits at or above this cosine become anchors (worker) |
| `INSIGHTFACE_MAX_FACES` | `200` (v4: 500) | Rows returned by `search` / `searchFaces` / `searchByVector` (1–4096) |
| `INSIGHTFACE_INDEX_MAX_FACES` | `100` | v5. `max_faces` asked of `/v1/embed` by `indexPhoto`, `search` and `embedSelfie` (1–150; the engine refuses more at construction) |
| `INSIGHTFACE_MIN_FACE_QUALITY` | `0.2` (v4: 0.3) | Faces with service `quality` below this are not indexed (0–1) |
| `FACE_INDEX_TPS`, `FACE_SEARCH_TPS` | `20`, `20` | Rate limiter buckets per process (see *Rate limiter*) |
| `LIVENESS_CHECK` | `false` | Read by the **worker** `match` job, not by the engine (see *Jobs*) |
| `SELFIE_MIN_FACE_PX`, `SELFIE_MIN_QUALITY` | `120`, `0.6` | v5. Selfie gate in the worker `match` job (see *Jobs*), not read by the engine |
| `FACE_INDEX_SOURCE`, `FACE_DETECT_LONG_EDGE` | `original` for insightface (`web` otherwise), `2560` | v5. What the worker `index` job sends (see the rules above); `FACE_DETECT_LONG_EDGE` is 640–8192 |

Engine constants (not env): `INDEX_MIN_FACE_SIZE = 24` (`min_size` sent on every `/v1/embed`), `EMBED_TIMEOUT_MS = 60 000` (`AbortSignal.timeout` on `/v1/embed` and `/v1/liveness`; a timeout is a `FaceServiceUnavailable`), `HEALTH_TIMEOUT_MS = 10 000` (`health()`), `SEARCH_MAX_FACES_CAP = 4096`, `DELETE_FACES_CHUNK = 1000`, `MIN_EF_SEARCH = 100`.

**Similarity mapping (frozen).** The rest of the system expects 0–100 with the worker threshold 0.8 and the gallery "sure" boundary 0.9. For a cosine `c` (`1 - (embedding <=> query)`, vectors are unit-norm):

```text
c <  MIN                → dropped (not a hit)
c >= MIN                → similarity = 80 + 20 × clamp((c − MIN) / (SURE − MIN), 0, 1)
```

So `MIN ↔ 80`, `SURE ↔ 100`, and the gallery's 0.9 boundary sits halfway (`c = (MIN + SURE) / 2`, **0.60** with the v5 defaults; 0.55 with the v4 ones). `IndexedFace.confidence = score × 100`. `mapCosine(c, min, sure)` is exported and unit-tested; the worker's `cosineScore` (`apps/worker/src/handlers.ts`) applies the same formula on the 0–1 scale for the selfie-vector `attach` path; nothing else in the repo maps cosines. Since v5 every InsightFace hit also carries the raw `cosine`, and `searchByVector` may be asked for hits **below** `MIN` (`minCosine` option; the worker uses 0.25 with `MATCH_LOG=true`): those come back with `similarity = 0` and are never a match, only a record.

**Storage.** Migration `packages/db/migrations/005_face_vectors.sql`:

```sql
create extension if not exists vector;
create table face_vectors (
  external_face_id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  photo_id uuid not null,
  embedding vector(512) not null,
  created_at timestamptz not null default now()
);
create index face_vectors_event_idx on face_vectors (event_id);
create index face_vectors_photo_idx on face_vectors (photo_id);
create index face_vectors_embedding_idx on face_vectors using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
```

The migration wraps this in a `DO` block: when `create extension` fails (plain `postgres:16` image) it raises a `NOTICE`, creates nothing, and is still recorded in `schema_migrations`, so `migrate()` never aborts. Migration `006_recognition.sql` (v5) adds, in the same guarded way, `galleries.query_embedding vector(512) null` with `galleries_query_embedding_idx` (HNSW, cosine, `m = 16, ef_construction = 64`), deletes `face_vectors` rows whose photo no longer exists and adds `face_vectors_photo_id_fkey` (`photo_id references photos(id) on delete cascade`). **Self-healing rule** (`InsightFaceEngine.ready()`, run once per process on first use): `select to_regclass('public.face_vectors')`; when the table is missing the engine runs `create extension if not exists vector` plus the same DDL (`create table if not exists` / `create index if not exists`, and the foreign key when `photos` exists) in one transaction. Only a failing `create extension` is fatal: `FaceVectorsTableMissing`, whose message names the database (credentials redacted) and the `pgvector/pgvector:pg16` image. No `faces`-table row references `face_vectors`; the link is `faces.external_id = face_vectors.external_face_id::text`. The database layer checks `galleries.query_embedding` with `to_regclass`-style introspection (`queryVectorAvailable`) and degrades to the anchor-only behaviour when the column is missing.

**Exact SQL** (constants in `insightface.ts`, positional parameters):

```sql
-- indexPhoto (v5): inside one transaction, the photo's previous rows go first, so a
-- re-run (reclaimed job, re-index) never leaves duplicates or orphans
delete from face_vectors
where photo_id = $1::uuid;
-- then one row per kept face, ids returned in input order
insert into face_vectors (event_id, photo_id, embedding)
select $1::uuid, $2::uuid, input.embedding::vector
from unnest($3::text[]) with ordinality as input(embedding, ord)
order by input.ord
returning external_face_id;

-- search (selfie) and searchByVector: inside one transaction, after `set local hnsw.ef_search = max(100, $3)`
select external_face_id, photo_id, 1 - (embedding <=> $1::vector) as cos
from face_vectors
where event_id = $2::uuid
order by embedding <=> $1::vector
limit $3;

-- searchFaces (attach): same, minus the anchor face
select external_face_id, photo_id, 1 - (embedding <=> $1::vector) as cos
from face_vectors
where event_id = $2::uuid and external_face_id <> $4::uuid
order by embedding <=> $1::vector
limit $3;

-- vector of an indexed face (searchFaces input, faceEmbedding); unknown id → no hits / null
select embedding::text as embedding from face_vectors where external_face_id = $1::uuid and event_id = $2::uuid;

-- deleteFaces, chunks of 1000 ids
delete from face_vectors where event_id = $1::uuid and external_face_id = any($2::uuid[]);

-- deleteCollection
delete from face_vectors where event_id = $1::uuid;

-- db.findGalleriesByQueryVector (packages/db, not the engine): galleries whose selfie vector is close to a face
select id, user_id, anchor_face_ids, notified_at, 1 - (query_embedding <=> $1::vector) as cos
from galleries
where event_id = $2::uuid and query_embedding is not null
  and 1 - (query_embedding <=> $1::vector) >= $3
order by query_embedding <=> $1::vector;
```

Behaviour:

- `indexPhoto`: `POST /v1/embed?max_faces=${INSIGHTFACE_INDEX_MAX_FACES}&min_size=24`; keep faces with a 512-number finite embedding and `quality ≥ INSIGHTFACE_MIN_FACE_QUALITY`; one transaction: delete the photo's previous rows, then one insert for all kept faces; returns `{ externalFaceId = row uuid, bbox (clamped 0..1), confidence = score × 100 }`. Service `400`, or no kept face → the delete still runs and `[]` is returned (photo without a decodable image, or without faces: indexed with zero faces).
- `search`: embed the selfie (same `max_faces` / `min_size`), take the **largest** face by bbox area (none → `[]`), nearest-neighbour query with `limit = INSIGHTFACE_MAX_FACES`, keep `cos ≥ MIN`, map to similarity, `cosine` on every hit. `searchFaces`: the stored vector of `externalFaceId` within the event, excluding itself; unknown id → `[]`.
- `embedSelfie` (v5): same `/v1/embed` call; returns every face with a well-formed embedding, in detection order, `bbox` clamped, `score` / `quality` clamped to 0..1, plus the service's `width` / `height`; **no quality filter** (the worker's gate decides); service `400` → `{ faces: [], width: 0, height: 0 }`.
- `searchByVector` (v5): the nearest-neighbour query on a caller-supplied 512-d vector (anything else throws), `minCosine` (default `MIN`) and `maxFaces` (default `INSIGHTFACE_MAX_FACES`, capped at 4096) from the input; `ef_search = max(100, limit)`.
- `faceEmbedding` (v5): the stored vector parsed back to `number[]`, `null` when unknown or malformed. `health()`: `GET /health` within 10 s, `false` on any failure (used by nothing in the worker; the API's `admin/metrics` probes the service with its own 2 s `fetch`).
- `checkLiveness`: `POST /v1/liveness`; `400` → `{ live: true, score: 0, method: "none" }` (the search will find no face either); the body's `live` is read as `!== false`.
- Errors: bytes over 8 MiB → `FaceServiceError(413)` before any round trip; connection failure, service `5xx` or the 60 s timeout → `FaceServiceUnavailable` (v5: **requeued** by the worker without counting an attempt, and counted by the circuit breaker, see *Jobs*); other `4xx` → `FaceServiceError(status)` with the body sanitised to printable ASCII, 200 chars. The worker treats a `FaceServiceError` with status **400, 413 or 422** as **non-retryable** (`FACE_SERVICE_DEFINITIVE_STATUSES` in `apps/worker/src/handlers.ts`: `failTerminal` on the first attempt, `applyFinalFailure`); any other status retries. Neither error type ever contains image bytes.
- Tests: `packages/face-engine/src/insightface.test.ts` (stubbed `fetch` and `sql`: mapping, filtering, chunking, error names, `searchByVector`, delete-before-insert, timeout); `insightface.integration.test.ts` runs only when `DATABASE_URL` points at a pgvector database and `FACE_SERVICE_URL` answers `/health`, otherwise skips with the reason. Service tests: `apps/face-service/tests` (`pytest`; the real-model tests skip when the pack cannot be loaded).

### Rate limiter

`createFaceEngine(env)` wraps the remote engines in `RateLimitedFaceEngine`: two token buckets per **process**, one for `indexPhoto` and one shared by `search`, `searchFaces`, `searchByVector`, `embedSelfie` and `checkLiveness` (each optional method exposed only when the inner engine has it). Capacity is `max(1, ceil(tps))`, refill is continuous, waiters are FIFO. Deletes and `faceEmbedding` (a local row read) are not limited. The fake engine is not wrapped.

| Engine | Index bucket | Search bucket |
| --- | --- | --- |
| `rekognition` | `REKOGNITION_INDEX_TPS` (default 5); `FACE_INDEX_TPS` honoured when the Rekognition name is blank | `REKOGNITION_SEARCH_TPS` (default 5); `FACE_SEARCH_TPS` as fallback |
| `insightface` | `FACE_INDEX_TPS` (default 20) | `FACE_SEARCH_TPS` (default 20) |

With N worker instances the aggregate rate is N times these values. For Rekognition the quota is per account, so set the envs to `quota / instances`; for InsightFace the limit only protects the face service from a burst (its own semaphore of 2 is the real cap) and 20/20 with two workers is fine.

### Collection id (frozen function, Rekognition only)

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
- v5: the fake engine also implements `embedSelfie`, `searchByVector` and `faceEmbedding` on a synthetic 512-d vector derived from the key (`fakeEmbedding`), so the worker's selfie gate, anchors and selfie-vector `attach` are exercised by `apps/worker/test/v5.test.ts` without the face service. `MemoryDatabase` keeps `query_embedding` as a `number[]`.
- `deleteFaces` removes those ids from the store and does not itself delete `faces` rows (the caller does).
- `deleteCollection` removes every `face_index` row for that event.

## Environment

`.env.example` only. Never commit real secrets. Parsed by `envSchema` in `packages/contracts/src/env.ts`; the API and the worker refuse to boot on an invalid value.

| Variable | Local value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://rephoto:rephoto@localhost:5432/rephoto` | Required |
| `DATABASE_POOL_MAX` | `10` | Pool size per process (`postgres` `max`). The API passes it to `createSql`; the worker uses the default 10. Keep `api × pool + worker × pool` under the RDS limit |
| `S3_ENDPOINT` | `http://localhost:9000` | Optional; omit on ECS so the task role is used. On the VPS: `http://minio:9000` (compose-internal) |
| `S3_PUBLIC_ENDPOINT` | unset locally; `https://media.<domain>` on the VPS | Optional URL. When set, **every presigned URL** (GET, PUT, `UploadPart`) is signed by a second `S3Client` with this endpoint and `forcePathStyle: true`; every other operation keeps using `S3_ENDPOINT`. SigV4 covers `Host`, so the proxy in front of MinIO must pass the original `Host` through |
| `S3_BUCKET` | `rephoto` | Required |
| `S3_ACCESS_KEY` | `rephoto` | Required only when `S3_ENDPOINT` is set |
| `S3_SECRET_KEY` | `rephoto-secret` | Local MinIO only; required only when `S3_ENDPOINT` is set |
| `S3_REGION` | `eu-central-1` | Literal; any other value is rejected (used only as the SigV4 region string with MinIO) |
| `S3_FORCE_PATH_STYLE` | `true` | Default `true` when `S3_ENDPOINT` is set, `false` on real AWS |
| `SESSION_SECRET` | long random string (min 16 chars) | Dev placeholder in `.env.example` |
| `FACE_ENGINE` | `fake` locally (default), `insightface` on the VPS, `rekognition` on AWS | Exactly one of `fake` \| `rekognition` \| `insightface` |
| `FACE_SERVICE_URL` | `http://localhost:8090` | URL of `apps/face-service`; used only by `insightface` |
| `INSIGHTFACE_MIN_COSINE` | `0.50` | 0–1. Cosine ↔ similarity 80. Default was 0.45 until v4 |
| `INSIGHTFACE_SURE_COSINE` | `0.70` | 0–1, must be `> MIN`. Cosine ↔ similarity 100. Default was 0.65 until v4 |
| `INSIGHTFACE_ATTACH_MIN_COSINE` | `0.55` | v5. 0–1. `attach`: minimum anchor ↔ face cosine (worker) |
| `INSIGHTFACE_ANCHOR_MIN_COSINE` | unset (= `INSIGHTFACE_SURE_COSINE`) | v5. 0–1. `match`: minimum cosine for a hit to become an anchor (worker) |
| `INSIGHTFACE_MAX_FACES` | `200` | 1–4096. Nearest-neighbour `limit`. Default was 500 until v4 |
| `INSIGHTFACE_INDEX_MAX_FACES` | `100` | v5. 1–150. `max_faces` sent to `/v1/embed` |
| `INSIGHTFACE_MIN_FACE_QUALITY` | `0.2` | 0–1. Faces below it are not indexed. Default was 0.3 until v4 |
| `SELFIE_MIN_FACE_PX` | `120` | v5. Integer ≥ 1. `match` gate: long edge of the largest selfie face, in pixels of the image the engine detected on |
| `SELFIE_MIN_QUALITY` | `0.6` | v5. 0–1. `match` gate: engine `quality` of the largest selfie face |
| `FACE_INDEX_SOURCE` | unset (= `original` with `insightface`, `web` otherwise) | v5. `web` \| `original`. What `index` sends to the engine |
| `FACE_DETECT_LONG_EDGE` | `2560` | v5. 640–8192. Long edge of the detection JPEG when `FACE_INDEX_SOURCE=original` |
| `MATCH_LOG` | `false` | v5. `true` makes `match` write `match_runs` / `match_hits` and ask the engine for hits down to cosine 0.25. Test campaign only |
| `KEEP_SELFIES` | `false` | v5. `true` keeps the selfie object after `match` and records its key in `galleries.selfie_key` (enables `admin/galleries/:userId/:eventId/rematch`). Test campaign only, with consent |
| `LOG_IDS` | `false` | v5. `true` adds `photoId` / `userId` / `eventId` to the worker job log lines |
| `FACE_INDEX_TPS` | `20` | Positive number. `indexPhoto` per second **per process** (`insightface`; fallback name for Rekognition) |
| `FACE_SEARCH_TPS` | `20` | Positive number. `search` + `searchFaces` + `searchByVector` + `embedSelfie` + `checkLiveness` per second **per process** |
| `LIVENESS_CHECK` | `false` | `true` makes the worker's `match` job call `checkLiveness` before searching (engines without it: no-op). See *Jobs* |
| `AWS_REGION` | `eu-central-1` | Literal, default `eu-central-1` |
| `REKOGNITION_COLLECTION_PREFIX` | `rephoto-` | |
| `REKOGNITION_SEARCH_MAX_FACES` | `500` | 1–4096. `SearchFacesByImage` and `SearchFaces` |
| `REKOGNITION_MIN_SIMILARITY` | unset (= `90`) | 0–100. Read by the Rekognition adapter directly, not by `envSchema` |
| `REKOGNITION_INDEX_TPS` | `5` | Positive number. `IndexFaces` per second **per worker process** |
| `REKOGNITION_SEARCH_TPS` | `5` | Positive number. `SearchFacesByImage` + `SearchFaces` per second **per worker process** |
| `MAIL_TRANSPORT` | `smtp` (Mailpit) | `smtp` is **nodemailer** (pooled transport, 2 connections per process, 10 s connect / 20 s socket timeouts) towards any provider's SMTP endpoint; `ses` sends with SESv2 in `AWS_REGION` and does not require SMTP host or port |
| `SMTP_HOST` | `localhost` | Required when `MAIL_TRANSPORT=smtp` |
| `SMTP_PORT` | `1025` | Required when `MAIL_TRANSPORT=smtp` |
| `SMTP_USER`, `SMTP_PASSWORD` | unset (Mailpit, no AUTH) | Provider credentials; set both or neither (half-configured → boot fails). Never logged |
| `SMTP_SECURE` | unset | Implicit TLS from the first byte (SMTPS). Default **`true` on port 465**, `false` otherwise |
| `SMTP_STARTTLS` | `auto` | `auto` upgrades with STARTTLS when the server advertises it (`587`) and stays plain otherwise (Mailpit); `true` refuses to send without STARTTLS (`requireTLS`); `false` never upgrades (`ignoreTLS`) |
| `SMTP_FROM` | `noreply@rephoto.local` | Sender for both transports; `Name <addr>` is accepted |
| `MAGIC_LINK_PER_EMAIL` | `3` | v5. Integer ≥ 0. Magic links per e-mail per hour on `request-link`; `0` disables the check |
| `MAGIC_LINK_PER_IP` | `20` | v5. Integer ≥ 0. Magic links per client IP per hour; `0` disables the check |
| `SELFIE_MAX_PER_HOUR` | `5` | v5. Integer ≥ 0. Selfies per participant per hour; `0` disables the check |
| `RATE_LIMIT_EXEMPT_IPS` | empty | v5. Comma-separated IPs or CIDRs (IPv4, IPv4-mapped IPv6, IPv6) whose requests skip both limits above. An entry that does not parse never matches |
| `BOOTSTRAP_ADMINS` | empty | v5. Comma-separated e-mails upserted as `admin` users when the **API** boots (after the demo seed; entries without `@` are skipped). The worker does not read it |
| `SEED_DEMO` | unset locally | `false`, or `NODE_ENV=production`, skips the demo seed |
| `WEB_ORIGIN` | `http://localhost:3000` | Base of e-mailed links; CORS allow-origin; `Origin` check on ZIP; cookie `Secure` when `https:` |
| `API_ORIGIN` | `http://localhost:8787` | |
| `TRUSTED_PROXY_HOPS` | `1` | Integer ≥ 0. How many trusted proxies append to `x-forwarded-for` before the API. See *Client IP* |
| `WORKER_CONCURRENCY` | `4` | 1–32. Jobs in flight per worker process |
| `WORKER_PUBLISH_METRICS` | `false` | `true` publishes `rephoto/QueueDepth` to CloudWatch every 30 s (needs `cloudwatch:PutMetricData`) |

Web-only (Next.js; `NEXT_PUBLIC_*` are inlined at build time):

| Variable | Local value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_EVENT_SLUG` | `demo` | Build-time event slug: the first render of `/selfie`, `/gallery`, `/upload` and `/admin` uses it until `/api/config` answers |
| `EVENT_SLUG` | unset locally | v5, runtime. Read by the web route `GET /api/config` (`{ eventSlug }`, `cache-control: no-store`) at request time, falling back to `NEXT_PUBLIC_EVENT_SLUG` then `demo`; a value that is not a slug (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) is replaced by `demo`. `useEventSlug()` / `loadEventSlug()` (`apps/web/lib/event.ts`) fetch it once per page load. `deploy/compose.yml` sets `NEXT_PUBLIC_EVENT_SLUG=${EVENT_SLUG}` in the web container's runtime env too, so the two agree without a rebuild only when `EVENT_SLUG` itself is changed in `.env.production` and the web container restarted |
| `NEXT_PUBLIC_MEDIA_ORIGINS` | `http://localhost:9000` | Space-separated origins that serve presigned URLs; goes into CSP `img-src` / `connect-src` |
| `NEXT_PUBLIC_WEB_ORIGIN` | `http://localhost:3000` | HSTS is sent when it is `https://` |
| `API_PROXY_TARGET` | `http://localhost:8787` | Where `/v1/*` is forwarded (`NEXT_PUBLIC_API_URL` is the fallback name) |

## Object keys

| Object | Key | Notes |
| --- | --- | --- |
| Original | `originals/{eventId}/{photoId}` | No extra extension. Stored `Content-Type` is the declared one (`image/jpeg` or `image/png`). Absent while `photos.original_status = 'pending'` (the key is reserved at the web stage, see *Two-stage upload*). |
| Thumb | `thumbs/{photoId}.jpg` | Long edge 480, JPEG quality 80, EXIF-rotated. `Cache-Control: public, max-age=86400, immutable`. Always written by the worker (`derive`), from the original or, for a pending photo, from the web derivative. |
| Web | `web/{photoId}.jpg` | Long edge 1600, JPEG quality 80, EXIF-rotated. Written by the worker (`derive`, same `Cache-Control` as the thumb) **or by the browser** at the web stage (presigned PUT bound to `Content-Length` and `image/jpeg`; no `Cache-Control` is set on that object). Not rewritten when the original arrives later. |
| Selfie | `selfies/{eventId}/{userId}/{uuid}` | Deleted by the `match` job once the gallery is written (also on a gate or liveness rejection), **unless `KEEP_SELFIES=true`**: then the object stays and its key is written to `galleries.selfie_key`. |

Derivative `kind` is `thumb` or `web` and matches those keys. The `objectKeys` helper in `@rephoto/contracts` is the only builder.

On `match` success (including zero matches and the v5 rejections), the match job deletes the selfie object before the job is marked `done`. On a thrown search, the object is kept for retry. After the final failed attempt, `applyFinalFailure` deletes the selfie anyway. With `KEEP_SELFIES=true` none of these deletes happen: a kept selfie is removed only by `deploy/scripts/reset-event.sh` (`mc rm selfies/{eventId}/`), never by the `reset` job, `DELETE .../galleries`, `DELETE .../participants` or a later `match` that overwrites `selfie_key` (known gap, see `docs/DPIA.md` §10). The AWS bucket adds a 2-day lifecycle expiry on `selfies/` as a safety net (not applied by MinIO).

Presigned GET URLs (`thumbUrl`, `webUrl`, download) expire after **30 minutes** (`SIGNED_URL_TTL_SECONDS`) and are signed with a `signingDate` rounded down to a **10-minute** window (`SIGNED_URL_WINDOW_SECONDS`), so the same key yields the same URL inside the window and browsers can cache thumbnails. Presigned PUT and `UploadPart` URLs also expire after 30 minutes; the single PUT is bound to the declared `Content-Length` and `Content-Type`. All presigned URLs point at `S3_PUBLIC_ENDPOINT` when it is set (path-style: `https://media.<domain>/<bucket>/<key>`), else at `S3_ENDPOINT` / AWS; the object itself is read and written through `S3_ENDPOINT`.

## Jobs

Jobs live in Postgres table `jobs`. The `JobQueue` interface (`apps/api/src/queue.ts`) is the only seam; swapping the runner must keep these payload shapes.

| `type` | `payload` | `priority` | `dedupe_key` |
| --- | --- | --- | --- |
| `derive` | `{ photoId }` | 50 | `derive:{photoId}` |
| `index` | `{ photoId }` | **40** (60 until v4) | `index:{photoId}` |
| `attach` | `{ photoId }` | 30 | `attach:{photoId}` |
| `match` | `{ userId, eventId, selfieKey }` | 0 | none |
| `email` | `{ userId, eventId, galleryPath, kind: "ready" \| "new" }` | 10 | `email:{kind}:{userId}:{eventId}` |
| `verify` | `{ photoId }` | 70 | `verify:{photoId}` |
| `retention` | `{ eventId, actorId }` | 90 | `retention:{eventId}` |
| `reset` (v5) | `{ eventId, actorId }` | 90 | `reset:{eventId}` |

Lower priority runs first. `index` now runs before `derive` so the face service is fed as soon as a derivative exists instead of idling behind a backlog of derives; `attach` still goes first among the photo jobs. `JOB_PRIORITY` and `jobDedupeKey(type, payload)` are in `packages/contracts/src/jobs.ts`. Every enqueue uses `jobDedupeKey` except `match`, which has no key: a second `retention/run` (or `events/:id/reset`) for the same event while one is queued or running returns the existing job id.

Row: `id`, `type`, `payload` jsonb, `status` (`queued` \| `running` \| `done` \| `error`), `attempts`, `run_after`, `last_error`, `created_at`, `claimed_at`, `priority` smallint default 50, `dedupe_key` text null, and from 006 `finished_at timestamptz null`, `duration_ms int null` (written by `completeJob`, `failJob`, `failJobTerminal` and `requeueJob` as `now()` and `now() − claimed_at` in ms; partial index `jobs_finished_at_idx`; read by `deploy/scripts/status.sh` for throughput and p50/p95 per type).

`enqueueJob(type, payload, { priority?, dedupeKey?, runAfter? })`: `priority` defaults to the table above. With a `dedupeKey` that already has a `queued` or `running` row (partial unique index `jobs_dedupe_active_idx`), the insert is skipped and the existing job id is returned.

Worker claim (one transaction): first, every `running` row whose `claimed_at` (or `created_at` if never claimed) is older than **10 minutes** goes back to `queued` without incrementing `attempts` and without marking the photo `error`. Then one `queued` row with `run_after <= now()` is set to `running`, `claimed_at = now()`, chosen by `priority asc, run_after asc, created_at asc` with `FOR UPDATE SKIP LOCKED` (index `jobs_claim_priority_idx`). v5: `claimJob({ excludeTypes })` skips the listed types (the circuit breaker below passes `index`, `attach`, `match`); while a job runs, the worker calls `touchJob(id)` (`claimed_at = now()`) every **2 minutes** (`HEARTBEAT_MS`), so a long `retention` / `reset` / `index` is never reclaimed as stale by another instance.

Outcomes, in `apps/worker/src/run.ts`:

- Payload that fails its Zod schema → `failTerminal` (`error`, `attempts = 5`, `last_error = "Payload non valido."`), log outcome `invalid`.
- Success → `done`.
- `FaceServiceUnavailable` (service down, unreachable, `5xx` or the 60 s timeout; v5) → `requeue` like a throttle: back to `queued` with `run_after = now() + 5 s`, `attempts` **not** incremented, log outcome `requeued`. The per-process **circuit breaker** (`apps/worker/src/breaker.ts`, `FaceServiceBreaker`) counts consecutive unavailables: at the **5th** it opens for **30 s**, during which the claim excludes `index`, `attach` and `match` (every other type keeps flowing) and one line `{ ts, breaker: "open", pauseMs, paused: [...] }` goes to stderr; any successful face job closes it. In v4 these errors burned attempts and a 5-minute outage with a full queue ended in permanent `error` rows.
- Rekognition throttle (`RekognitionThrottleError`, `ProvisionedThroughputExceededException`, `ThrottlingException`) → `requeue` the same way, without the breaker.
- `NonRetryableError` (`sha256 mismatch`, `unsupported image`) and a `FaceServiceError` with status `400`, `413` or `422` (the face service gave a definitive answer; `isNonRetryable`) → `failTerminal` + `applyFinalFailure`, log outcome `error`.
- Any other error → `attempts + 1`, `last_error`; when `attempts >= 5` (`JOB_MAX_ATTEMPTS`) the row becomes `error` and `applyFinalFailure` runs (log `error`); otherwise back to `queued` with `run_after = now() + attempts × 30 s` (log `retry`).

`applyFinalFailure`: `derive` and `index` set the photo to `error` with `photos.error = last error text`; `match` deletes the selfie object unless `KEEP_SELFIES=true` (then it stays, with no `selfie_key` recorded); other types (`verify`, `reset` included) do nothing: a photo whose `verify` keeps failing stays as it is and keeps serving its web derivative. Photos in `error` can be put back in the pipeline with `POST /v1/admin/photos/requeue` (see *HTTP*).

Pipeline:

1. Upload complete inserts `photos.status = uploaded` and enqueues `derive`. After a web stage the row has `original_status = 'pending'` and the `web` derivative row already points at the client-written object; the later original stage does not enqueue `derive` again, it enqueues `verify` (see *Two-stage upload*).
2. `derive`: sets `processing`. With `original_status = 'present'`: downloads the original, **verifies sha256 against `photos.sha256`** (mismatch → non-retryable), renders `thumb` and `web` (a decode failure → non-retryable `unsupported image`), writes both objects with the derivative `Cache-Control`, upserts `derivatives`, enqueues `index`. With `original_status = 'pending'`: reads `web/{photoId}.jpg` (missing → retryable `Web derivative missing`), renders only `thumb` from it, upserts the `thumb` derivative, leaves the web derivative untouched, no sha256 check, enqueues `index`. Either way the photo is searchable after `index`; `FaceId`s are never recomputed when the original arrives.
3. `index`: no-op when the photo is already `indexed` and has `faces`. Otherwise builds the detection bytes (`FACE_INDEX_SOURCE`, see the engine rules: the 2560 px detection JPEG from the original, or the web derivative), and when the photo already has `faces` (re-index after a reclaim or a requeue) calls `deleteFaces` on their external ids **and `removeAnchors`** (v5: a re-indexed face gets a new id, so galleries anchored on the old one must drop it), calls `indexPhoto` with JPEG bytes, replaces the `faces` rows (confidence ÷ 100), sets `indexed` + `indexed_at = now()`, enqueues `attach`.
4. `attach` (rewritten in v5): no-op when the photo has no `faces` or when `countAnchoredGalleries(eventId)` is 0 (galleries with at least one anchor **or a stored selfie vector**). Otherwise, for each `faces` row of the photo: (a) `searchFaces`; hits on the same photo are ignored; a hit is an **anchor candidate** when its `cosine ≥ INSIGHTFACE_ATTACH_MIN_COSINE` (engines without a cosine: `similarity / 100 >= 0.8`), remembering per hit external id the best (faceId of this photo, score); (b) when the engine has `faceEmbedding`, the face's stored vector is compared with every `galleries.query_embedding` of the event (`findGalleriesByQueryVector`, `cosine ≥ INSIGHTFACE_MIN_COSINE`), remembering per gallery the best **selfie-vector candidate** with `score = cosineScore(cosine)` (same mapping as the engine). Galleries = those whose `anchor_face_ids` overlap the anchor candidates (`findGalleriesByAnchors`, `&&`, GIN index) ∪ those with a selfie-vector candidate. Per gallery: the anchor score is the best among its agreeing anchors, but with **3 or more anchors at least 2 must agree** (`ANCHOR_QUORUM_FROM = 3`, `ANCHOR_QUORUM = 2`), else the anchor path yields nothing; the row written is the better of the anchor score and the selfie-vector score, upserted into `gallery_items` as `(photoId, faceId, score, source = 'attach')` with `score = greatest(existing, new)`. When the row was new and the gallery's `notified_at` is null or older than **6 hours**, enqueue `email` kind `new` (deduped) and set `notified_at = now()`. A photo the participant marked `not_me` is attached again like any other (the verdict is applied at read time, see *HTTP*).
5. `POST .../selfie` stores the selfie object, enqueues `match` and writes `audit_log` `selfie.submitted` (see *HTTP*).
6. `match` (rewritten in v5): shrinks the selfie to an oriented JPEG under 5 MB and hashes the original bytes (`match_runs.selfie_sha256`). **Liveness gate**: when `LIVENESS_CHECK=true` **and** the engine exposes `checkLiveness` (InsightFace only), it is called on those bytes first; `live === false` ends the job as **done with an empty gallery** and `galleries.last_match_reason = 'liveness'`, selfie object deleted (unless `KEEP_SELFIES`), `email` kind `ready` enqueued (the UI shows the reason), log line gains `liveness: "rejected"`. A thrown `checkLiveness` (service down) is an ordinary error: the job retries and the selfie is kept. **Selfie gate** (engines with `embedSelfie` + `searchByVector`, i.e. InsightFace and fake): `embedSelfie`, then `selfieRejectReason` in this order: no face → `no_face`; largest face long edge (bbox × the engine's `width` / `height`; skipped when the engine reports 0) `< SELFIE_MIN_FACE_PX` → `face_too_small`; largest face `quality < SELFIE_MIN_QUALITY` → `low_quality`; a second face with area ≥ 50 % of the largest → `multiple_faces`. A rejection ends the job as done with an empty gallery, `last_match_reason = <reason>`, `query_embedding = null`, selfie deleted (unless `KEEP_SELFIES`), **no `ready` mail**, log `{ match: "rejected", reason }`, and with `MATCH_LOG` a `match_runs` row with 0 hits. Otherwise the query vector is the largest face's embedding and the search is `searchByVector` with `minCosine = INSIGHTFACE_MIN_COSINE` (or **0.25** with `MATCH_LOG=true`, so the log sees the impostor tail; the gallery still keeps only `cosine ≥ MIN`). Engines without those methods (Rekognition) call `search` as in v4, with no gate and no vector. Then: loads the hit faces with one `faces` query (`external_id = any(...)`, index `faces_event_external_idx`) and the hit photos, keeps a hit only when the face belongs to that photo, the photo is in the event and `indexed`, and `cosine ≥ INSIGHTFACE_MIN_COSINE` (no cosine: `similarity / 100 >= 0.8`); keeps the best score per photo (ties broken by cosine). Anchors = the external ids of the best **5** photos with `cosine ≥ INSIGHTFACE_ANCHOR_MIN_COSINE` (default `SURE`; engines without a cosine: the top five), so a borderline match never anchors a gallery. `replaceGallery` upserts `galleries` (`anchor_face_ids`, `matched_at = now()`, `notified_at = now()`), deletes the old items and inserts the new ones with `source = 'match'`; `updateGalleryMatch` then writes `query_embedding` (the selfie vector, **also when there are 0 hits**: later uploads attach through it), `last_match_reason = 'no_photos_yet'` when the gallery is empty else `null`, and `selfie_key = selfieKey` with `KEEP_SELFIES` else `null`. With `MATCH_LOG=true` one `match_runs` row (`liveness` `live` / `rejected` / null, `reason`, `selfie_sha256`, `selfie_faces`, `engine_ms`, `hits`) and one `match_hits` row per engine hit (`cosine`, `similarity`, `kept` = the hit is the face the gallery kept for that photo). Then deletes the selfie object (unless `KEEP_SELFIES`) and enqueues `email` kind `ready` (deduped), **also when the gallery is empty**. Log line gains `hits: <photos in the gallery>`.
7. `email`: subject `Le tue foto sono pronte` (`ready`) or `Ci sono nuove foto per te` (`new`); body is only `${WEB_ORIGIN}${galleryPath}`, with `galleryPath = /e/{slug}`.
8. `verify` (two-stage upload only): no-op unless the photo exists and `original_status = 'present'`. Reads the original (missing → sets `original_status = 'pending'` and `photos.error = "original missing"`, job done, no retry), compares its byte length with `photos.bytes` and its sha256 with `photos.sha256`. Match → clears `photos.error` when it was `sha256 mismatch` or `original missing`. Mismatch → deletes the original object, sets `original_status = 'pending'`, sets `photos.error = "sha256 mismatch"` (`photos.status` unchanged, the photo stays indexed and served from the web derivative), logs `{ verify: "mismatch", photoId, eventId }`. The uploader then resends the original (a new original-stage `init` is accepted again because the status is back to `pending`).
9. `retention`: cutoff = `now() - events.retention_days`. In batches of 50 photos of that event with `created_at < cutoff`: `deleteFaces` in chunks of 1000, `removeAnchors(eventId, externalIds)` (drops those ids from every `anchor_face_ids` of the event), deletes the original and derivative objects, deletes each photo row (gallery items, faces, `face_index`, and through the 006 foreign key `face_vectors` and `gallery_feedback`) and writes `audit_log` `photo.deleted` with `meta { eventId, retention: true }` and `actor_id = payload.actorId`. When the event has no photos left, calls `deleteCollection`. Galleries, their `query_embedding` and `selfie_key`, and `match_runs` are **not** touched by retention.
10. `reset` (v5, enqueued by `POST /v1/admin/events/:id/reset`): the retention loop with cutoff `now() + 1 s` and `meta { eventId, reset: true }` on every `photo.deleted` row, then `deleteGalleriesByEvent` (gallery items and galleries, hence anchors, selfie vectors and selfie keys), `deleteMatchRunsByEvent` (`match_hits` cascade), `deleteCollection`, and one `audit_log` row `event.reset` with `meta { photos, galleries, matchRuns }`. Users, consents, `event_participants`, `event_photographers`, `upload_sessions`, kept selfie objects and the event row stay. The offline alternative is `deploy/scripts/reset-event.sh` (stops api and worker, SQL in one transaction, `mc rm`, `vacuum analyze`).

Worker runtime (`apps/worker/src/index.ts`, `loop.ts`):

- Up to `WORKER_CONCURRENCY` jobs in flight; the loop claims while a slot is free, sleeps 500 ms ±25 % when the queue is empty or every slot is busy, and wakes early when a job finishes.
- `SIGINT` / `SIGTERM`: stop claiming, wait up to **60 s** for in-flight jobs, then log how many were abandoned (the 10-minute stale rule recovers them).
- Housekeeping at boot and every **10 minutes** on every instance (idempotent): delete `done` jobs older than **7 days** (`pruneJobs`); set `open` upload sessions older than **24 hours** to `aborted` and abort their S3 multipart upload when `s3_upload_id` is set.
- With `WORKER_PUBLISH_METRICS=true`: at boot and every **30 s** publish CloudWatch metric namespace `rephoto`, name `QueueDepth`, value = count of `queued` jobs, no dimensions. Publish errors are logged, never thrown.
- Logs: one JSON line per finished job `{ ts, job, type, ms, outcome, error?, liveness?, match?, reason?, hits?, photoId?, userId?, eventId? }` with `outcome` in `done` \| `requeued` \| `retry` \| `error` \| `invalid`; `error` is the message truncated to 500 characters; `liveness: "rejected"` only on a `match` ended by the liveness gate; `match: "rejected"` + `reason` (`no_face` \| `face_too_small` \| `low_quality` \| `multiple_faces`) on a `match` ended by the selfie gate; `hits` = photos in the rebuilt gallery on a successful `match`; the three ids only with `LOG_IDS=true` (photo jobs carry `photoId`, `match` / `email` carry `userId` + `eventId`, `retention` / `reset` carry `eventId`). No payload beyond those ids, no image bytes, no embeddings. The breaker's open transition is a separate stderr line (above).

Terminal job failure on `derive` or `index` sets the photo to `error` and stores the reason in `photos.error`.

## Postgres

Migrations in `packages/db/migrations`: `001_init.sql` (domain tables), `002_scale.sql` (`jobs.claimed_at`, `faces_event_external_idx`, `jobs_match_user_event_idx`), `003_v2.sql` (additive only; below), `004_two_stage.sql` (additive only: `photos.original_status`, `upload_sessions.stage` / `photo_id` / `original_content_type` / `original_bytes`, index `photos_event_original_pending_idx`), `005_face_vectors.sql` (`vector` extension + `face_vectors` table + HNSW index, inside a `DO` block that only raises a `NOTICE` on a Postgres without pgvector; see *`FACE_ENGINE=insightface`*), `006_recognition.sql` (v5, additive: `galleries.last_match_reason` / `selfie_key`, and in a guarded `DO` block `galleries.query_embedding vector(512)` + `galleries_query_embedding_idx`, orphan cleanup + `face_vectors_photo_id_fkey`; `jobs.finished_at` / `duration_ms` + `jobs_finished_at_idx`; tables `match_runs`, `match_hits`), `007_test_tooling.sql` (v5, additive: `photos.filename` / `tags`, `upload_sessions.filename` / `tags`, table `gallery_feedback`, indexes below). `migrate()` runs all pending files inside one transaction under `pg_advisory_xact_lock(727312)`, so several instances booting together do not race; bookkeeping table `schema_migrations` (not a domain table). `createSql`: `max = DATABASE_POOL_MAX`, `idle_timeout 20`, `connect_timeout 10`, `prepare: true`.

Photo status: `uploaded` \| `processing` \| `indexed` \| `error`.

```text
events(id uuid pk, slug unique, name, retention_days int default 90, access text default 'open' check in open|list, created_at)
users(id uuid pk, email, role text check in participant|photographer|admin, created_at, unique email+role)
magic_links(id, email, role, token_hash unique, expires_at, used_at, ip text null, created_at)
sessions(id, user_id fk, token_hash unique, expires_at)
consents(id, user_id, event_id, text_version, granted_at, withdrawn_at, ip, user_agent)
photos(id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, original_status text default 'present' check in pending|present, indexed_at null, error text null, created_at, filename text null, tags text[] default '{}', unique event_id+sha256)
derivatives(id, photo_id, kind check in thumb|web, s3_key, unique photo_id+kind)
faces(id, photo_id, event_id, external_id, bbox jsonb, confidence real, created_at, unique photo_id+external_id)  -- NO embedding column
face_index(external_face_id pk, photo_id, event_id, r, g, b, unique event_id+photo_id)  -- fake engine only
face_vectors(external_face_id uuid pk default gen_random_uuid(), event_id, photo_id fk photos on delete cascade (006), embedding vector(512), created_at)  -- insightface only; no row outside FACE_ENGINE=insightface
galleries(id, user_id, event_id, anchor_face_ids text[] default '{}', matched_at null, notified_at null, last_match_reason text null, selfie_key text null, query_embedding vector(512) null, unique user_id+event_id)  -- the last three from 006; query_embedding only with pgvector
gallery_items(id, gallery_id, photo_id, face_id, score double precision, source text default 'match' check in match|attach, created_at, unique gallery_id+photo_id)
gallery_feedback(user_id fk users cascade, event_id fk events cascade, photo_id fk photos cascade, verdict text check in me|not_me, score_at_time double precision null, created_at, pk user_id+event_id+photo_id)  -- 007
match_runs(id uuid pk, user_id fk users cascade, event_id fk events cascade, liveness text null, reason text null, selfie_sha256 text null, selfie_faces int null, engine_ms int null, hits int default 0, created_at)  -- 006, written only with MATCH_LOG=true
match_hits(run_id fk match_runs cascade, photo_id, external_face_id text, cosine real, similarity real, kept boolean, pk run_id+photo_id+external_face_id)  -- 006; no FK on photo_id: a deleted photo leaves its hits in the log
upload_sessions(id, event_id, photographer_id, s3_upload_id null, object_key, sha256, content_type, status check in open|completed|aborted, bytes bigint null, stage text default 'original' check in original|web, photo_id uuid null fk photos on delete set null, original_content_type text null, original_bytes bigint null, created_at, filename text null, tags text[] default '{}')
jobs(id, type, payload jsonb, status, attempts, run_after, last_error, created_at, claimed_at, priority smallint default 50, dedupe_key text null, finished_at timestamptz null, duration_ms int null)
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

Indexes added by `005_face_vectors.sql` (absent on a Postgres without pgvector):

| Index | Definition |
| --- | --- |
| `face_vectors_event_idx` | `face_vectors (event_id)` (per-event delete, filter) |
| `face_vectors_photo_idx` | `face_vectors (photo_id)` |
| `face_vectors_embedding_idx` | `face_vectors using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)`; searches run with `set local hnsw.ef_search = max(100, limit)` |

Indexes added by `006_recognition.sql` and `007_test_tooling.sql` (v5):

| Index | Definition |
| --- | --- |
| `galleries_query_embedding_idx` | `galleries using hnsw (query_embedding vector_cosine_ops) with (m = 16, ef_construction = 64)` (absent without pgvector); `findGalleriesByQueryVector` runs with the default `ef_search` |
| `jobs_finished_at_idx` | `jobs (finished_at) where finished_at is not null` (`status.sh` throughput and percentiles) |
| `match_runs_user_event_idx` | `match_runs (user_id, event_id, created_at desc)` |
| `match_runs_event_idx` | `match_runs (event_id, created_at desc)` (`admin/match-runs`, CSV export) |
| `photos_event_filename_idx` | `photos (event_id, filename)` (`admin/photos?filename=` prefix search) |
| `photos_tags_gin_idx` | GIN on `photos (tags)` (`admin/photos?tag=`) |
| `gallery_feedback_event_idx` | `gallery_feedback (event_id, created_at desc)` (CSV export) |

Clarifications (column names unchanged):

- Ids are `uuid` default `gen_random_uuid()` unless a seed inserts a fixed id.
- Timestamps are `timestamptz` default `now()` where the column is a creation or grant time. `used_at`, `withdrawn_at`, `indexed_at`, `matched_at`, `notified_at` are nullable.
- `token_hash` is hex SHA-256 of the raw token. Raw tokens are never stored.
- `faces.bbox` is `{ "x", "y", "width", "height" }` numbers in 0..1. No `embedding` column on `faces`, ever: the only embeddings in Postgres are `face_vectors.embedding`, written and read by the InsightFace engine alone, never joined into an HTTP response.
- `face_vectors` has, since 006, one foreign key: `photo_id references photos(id) on delete cascade` (added only when the table exists, i.e. with pgvector; the engine's self-healing DDL adds it too). `event_id` stays unconstrained. Consistency with `faces` is still kept by the worker: `indexPhoto` deletes the photo's rows before inserting (same transaction), `index` calls `deleteFaces` + `removeAnchors` on a re-index, admin delete, `retention` and `reset` call `deleteFaces` with the photo's `faces.external_id`s, `retention` and `reset` call `deleteCollection`.
- `audit_log` actions: `photo.deleted` (`meta { eventId }`, plus `retention: true` or `reset: true` from the jobs), `participant.deleted`, `selfie.submitted` (`actor_id` = participant, `target = event:{eventId}`, `meta { liveness: "challenge" | "file" }`), and from v5 `event.created` (`meta { slug }`), `magic_link.issued` (`target = user:{email}`, `meta { role, eventId }`), `gallery.rematch` (`meta { eventId, jobId }`), `gallery.deleted` (`meta { eventId }`), `event.reset` (**two** rows per reset: the route writes `meta { jobId }`, the worker writes `meta { photos, galleries, matchRuns }`), `photos.requeued` (`meta { status, errorLike, requeued }`), `gallery.feedback` (`actor_id` = participant, `target = photo:{photoId}`, `meta { eventId, verdict }`).
- `gallery_items.score` is the match similarity in 0..1. `source` says whether the `match` job (selfie) or the `attach` job (later upload) added the row.
- `galleries.anchor_face_ids` holds engine face ids (Rekognition `FaceId`s, `face_vectors.external_face_id` uuids as text, or fake ids) of faces **in event photos** that matched the participant's selfie: identifiers, not vectors (with InsightFace the identifier points at a vector in our own `face_vectors`, which is why `removeAnchors` and the deletes in *`FACE_ENGINE=insightface`* matter). Since v5 only hits with `cosine ≥ INSIGHTFACE_ANCHOR_MIN_COSINE` become anchors, and `removeAnchors` runs on admin delete and re-index too, not only at retention. They let `attach` find the gallery without keeping the selfie. `matched_at` is the last `match`; `notified_at` throttles the `new` e-mail.
- `galleries.query_embedding` (v5) **is** the selfie's vector (the largest face's 512-d ArcFace embedding), written by every `match` that passes the gates (null after a rejection), read by `attach`. It is the only persisted template of a participant and the reason a gallery can receive photos uploaded after a selfie that matched nothing. `last_match_reason` is the gallery's `reason` (see *HTTP*); `selfie_key` is set only with `KEEP_SELFIES=true`.
- `photos.filename` is the name declared at `uploads/init` or by the importer (used by the eval scripts to join labels; shown in the admin console); `photos.tags` are free labels from `uploads/init.tags` or `ingest --tags` (the importer uses `synth` for its synthetic copies). Neither is exposed to participants.
- `gallery_feedback` is the participant's verdict per photo (`me` / `not_me`) with the gallery score at the time; `match_runs` / `match_hits` are the raw match log (every engine hit of a run, `cosine` down to 0.25, `kept` = it made the gallery). Both are test-campaign data written only through `POST .../gallery/feedback` and `MATCH_LOG=true`.
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

API and worker boot call `seedDemo()`. That insert is skipped when `NODE_ENV=production` or `SEED_DEMO=false`. Local compose does not set either, so the seed still runs. `npm run db:seed` uses the same guard. The API then calls `bootstrapAdmins(db, BOOTSTRAP_ADMINS)` (idempotent upsert of admin users). `npm run seed:test` (`scripts/seed-test.ts`, v5) is the test-campaign seed: events, an admin, N photographers in `event_photographers`, M participants with a consent row, and pre-minted 30-day sessions written as cookie files (`cookies-*.txt`, `users-<slug>.csv` mode 0600, `subjects.csv`); `--purge-users` removes what it created.

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

Security headers on every API response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=15552000` when `WEB_ORIGIN` is `https:`. The web adds a CSP (`default-src 'self'; img-src 'self' blob: data: ${NEXT_PUBLIC_MEDIA_ORIGINS}; connect-src 'self' ${NEXT_PUBLIC_MEDIA_ORIGINS}; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`; `'wasm-unsafe-eval'` is what lets the MediaPipe wasm runtime, served from `/mediapipe/` on our own origin, instantiate), `Permissions-Policy: camera=(self)` and HSTS when `NEXT_PUBLIC_WEB_ORIGIN` is `https://`. On the VPS, Caddy overwrites HSTS / nosniff / `X-Frame-Options` / `Referrer-Policy: same-origin` / `Permissions-Policy` on every path (`deploy/Caddyfile`); the CSP stays the web's.

Error body: `{ "error": string }` (Italian text from `apps/api/src/errors.ts`) with `400` validation, `401` unauthenticated, `403` forbidden / not on list / consent missing, `404` missing, `409` conflict (duplicate `(event_id, sha256)`, session not `open`), `429` rate limit, `500` `Errore interno.`, `503` on health only. The two-stage upload adds no new code: `409` also covers an original-stage `init` for a photo whose original is already present, and `400` an original-stage `init` whose `sha256` / `bytes` differ from the stored ones.

| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/request-link` | `{ email, role }` | `202` `{ status: "sent" }` |
| `POST` | `/v1/auth/verify` | `{ token }` | `200` `{ user: { id, email, role } }` + `Set-Cookie` |
| `POST` | `/v1/auth/accept-invite` | `{ token }` | `200` `{ user: { id, email, role } }` + `Set-Cookie` |
| `POST` | `/v1/auth/logout` | | `204` empty |
| `GET` | `/v1/events/:slug` | | `200` `{ id, slug, name, retentionDays, access }` |
| `POST` | `/v1/events/:slug/consent` | `{ textVersion, accepted: true }` | `201` `{ id, grantedAt }` |
| `POST` | `/v1/events/:slug/selfie` | multipart field `selfie`, `image/jpeg` or `image/png`, ≤ 8 MiB; optional field `liveness` = `challenge` \| `file` (`SELFIE_LIVENESS_FIELD`, default `file`) | `202` `{ status: "queued" }` |
| `GET` | `/v1/events/:slug/gallery` | `?cursor=&limit=` (default 60, max 200) | `200` `{ status, total, items: [{ photoId, thumbUrl, webUrl, score, source, createdAt, originalReady, feedback: "me" \| "not_me" \| null }], nextCursor, reason: "no_face" \| "face_too_small" \| "low_quality" \| "multiple_faces" \| "no_photos_yet" \| "liveness" \| null }` |
| `POST` | `/v1/events/:slug/gallery/feedback` (v5) | `{ photoId, verdict: "me" \| "not_me" }` | `201` `{ photoId, verdict }` |
| `POST` | `/v1/events/:slug/gallery/download` | `{ photoIds (1..100), variant?: "original" \| "web" }` | `200` `{ urls: [{ photoId, url }] }` signed |
| `POST` | `/v1/events/:slug/gallery/zip` | form `ids=<csv>&variant=` or JSON `{ photoIds (1..500), variant? }` | `200` `application/zip` stream |
| `POST` | `/v1/uploads/init` | `{ eventId, filename, contentType, sha256, bytes, stage?: "original", photoId?, tags? }` or `{ eventId, filename, contentType: "image/jpeg", sha256, bytes, stage: "web", originalContentType, originalBytes, tags? }` (union on `stage`; `tags` v5: up to 20 strings of 1–40 chars) | `201` `{ id, objectKey, mode, url?, partSize? }` |
| `POST` | `/v1/uploads/:id/parts` | `{ partNumber }` | `200` `{ url, partNumber }` |
| `POST` | `/v1/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }` | `201` `{ photoId, status: "uploaded" \| "original_received" }` |
| `GET` | `/v1/uploads/lookup` | `?eventId=&sha256=` | `200` `{ photoId, originalStatus, status }` or `404` |
| `GET` | `/v1/uploads` | `?eventId=&cursor=&limit=` (default 50, max 200) | `200` `{ uploads: [{ id, objectKey, sha256, contentType, status, createdAt }], nextCursor }` |
| `GET` | `/v1/uploads/summary` | `?eventId=` | `200` `{ sessions: { open, completed, aborted }, photos: { uploaded, processing, indexed, error, originalsPending } }` |
| `GET` | `/health` | | `200` `{ ok: true }` or `503` `{ ok: false }`. ALB / container health check |
| `GET` | `/v1/health` | | Same, for the web `/v1` proxy |
| `GET` | `/v1/admin/metrics` | | `200` `{ events, photos, faces, users, jobsQueued, jobsRunning, jobsError, photosByStatus: { uploaded, processing, indexed, error }, galleries, originalsPending, jobsByType: [{ type, queued, running, error, oldestQueuedSeconds }], oldestQueuedSeconds, lastErrors: [{ id, type, error, at }], faceService: { ok, ms } }` (the last four v5) |
| `POST` | `/v1/admin/photographers/invite` | `{ email, eventId }` | `201` `{ inviteId }` |
| `POST` | `/v1/admin/participants/import` | `{ eventId, emails: string[] (1..5000) }` | `200` `{ inserted }` |
| `PATCH` | `/v1/admin/events/:id` | `{ access?: "open" \| "list", retentionDays?: int > 0 }` | `200` event (as `GET /v1/events/:slug`) |
| `DELETE` | `/v1/admin/photos/:id` | | `204` |
| `DELETE` | `/v1/admin/participants/:id` | | `204` |
| `POST` | `/v1/admin/retention/run` | `{ eventId }` | `202` `{ jobId }` |
| `POST` | `/v1/admin/photos/requeue` (v5) | `{ eventId, status?: "error", errorLike?: string (1..200) }` | `200` `{ requeued }` |
| `POST` | `/v1/admin/events` (v5) | `{ slug, name (1..200), retentionDays?: int > 0, access?: "open" \| "list" }` | `201` event (as `GET /v1/events/:slug`); `409` on a taken slug |
| `GET` | `/v1/admin/events` (v5) | | `200` `{ events: [{ id, slug, name, retentionDays, access, createdAt, photos, galleries, participants, photographers }] }` |
| `POST` | `/v1/admin/magic-links` (v5) | `{ email, role, eventId? }` | `200` `{ url }` |
| `GET` | `/v1/admin/galleries` (v5) | `?eventId=&email=` | `200` `{ user: { id, email, role }, gallery: { id, matchedAt, anchorFaceIds, reason, total } \| null, items: [{ photoId, faceId, thumbUrl, webUrl, score, source, createdAt, originalReady, feedback, photo: { sha256, filename } }] }`; `404` when no participant has that e-mail |
| `GET` | `/v1/admin/galleries` (v5) | `?eventId=&cursor=&limit=` (default 50, max 200) | `200` `{ galleries: [{ userId, email, total, matchedAt, reason }], nextCursor }` |
| `GET` | `/v1/admin/photos` (v5) | `?eventId=&sha256=&filename=&status=&photographerId=&tag=&cursor=&limit=` (default 50, max 200) | `200` `{ photos: [{ ...photo, thumbUrl }], nextCursor }` |
| `GET` | `/v1/admin/photos/:id` (v5) | | `200` `{ photo: { id, eventId, photographerId, sha256, status, contentType, bytes, originalStatus, indexedAt, error, createdAt, filename, tags }, webUrl, thumbUrl, faces: [{ id, externalId, bbox: { x, y, width, height }, confidence }], galleries: [{ userId, email, score, source, faceId, feedback }] }` |
| `GET` | `/v1/admin/faces/:externalId/neighbours` (v5) | `?eventId=&limit=` (default 20, max 100) | `200` `[{ externalFaceId, photoId, cosine, similarity }]` |
| `POST` | `/v1/admin/galleries/:userId/:eventId/rematch` (v5) | | `202` `{ jobId }`; `409` without `KEEP_SELFIES` or without a stored selfie |
| `DELETE` | `/v1/admin/galleries/:userId/:eventId` (v5) | | `204`; `404` when there is no gallery |
| `POST` | `/v1/admin/events/:id/reset` (v5) | `{ confirm: <the event slug> }` | `202` `{ jobId }` |
| `GET` | `/v1/admin/export/galleries.csv` (v5) | `?eventId=` | `200` `text/csv` stream |
| `GET` | `/v1/admin/export/match-hits.csv` (v5) | `?eventId=` | `200` `text/csv` stream |
| `GET` | `/v1/admin/export/feedback.csv` (v5) | `?eventId=` | `200` `text/csv` stream |
| `GET` | `/v1/admin/match-runs` (v5) | `?eventId=&email=&cursor=&limit=` (default 50, max 200) | `200` `{ runs: [{ id, userId, email, liveness, reason, selfieSha256, selfieFaces, engineMs, hits, createdAt, kept, maxCosine }], nextCursor }` |

`role` is `participant` \| `photographer` \| `admin`. All bodies are `.strict()`: unknown keys are `400` (`photos/requeue` enforces the same by hand). Schemas for the v5 routes are at the end of `packages/contracts/src/http.ts` (`admin*Schema`, `galleryFeedback*Schema`, `galleryReasonSchema`, `webConfigResponseSchema`; page sizes `ADMIN_PAGE_DEFAULT = 50`, `ADMIN_PAGE_MAX = 200`, `NEIGHBOURS_DEFAULT = 20`, `NEIGHBOURS_MAX = 100`, `UPLOAD_TAG_MAX = 20`; `eventSlugSchema` = `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–60 chars).

Auth rules:

- `request-link`: e-mail is lower-cased. Rate limit, checked before anything else and counted on `magic_links` rows over a one-hour window: **`MAGIC_LINK_PER_EMAIL` per e-mail** (default 3) and **`MAGIC_LINK_PER_IP` per IP** (default 20) → `429`; a limit set to `0` is not checked, and a client IP matching `RATE_LIMIT_EXEMPT_IPS` skips both (v5; the constants `MAGIC_LINK_RATE_LIMIT.perEmail` / `perIp` in `@rephoto/contracts` are no longer read, only its `windowSeconds`). Otherwise always `202` `{ status: "sent" }` (no account enumeration). Mail is sent only when the role is allowed: `participant` always; `photographer` or `admin` only when that `(email, role)` user already exists. The link is `${WEB_ORIGIN}/verifica?token=…` (the web redirects `/verifica` → `/verify`), subject `Accedi a RePhoto`, valid **20 minutes**, single use. `magic_links.ip` is stored.
- `verify`: consumes an unused, unexpired link; creates a `participant` user on first use; for `photographer` or `admin` a missing user is the same generic `400`. Starts a **30-day** session. The web page renders a button and POSTs only on click, so mail scanners do not consume the token.
- `accept-invite`: consumes an unused, unexpired `invites` row (**7-day** TTL), creates the user for the invite's role if missing, inserts `event_photographers` when the role is `photographer`, starts a session. Invalid → generic `400`.
- Participant: only the gallery, consent, selfie, download and zip for the signed-in user. Photographer: only upload routes, and only their own `upload_sessions` (`404` otherwise). Admin: the `/v1/admin/*` routes. A wrong role is `403`.
- `consent`: participant only. `textVersion` must equal `CONSENT_TEXT_VERSION` (`packages/contracts/src/http.ts`, currently `2026-10-06`), otherwise `400`. Stores `ip` (see *Client IP*) and `user-agent`. No route withdraws a consent.
- `selfie`, checks in this order: event `access = 'list'` and the user's e-mail not in `event_participants` → `403`; no consent row for this user and event with `withdrawn_at` null → `403`; **`SELFIE_MAX_PER_HOUR` selfies per user per hour** (default 5, counted on `match` jobs with that `userId`; `0` = not checked; exempt IPs skip it; `SELFIE_RATE_LIMIT.max` is no longer read) → `429`; then the image is validated (field `selfie`, `image/jpeg` or `image/png`, 1 byte to 8 MiB) → `400`, and the optional `liveness` field must be `challenge` or `file` when present (`selfieLivenessSchema`, else `400`; absent = `file`, so v3 clients keep working). Stores `selfies/{eventId}/{userId}/{uuid}`, enqueues `match`, then inserts `audit_log` `{ actor_id: user.id, action: "selfie.submitted", target: "event:{eventId}", meta: { liveness } }`. The value is **client-asserted**: `challenge` means the browser reports that the camera challenge (`apps/web/lib/liveness.ts`: look → turn left → turn right → blink → frontal capture, 15 s per step, MediaPipe Face Landmarker run locally, JPEG q0.9 long edge 1280) completed; `file` is the file picker fallback (no camera, permission denied, landmarker failed, or an older client). The API does not verify it; the server-side check is the worker's `LIVENESS_CHECK` gate (see *Jobs*).
- Gallery `status` is `queued` when the latest `match` job for this user+event is `queued` or `running` (index `jobs_match_user_event_idx`); `ready` when a gallery row exists or the latest job is `done` or `error`; `empty` otherwise. `items` come from one keyset query over `gallery_items` joined to both derivatives (`score desc, photo_id asc`); a photo missing a derivative is skipped and not counted in `total`. `nextCursor` is set when the page is full, else `null`. The cursor is opaque base64url of `score|photoId` (`encodeGalleryCursor` in `@rephoto/contracts`); a malformed cursor is `400`. v5: `reason` is `galleries.last_match_reason` when it is one of the six known values, else `null` (so a successful match, or a v4 gallery, answers `null`; the web shows a banner only when `items` is empty and `status` is not `queued`); `feedback` is the caller's `gallery_feedback` verdict for that photo or `null`. **`not_me` items are still returned and still counted in `total`**: the filter is the client's (the web lists them under «Nascoste» and excludes them from the score groups); a later `match` or `attach` re-inserts the photo and the verdict still applies, because `gallery_feedback` outlives the gallery row.
- `gallery/feedback` (v5): participant only; the photo must be in the caller's gallery for that event (`listOwnedPhotos`, else `403`); upserts `gallery_feedback` with `score_at_time` = the current gallery score (null when the item is not found on the second read); writes `audit_log` `gallery.feedback`. Sending `me` is how a participant un-hides a photo.
- `download`: `variant` defaults to `original`; `web` signs `web/{photoId}.jpg`. `original` signs `originals/{eventId}/{photoId}` when `original_status = 'present'` and **falls back to `web/{photoId}.jpg` while it is `pending`** (`variantKey`); the response does not say which one was signed, the gallery item's `originalReady` does. Ownership is one query (`listOwnedPhotos`); any id not in the caller's gallery for that event → `403` for the whole request. URLs expire in 30 minutes.
- `zip`: when an `Origin` header is present it must equal `WEB_ORIGIN` (else `403`). Accepts `application/json` `{ photoIds, variant }`, or `application/x-www-form-urlencoded` / `multipart/form-data` with `ids` = comma-separated uuids and optional `variant`; other content types are `400`. 1..500 distinct ids, all owned (else `403`). Streams `application/zip`, `Content-Disposition: attachment; filename="rephoto-{slug}.zip"`, `Cache-Control: no-store`, store mode (no compression), entries `{slug}-{index:04}.jpg` (`.png` when `variant = original`, the photo is PNG **and** its original is present), in request order. With `variant = original` a photo whose original is still `pending` contributes its web derivative (same `variantKey` fallback as `download`), always as `.jpg`. Objects are streamed from S3 one at a time, never buffered whole. A missing object is skipped (count logged); a client abort aborts the archive. Nothing is written to `audit_log`.
- `uploads/init`: photographer only; the event must exist (`404`) and the caller must be in `event_photographers` (`403`). Without `stage` (or `stage: "original"` without `photoId`) this is the v2 path: `bytes` 1..62,914,560 (60 MiB) → `400` above. Duplicate `(event_id, sha256)` → `409`. When `bytes <= 8,388,608` (8 MiB) `mode` is `single` and `url` is a presigned PUT bound to `Content-Length = bytes` and `Content-Type`. Otherwise `mode` is `multipart`, `partSize` is 8,388,608 and `url` is omitted. `objectKey` is `originals/{eventId}/{photoId}` with a photo id reserved at init. The session stores `bytes`, `stage = 'original'`, `photo_id = null`, and (v5) `filename` and `tags` (default `[]`), which `complete` copies into `photos.filename` / `photos.tags` when it creates the photo row (an original-stage `complete` of a web-first photo does not overwrite them). The other two bodies are described under *Two-stage upload*. `scripts/ingest/ingest.ts` writes the same `photos` row and `derive` job directly (no session), with `filename` = the file name and `tags` from `--tags` (+ `synth` for `--synth` copies).
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
- `admin/metrics` (v5): `photos`, `faces` and `users` are **approximate** (`pg_stat_user_tables.n_live_tup`, exact in `MemoryDatabase`); `events`, `galleries`, the job and photo-status counters stay exact. `jobsByType` lists the types with at least one `queued` / `running` / `error` row and the age in seconds of their oldest queued job; `oldestQueuedSeconds` is the maximum of those; `lastErrors` are the 20 newest `error` jobs (`error` = `last_error`, `at` = `created_at`); `faceService` is a `GET {FACE_SERVICE_URL}/health` with a 2 s timeout (`{ ok: null, ms: null }` unless `FACE_ENGINE=insightface`).
- `admin/photos/requeue` (v5): the event must exist (`404`). `status` may only be `error` (default). Photos of the event in that status (and, with `errorLike`, whose `photos.error` matches `ilike '%errorLike%'`) go back to `uploaded`, or to `processing` when both derivatives exist; `photos.error` is cleared; for each one a `derive` job is enqueued, or an `index` job when the web derivative exists (deduped). Writes `audit_log` `photos.requeued`. This is the recovery after a face-service outage that outlived the breaker.
- `admin/events` (v5): `POST` creates the event with `retentionDays` default 90 and `access` default `open` (`DuplicateKeyError` on the slug → `409`), writes `audit_log` `event.created`; `GET` returns every event with its counts of photos, galleries, `event_participants` and `event_photographers`.
- `admin/magic-links` (v5): mints a magic link for `email` + `role` **without sending mail** and returns the raw `${WEB_ORIGIN}/verifica?token=…` (20-minute TTL, single use, `magic_links.ip = null`), bypassing the request-link rate limits. For `photographer` and `admin` the user row is created first (`insertUser`, idempotent) since `verify` only creates participants; with `eventId` and role `photographer` the user is also added to `event_photographers`. `eventId` must exist (`404`). Writes `audit_log` `magic_link.issued`. The admin console renders it as a QR (`qrcode` npm package, client side).
- `admin/galleries` (v5): with `email`, the participant's gallery as the admin sees it (`items` include `faceId`, the photo `sha256` / `filename` and the `feedback` verdict; `thumbUrl` / `webUrl` are presigned, or `${WEB_ORIGIN}/missing` when a derivative is not there yet; `gallery` is `null` before the first `match`). Without `email`, a keyset list ordered by `matched_at desc nulls last, user_id` with an opaque `matchedAt|userId` cursor (`400` when malformed).
- `admin/photos` (v5): keyset list `created_at desc, id desc` (opaque `createdAt|id` cursor), filters AND-ed, `filename` is a **prefix** match, `sha256` a prefix of 1–64 hex chars, `tag` an array containment; `thumbUrl` is presigned only for `indexed` photos.
- `admin/photos/:id` (v5): `404` for an unknown id; `faces` with the stored normalised `bbox`; `galleries` = the galleries containing the photo with the row's score, source, face and the participant's feedback; `webUrl` / `thumbUrl` null while the derivative is missing.
- `admin/faces/:externalId/neighbours` (v5): the face must exist in the event (`404`), then `engine.searchFaces` (the engine's own `MIN` filter applies, so hits below `INSIGHTFACE_MIN_COSINE` are not listed); `cosine` is the engine's raw value or, for an engine without one, the inverse of the similarity mapping (`MIN + (similarity − 80) / 20 × (SURE − MIN)`); sorted by cosine desc, cut to `limit`.
- `admin/galleries/:userId/:eventId/rematch` (v5): `409` (`selfieNotKept`) unless `KEEP_SELFIES=true` **and** `galleries.selfie_key` is set; user and event must exist (`404`); enqueues a `match` with that key (no dedupe, like a selfie); writes `audit_log` `gallery.rematch`. `DELETE /v1/admin/galleries/:userId/:eventId`: removes the gallery row with its items, anchors, selfie vector and selfie key (the kept selfie object stays); `404` when there is none; `audit_log` `gallery.deleted`.
- `admin/events/:id/reset` (v5): `confirm` must equal the event's slug (`400` otherwise); enqueues `reset` with `dedupeKey = reset:{eventId}` (a second click while one is active returns the same `jobId`); writes `audit_log` `event.reset` with the job id. See the `reset` job.
- `admin/export/*.csv` (v5): streamed with `Content-Disposition: attachment; filename="<kind>-<slug>.csv"`, `Cache-Control: no-store`, RFC 4180 quoting, one row per DB cursor row, abortable by the client. Columns: `galleries.csv` `email,user_id,photo_id,sha256,filename,score,source,face_id,created_at,feedback`; `match-hits.csv` `run_id,email,user_id,run_created_at,photo_id,external_face_id,cosine,similarity,kept`; `feedback.csv` `email,user_id,photo_id,sha256,filename,verdict,score_at_time,created_at`. `scripts/eval/evaluate.py` reads the first two (and `feedback.csv` to exclude `not_me` photos).
- `admin/match-runs` (v5): keyset list newest first (opaque `createdAt|id` cursor), optionally narrowed to one participant `email`; `kept` and `maxCosine` are aggregated from `match_hits`. Empty unless the worker ran with `MATCH_LOG=true`.

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

Web routes (`apps/web/app`): `/` (participant e-mail form), `/staff` (v5: e-mail + role `photographer` / `admin` → `request-link`; the home form is participants only; not linked from any page, reached by URL), `/verify` (and `/verifica` redirect), `/invito`, `/selfie`, `/gallery` (event from `useEventSlug()`), `/e/[slug]`, `/eventi/[slug]/galleria` (redirect to `/e/[slug]`), `/upload`, `/admin` (v5: the console, sections by URL hash `#stato` `#eventi` `#link` `#gallerie` `#foto` `#esporta` `#gestione` `#reset`, every section bound to the event selected in **Eventi**, defaulting to the runtime slug), `/admin/foto/[id]` (v5: photo debug page: web rendition with an SVG overlay of the stored boxes, the faces with «Vicini» → `admin/faces/:externalId/neighbours`, the galleries the photo sits in), `/api/config` (v5: `GET` → `{ eventSlug }`, see *Environment*), `/v1/[...path]` (API proxy), `/api/s3-put` (dev-only PUT proxy to `localhost:9000`; `404` in production), `/manifest.webmanifest` (from `app/manifest.ts`), the static `/sw.js` and the static `/mediapipe/` tree (wasm runtime + `face_landmarker.task`, copied/downloaded by `apps/web/scripts/fetch-mediapipe.mjs` on `prebuild`, git-ignored; when the model download fails the script warns and the build goes on, unless `MEDIAPIPE_MODEL_REQUIRED=1`, which the web Dockerfile sets by default so a production image cannot ship without the model; when absent at runtime the selfie page falls back to the file picker). After verify the web lands on `/selfie`, `/upload` or `/admin` by role.

Selfie page capture (`/selfie`): with `getUserMedia` in a secure context (`https:` or `localhost`) the page opens the front camera, runs the challenge and sends the captured frame with `liveness=challenge`; otherwise, or on «Usa un file invece», it sends the picked file with `liveness=file`. No frame leaves the browser before the final capture; the landmarker runs in the page. The consent text it sends is still version `2026-10-06` («Il selfie viene cancellato subito dopo la ricerca»): with the v5 stored selfie vector, and with `KEEP_SELFIES=true`, that sentence is no longer accurate and must be revised before production (`docs/DPIA.md` §3, §10).

Gallery page (`/e/[slug]`, `/gallery`, v5): when the gallery is empty and `reason` is set, a banner in the participant's words (`no_face` «Nel selfie non si vede un volto», `face_too_small` «Avvicinati alla camera», `low_quality` «Il selfie è sfocato o troppo scuro», `multiple_faces` «Nel selfie ci sono più persone», `no_photos_yet` «Non ci sono ancora foto: ti avviseremo», `liveness` «Il selfie non è stato accettato»; every reason but `no_photos_yet` adds «prova un altro selfie»). «Non sono io» in the viewer and on the selection bar posts `gallery/feedback` per photo; `not_me` items move to a collapsed «Nascoste» group where «Sono io» posts `me`. `?debug=1` (persisted as `localStorage rephoto.debug = 1`; `?debug=0` clears it) shows `score · source` on every cell and in the viewer.

Signed URL helpers, the Rekognition client and the face-service client stay out of `packages/contracts`.

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

## Changes from v3

- **Self-hosted deployment is primary** (`deploy/`: Caddy, `pgvector/pgvector:pg16`, MinIO, `face-service`, api ×2, worker ×2, web, backup, uptime-kuma; `docs/infra.md`). The AWS stack in `infra/cdk` is kept as an alternative, not maintained as the reference.
- **`FACE_ENGINE=insightface`** (`docs/v4-selfhost-spec.md`): `apps/face-service` (FastAPI, onnxruntime CPU, `buffalo_l`, `/health`, `/v1/embed`, `/v1/liveness`), `InsightFaceEngine` with the frozen cosine → similarity mapping (`80 + 20 × clamp((c − MIN) / (SURE − MIN), 0, 1)`, `MIN` 0.45, `SURE` 0.65), nearest-neighbour search in `face_vectors` (HNSW, cosine, `ef_search = max(100, limit)`), `deleteFaces` in chunks of 1000, errors `FaceServiceUnavailable` / `FaceServiceError` / `FaceVectorsTableMissing`. `FACE_ENGINE` enum is `fake | rekognition | insightface`.
- **Embeddings rule rewritten**: raw embeddings are persisted only in `face_vectors`, only with `FACE_ENGINE=insightface`, never in logs or object storage, deleted with the photo (`deleteFaces`), with retention and with `deleteCollection`.
- **Schema `005_face_vectors.sql`** (additive, tolerant of a Postgres without pgvector): `face_vectors` + `face_vectors_event_idx` / `face_vectors_photo_idx` / `face_vectors_embedding_idx`; the engine recreates the same DDL on first use when the table is missing (self-healing), failing with `FaceVectorsTableMissing` only when the extension cannot be created.
- **`FaceEngine.checkLiveness?`** (`LivenessInput` / `LivenessResult`), implemented by the InsightFace engine only, rate-limited on the search bucket.
- **Jobs**: `match` liveness gate under `LIVENESS_CHECK=true` (rejected → empty gallery, selfie deleted, `ready` mail still sent, log `liveness: "rejected"`).
- **HTTP**: selfie multipart field `liveness` (`challenge | file`, default `file`, `SELFIE_LIVENESS_FIELD` / `selfieLivenessSchema`); new `audit_log` action `selfie.submitted` with `meta.liveness`. CSP `script-src` gains `'wasm-unsafe-eval'`.
- **Web**: `/selfie` camera challenge (MediaPipe Face Landmarker served from `/mediapipe/`, steps look / left / right / blink / capture, 15 s each, file-picker fallback); `apps/web/scripts/fetch-mediapipe.mjs` on `prebuild` (warns and skips the model when offline; `MEDIAPIPE_MODEL_REQUIRED=1`, default in the web Dockerfile, makes it fatal).
- **Worker**: face-service `4xx` `400` / `413` / `422` are non-retryable (`isNonRetryable` also matches `FaceServiceError` with those statuses); `5xx` / unreachable (`FaceServiceUnavailable`) retry as before.
- **Env**: `FACE_SERVICE_URL`, `INSIGHTFACE_MIN_COSINE`, `INSIGHTFACE_SURE_COSINE`, `INSIGHTFACE_MAX_FACES`, `INSIGHTFACE_MIN_FACE_QUALITY`, `FACE_INDEX_TPS`, `FACE_SEARCH_TPS` (Rekognition names kept, generic names honoured as fallback), `LIVENESS_CHECK`, `S3_PUBLIC_ENDPOINT` (second `S3Client` for presigning only), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` (default true on 465), `SMTP_STARTTLS` (`auto | true | false`). `MAIL_TRANSPORT=smtp` is now nodemailer with a pooled transport.
- **Rate limiter** wraps both remote engines; `checkLiveness` shares the search bucket. Defaults 20/20 for InsightFace.
- **Local dev**: `docker compose up -d` starts `face-service` (port 8090) and `pgvector/pgvector:pg16`; `FACE_ENGINE=fake` stays the no-dependency default.
- Tests added: `packages/face-engine/src/insightface.test.ts`, `apps/worker/test/v4.test.ts`, `apps/api/test/mailer.test.ts`, `apps/api/test/routes.test.ts` (presigned host = `S3_PUBLIC_ENDPOINT`, selfie `liveness` audit), `apps/face-service/tests` (pytest), `insightface.integration.test.ts` (skips without pgvector + service).

## Changes from v4

Everything is additive (`docs/v5-test-readiness-spec.md`); the three behaviour changes a v4 reader must know are the stored selfie vector, detection at 2560 px from the original, and the thresholds.

- **FaceEngine**: `SearchHit.cosine?`; optional `embedSelfie`, `searchByVector`, `faceEmbedding` (InsightFace and fake; Rekognition keeps the v4 path); `cosineSimilarity` and `fakeEmbedding` exported from the package (`parseVectorText` only from `insightface.ts`). InsightFace: `indexPhoto` deletes the photo's rows before inserting (one transaction, `DELETE_PHOTO_SQL`), `max_faces = INSIGHTFACE_INDEX_MAX_FACES` + `min_size = 24` on every embed, `AbortSignal.timeout` 60 s on embed / liveness and 10 s on `health()`, `searchByVector` may return hits below `MIN` with `similarity = 0`. Rate limiter: the new methods share the search bucket, `faceEmbedding` is not limited.
- **Defaults**: `INSIGHTFACE_MIN_COSINE` 0.45 → **0.50**, `INSIGHTFACE_SURE_COSINE` 0.65 → **0.70** (gallery «Le tue foto» boundary 0.55 → 0.60), `INSIGHTFACE_MIN_FACE_QUALITY` 0.3 → **0.2**, `INSIGHTFACE_MAX_FACES` 500 → **200**. These are the code (`envSchema`, `insightface.ts`) and `deploy/compose.test.yml` defaults; **`deploy/compose.yml` still carries the v4 numbers as `${VAR:-…}` fallbacks** for api and worker, so a production VPS gets 0.45 / 0.65 / 500 / 0.3 unless `.env.production` sets the v5 values (known inconsistency, see `docs/infra.md` §1). Measured on the first real run (39 photos of 3 people, 52 faces at 2560/1024): the selfie of one of them matched 13 / 13 of their photos at cosine ≈ 0.92 with 0 false positives; a selfie without a face answered `no_face`; a photo uploaded afterwards attached by itself.
- **Env** (new): `INSIGHTFACE_ATTACH_MIN_COSINE` 0.55, `INSIGHTFACE_ANCHOR_MIN_COSINE` (= `SURE`), `INSIGHTFACE_INDEX_MAX_FACES` 100, `SELFIE_MIN_FACE_PX` 120, `SELFIE_MIN_QUALITY` 0.6, `FACE_INDEX_SOURCE` (`original` for insightface), `FACE_DETECT_LONG_EDGE` 2560, `MATCH_LOG`, `KEEP_SELFIES`, `LOG_IDS`, `MAGIC_LINK_PER_EMAIL` 3, `MAGIC_LINK_PER_IP` 20, `SELFIE_MAX_PER_HOUR` 5 (0 = off), `RATE_LIMIT_EXEMPT_IPS`, `BOOTSTRAP_ADMINS`; web runtime `EVENT_SLUG` via `/api/config`. Face-service: `DET_LONG_EDGE` 2560, `DET_SIZE` 1024, `UVICORN_WORKERS`, `MODEL_CONCURRENCY`, `DECODE_CONCURRENCY` (compose names `FACE_DET_LONG_EDGE`, `FACE_DET_SIZE`, `FACE_SERVICE_WORKERS`, `FACE_MODEL_CONCURRENCY`, `FACE_DECODE_CONCURRENCY`).
- **Face service**: detection on a 2560 px long edge with a 1024 px SCRFD input (≈ 1.6–1.9× the v4 cost per photo: 145–176 ms p50 / ~178 ms p95 on a 20 MP photo, Apple silicon, 4 threads); `max_faces` 1–150 (default 150); `norm` and `yaw` per face; `GET /metrics`; configurable worker processes and semaphores.
- **Jobs**: `index` priority 60 → **40**; new type `reset` (priority 90, `reset:{eventId}`); `FaceServiceUnavailable` → requeue without an attempt + per-process circuit breaker (5 in a row → `index` / `attach` / `match` not claimed for 30 s); heartbeat on `claimed_at` every 2 minutes; `jobs.finished_at` / `duration_ms`; `match` rewritten (selfie gate with reasons, query vector stored on the gallery, anchors only at `cosine ≥ ANCHOR_MIN`, `no_photos_yet`, `MATCH_LOG` / `KEEP_SELFIES`, no `ready` mail on a gate rejection); `attach` rewritten (anchor threshold `ATTACH_MIN`, quorum of 2 with ≥ 3 anchors, selfie-vector path through `findGalleriesByQueryVector`); `index` from the original at 2560 px and `removeAnchors` on re-index; `removeAnchors` also from `purgePhoto`; log lines gain `match`, `reason`, `hits` and, with `LOG_IDS`, the ids.
- **Schema** `006_recognition.sql`: `galleries.query_embedding` (HNSW) / `last_match_reason` / `selfie_key`, `face_vectors` foreign key to `photos` (cascade, orphans removed), `jobs.finished_at` / `duration_ms`, `match_runs`, `match_hits`. `007_test_tooling.sql`: `photos.filename` / `tags`, `upload_sessions.filename` / `tags`, `gallery_feedback`. New `Database` methods at the end of `packages/db/src/types.ts` (`updateGalleryMatch`, `findGalleriesByQueryVector`, `insertMatchRun(s)`, `touchJob`, `deleteGalleriesByEvent`, `deleteMatchRunsByEvent`, `resetPhotosForRequeue`, `createEvent`, `listEventsWithCounts`, `findUserByEmail`, `listGalleriesPage`, `findGalleryWithItemsByEmail`, `findPhotoDetail`, `listPhotosAdmin`, `findGallerySelfieKey`, `deleteGallery`, `upsertFeedback`, `listFeedback`, `listMatchRuns`, `export*`, `metricsExtras`; `claimJob(options)`; `findGalleryByUser` returns `reason`, `selfieKey`, `hasQueryVector`; `countAnchoredGalleries` counts selfie vectors too).
- **HTTP**: gallery `reason` and item `feedback`; `POST .../gallery/feedback`; `uploads/init.tags`; rate limits from env with exempt IPs; `admin/metrics` extras (`jobsByType`, `oldestQueuedSeconds`, `lastErrors`, `faceService`); the admin routes `photos/requeue`, `events` (create / list), `magic-links`, `galleries` (by e-mail / list), `photos` (list / detail), `faces/:externalId/neighbours`, `galleries/:userId/:eventId/rematch` + `DELETE`, `events/:id/reset`, `export/{galleries,match-hits,feedback}.csv`, `match-runs`; new audit actions; error text `selfieNotKept`.
- **Web**: `/staff`, the `/admin` console (Stato, Eventi, Link di accesso with QR, Gallerie, Foto, Esporta, Gestione, Reset), `/admin/foto/[id]`, `/api/config` + `useEventSlug()`, gallery reason banner, «Non sono io» / «Nascoste», `?debug=1`.
- **Ops**: `deploy/compose.test.yml` (Mailpit on `mail.DOMAIN`, test env, `pg_stat_statements`, backup profile), `deploy/scripts/status.sh`, `deploy/scripts/reset-event.sh`, `scripts/ingest`, `scripts/seed-test.ts`, `scripts/eval`, `deploy/README.md` §9 bis.
- Tests added: `apps/worker/test/v5.test.ts` (17 cases: gate reasons, anchors, selfie-vector attach, quorum, match log, kept selfies, re-index anchors, detection source, requeue + breaker, heartbeat and `finished_at`, priority, `LOG_IDS`, reset, liveness reason), the v5 cases in `apps/api/test/routes.test.ts` (requeue, admin authz, photo detail and neighbours, feedback, rematch and gallery delete, reset, CSV exports, env rate limits and exempt IPs), `packages/face-engine/src/insightface.test.ts` (v5 cases), `packages/contracts/src/jobs.test.ts` (`reset`, priority order), face-service pytest updates (`norm` / `yaw`, resolution path, caps, `/metrics`), `scripts/eval/fixtures` for `evaluate.py`.
