# RePhoto v4 — self-hosted face engine and deployment

Goal: run RePhoto without AWS. Face matching with **InsightFace** (SCRFD detector + ArcFace 512-d embeddings, `buffalo_l` model pack, CPU, onnxruntime) exposed by a small Python service; vectors stored in **Postgres + pgvector**; objects in **MinIO**; TLS and routing with **Caddy**; transactional mail via any SMTP provider; everything on one VPS with Docker Compose. Rekognition stays available as `FACE_ENGINE=rekognition`; nothing AWS-specific is deleted.

Language: code/comments English, UI Italian, docs Italian except `CONTRACTS.md`.

---

## 1. Face service — `apps/face-service` (Python 3.11, FastAPI, onnxruntime CPU, insightface)

Container listens on **8090**. No persistence, no logging of image bytes.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | | `200 { ok: true, model: "buffalo_l", providers: [...] }` (model loaded) |
| `POST` | `/v1/embed` | multipart `image` (jpeg/png ≤ 8 MiB), query `max_faces` (1–50, default 50), `min_size` (px, default 20) | `200 { width, height, faces: [{ bbox: { left, top, width, height } /*0..1*/, score /*0..1 det*/, quality /*0..1, see below*/, embedding: number[512] /*L2-normalised*/ }] }` sorted by bbox area desc |
| `POST` | `/v1/liveness` | multipart `image` | `200 { live: boolean, score: 0..1, method: "silent-face" \| "none" }` — optional; if the MiniVision Silent-Face ONNX weights are not available at build time, return `{ live: true, score: 0, method: "none" }` and document it |

Rules:
- Decode with Pillow (EXIF-oriented, `ImageOps.exif_transpose`), cap 120 MP (→ `413`), convert to BGR for insightface. Long edge is resized to 1600 before detection when larger.
- `quality` = min(1, bbox_long_edge_px / 80) × det score — a cheap proxy; faces with `bbox` long edge < `min_size` are dropped.
- Errors: `400` undecodable image, `413` too large, `422` validation. Never echo bytes.
- `MODEL_NAME` env (default `buffalo_l`), `ONNX_THREADS` env (default = CPU count), `DET_SIZE` env (default 640).
- Model pack: downloaded at **image build time** into `/models` (insightface downloads from its GitHub release; use `insightface.model_zoo`/`FaceAnalysis(name, root=...)` in a build step) so the runtime container has no network dependency. Image ~1.5 GB is acceptable.
- Concurrency: uvicorn 1 worker, `ONNX_THREADS` intra-op threads; a `/v1/embed` call takes ~150–300 ms on 4 vCPU for a 1600 px photo. Node callers run several in parallel; a process-level `asyncio.Semaphore(2)` guards the model.
- Tests (`pytest`): protocol tests with the real model if it can be loaded locally (download allowed in the dev machine), otherwise skipped with a clear reason; pure tests for bbox normalisation, quality, size cap and error codes with a stubbed analyser.
- `Dockerfile` (python:3.11-slim, non-root), `requirements.txt` pinned (`insightface`, `onnxruntime`, `fastapi`, `uvicorn[standard]`, `python-multipart`, `pillow`, `numpy`, `opencv-python-headless`).

---

## 2. Engine adapter — `packages/face-engine/src/insightface.ts`

`FACE_ENGINE=insightface`. Implements the existing `FaceEngine` interface (`indexPhoto`, `search`, `searchFaces`, `deleteFaces`, `deleteCollection`). Env:

| Var | Default | Meaning |
| --- | --- | --- |
| `FACE_SERVICE_URL` | `http://localhost:8090` | the Python service |
| `DATABASE_URL` | (shared) | pgvector lives in the app database |
| `INSIGHTFACE_MIN_COSINE` | `0.45` | cosine similarity below which a pair is not a match |
| `INSIGHTFACE_SURE_COSINE` | `0.65` | cosine at/above which the pair is considered certain |
| `INSIGHTFACE_MAX_FACES` | `500` | search result cap |
| `INSIGHTFACE_MIN_FACE_QUALITY` | `0.3` | faces below this are not indexed |

**Similarity scale (frozen):** the rest of the system expects 0–100 with the worker threshold 0.8 and the gallery "sure" group at 0.9. The adapter maps cosine `c` to
`similarity = 80 + 20 × clamp((c − MIN) / (SURE − MIN), 0, 1)` for `c ≥ MIN`, and drops pairs below `MIN`. So `MIN` ↔ 80, `SURE` ↔ 100, and the gallery's 0.9 boundary sits halfway. `IndexedFace.confidence` = `score × 100`.

Storage — migration `packages/db/migrations/005_face_vectors.sql`:

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

The migration must be safe when the extension is unavailable (e.g. a plain `postgres:16` image): wrap in a `DO` block that skips table creation and raises a `NOTICE` when `create extension` fails — and `migrate()` must not abort. The engine itself fails fast at boot with a clear message when the table is missing.

Behaviour:
- `indexPhoto`: POST the bytes to `/v1/embed` (`max_faces` 50), keep faces with `quality ≥ INSIGHTFACE_MIN_FACE_QUALITY`, insert one `face_vectors` row per face in a single statement, return `[{ externalFaceId, bbox, confidence }]`. `externalFaceId` is the row's uuid.
- `search`: embed the selfie, take the **largest** face (none → `[]`), query `select external_face_id, photo_id, 1 - (embedding <=> $1) as cos from face_vectors where event_id = $2 order by embedding <=> $1 limit $maxFaces`, keep `cos ≥ MIN`, map to similarity. Set `hnsw.ef_search` to `max(100, maxFaces)` for the session (`set local`).
- `searchFaces`: same query using the stored vector of `externalFaceId`, excluding itself; unknown id → `[]`.
- `deleteFaces`: `delete ... where event_id = $1 and external_face_id = any($2)` in chunks of 1000. `deleteCollection`: `delete ... where event_id = $1`.
- HTTP errors from the service: 5xx / connection refused → throw an error named `FaceServiceUnavailable` (retryable in the worker like any error); 400 → treat as "no faces" for index (return `[]`) and for search.
- Uses the `postgres` package (same as `packages/db`), a lazily created client per `DATABASE_URL`, `max: 4`. `createFaceEngine` wires it from env; the rate limiter wraps it too (defaults `REKOGNITION_INDEX_TPS` are irrelevant here — add `FACE_INDEX_TPS` / `FACE_SEARCH_TPS` generic names with defaults 20/20 and keep the Rekognition names as aliases).
- Tests: unit tests with a stubbed HTTP service and a stubbed `sql` (verify mapping, filtering, chunking, error names); an integration test (`packages/face-engine/src/insightface.integration.test.ts`) that runs only when `DATABASE_URL` points at a pgvector-enabled database AND `FACE_SERVICE_URL` answers `/health`, otherwise `test.skip` with the reason.

Contracts: `envSchema.FACE_ENGINE` becomes `fake | rekognition | insightface`; new optional envs above. `CONTRACTS.md` gets the mapping table (docs pass later).

Local dev: `docker-compose.yml` Postgres image becomes `pgvector/pgvector:pg16` (same major, existing volume keeps working), plus a `face-service` service (built from `apps/face-service`, port 8090, profile default so `docker compose up -d` starts it; the first build downloads the model). `.env.example` documents `FACE_ENGINE=insightface` as the recommended local value once the service is up, with `fake` still the no-dependency default.

---

## 3. Self-hosted deployment — `deploy/`

Target: one Linux VPS (Debian/Ubuntu, 8–16 vCPU, 32 GB, 2 TB disk), Docker + Compose plugin. Everything in `deploy/`:

- `compose.yml` (production): `caddy` (80/443, TLS automatic, reverse proxy: `/v1/*` → api:8787, everything else → web:3000, `/minio/*` not exposed; `media.<domain>` → MinIO for presigned URLs, with `S3_PUBLIC_ENDPOINT` so the API signs URLs for the public host), `postgres` (`pgvector/pgvector:pg16`, volume, `shm_size`), `minio` + `minio-init`, `face-service`, `api` (replicas 2), `worker` (replicas 2, `WORKER_CONCURRENCY=4`), `web`, `backup` (daily `pg_dump` + `mc mirror` of the bucket to a second disk/path; retention 7 days), `uptime-kuma` (optional, behind Caddy basic auth). Healthchecks everywhere, `restart: unless-stopped`, log rotation (`json-file`, max-size 50m, max-file 5), resource limits for face-service and worker.
- Presigned URLs with MinIO behind Caddy: the API must sign for the host the browser uses. Add to the API/worker object store an optional env `S3_PUBLIC_ENDPOINT` (e.g. `https://media.example.com`) used only for presigning (a second `S3Client` with that endpoint) while `S3_ENDPOINT` stays the internal one. Implement in `apps/api/src/objects.ts` + contracts env (small, additive; the deploy agent owns this change and its test in `apps/api/test/routes.test.ts`: presigned URL host equals the public endpoint).
- `Caddyfile` with security headers, gzip/zstd, request body limit 70 MB on the API path, rate limiting via Caddy's `rate_limit` module is not in the default build — instead document fail2ban on Caddy access logs for `/v1/auth/*` and rely on the API's own limits.
- `.env.production.example`: every variable with a comment; secrets generated by `scripts/gen-secrets.sh`.
- `scripts/`: `bootstrap.sh` (installs Docker on a fresh Debian 12, creates the `rephoto` user, clones the repo, copies env, `docker compose up -d`), `backup.sh`, `restore.sh`, `migrate.sh` (one-off migration container), `logs.sh`.
- `systemd/rephoto.service` to bring Compose up at boot.
- `README.md` (Italian): sizing for the event, DNS records, first deploy, update procedure (`git pull && docker compose build && up -d`), backup/restore test, monitoring, what to do on event days, costs (Hetzner example), **mail provider setup** (SPF/DKIM) and why not self-hosted Postfix.
- `docker compose -f deploy/compose.yml config` must validate. Building the images locally is a plus but not required (face-service build downloads ~300 MB).

---

## 4. Liveness challenge in the browser — `apps/web` selfie page

Self-hosted replacement for Rekognition Face Liveness: a **deterrent**, stated as such in the DPIA.

- Use the device camera (`getUserMedia`, front camera) when available; fallback to the current file picker when the camera is denied/unavailable.
- Active challenge with **MediaPipe Face Landmarker** bundled locally (npm `@mediapipe/tasks-vision`; copy the wasm files and the `face_landmarker.task` model into `apps/web/public/mediapipe/` with a small `scripts/fetch-mediapipe.mjs` run at build; CSP already allows `'self'`; the worker/wasm is loaded from `/mediapipe/`). Steps shown in Italian: "Guarda la camera" → "Gira la testa a sinistra" → "a destra" → "Sbatti le palpebre" → frontal capture. Head yaw from the landmarker's `facialTransformationMatrixes` (or blendshapes `eyeLookOut*`), blink from blendshapes `eyeBlinkLeft/Right` > 0.5. Each step must be completed within 15 s; failure → retry.
- The captured frontal frame (JPEG q0.9, long edge 1280) is sent as the `selfie` field as today, plus a field `liveness` = `challenge` (camera + challenge passed) or `file` (fallback). The API stores it in `audit_log` (`action = "selfie.submitted"`, `meta: { liveness }`) — API change: `apps/api/src/routes.ts` selfie route reads the optional multipart field `liveness` (`challenge | file`, default `file`) and writes the audit row; contracts: `SELFIE_LIVENESS_FIELD = "liveness"`. The admin metrics gain nothing; the DPIA will cite the audit field.
- Also call `face-service /v1/liveness` from the worker's `match` job when `FACE_ENGINE=insightface` and `LIVENESS_CHECK=true` (env, default `false`): if `live === false` the match job completes with an empty gallery and `email` kind `ready` is still sent (the UI shows "Nessuna corrispondenza"); log `{ liveness: "rejected" }`. Engine interface addition: optional `checkLiveness?(input: { imageBytes, contentType }): Promise<{ live: boolean; score: number; method: string }>` — implemented by the InsightFace engine only.
- Privacy: no frames leave the browser except the final selfie; the landmarker runs locally. Reduced motion / no camera → file fallback works everywhere.

---

## 5. Ownership

| Agent | Paths |
| --- | --- |
| face-service | `apps/face-service/**`, `docker-compose.yml` (face-service + pgvector image), `.env.example` (face lines) |
| engine | `packages/face-engine/**`, `packages/contracts/src/env.ts`, `packages/db/migrations/005_face_vectors.sql`, `packages/db/src/migrate.ts` (tolerant extension), `apps/api/src/face.ts`, `apps/worker/**` for `checkLiveness` wiring + `LIVENESS_CHECK` env, root `package.json` test list |
| deploy | `deploy/**`, `apps/api/src/objects.ts` + `apps/api/src/object-store.ts` (`S3_PUBLIC_ENDPOINT`), `packages/contracts/src/env.ts` (**only** the `S3_PUBLIC_ENDPOINT` line — coordinate: add it at the end of the object; the engine agent adds its lines after `FACE_ENGINE`), `apps/api/test/routes.test.ts` (one new test, appended) |
| liveness-web | `apps/web/app/selfie/**`, `apps/web/lib/liveness.ts`, `apps/web/public/mediapipe/**`, `apps/web/scripts/fetch-mediapipe.mjs`, `apps/web/package.json`, `apps/web/app/globals.css` (append under `/* ---- liveness (agent L) ---- */`), `apps/api/src/routes.ts` selfie route + `packages/contracts/src/http.ts` (`SELFIE_LIVENESS_FIELD`, `livenessSchema`), `apps/api/test/routes.test.ts` (one new test, appended) |

Shared file rule: when two agents must touch the same file, each adds at a different, clearly separated place and never reformats the file. Re-run the typecheck of every package you touched before reporting.
