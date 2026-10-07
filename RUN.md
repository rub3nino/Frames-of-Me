# Run locally

API (`8787`), worker, and web (`3000`) are three host processes. Compose starts Postgres (`pgvector/pgvector:pg16`), MinIO, Mailpit and the **face-service** (`apps/face-service`, port `8090`) by default. The first `docker compose up -d` builds the face-service image, which downloads the InsightFace `buffalo_l` model pack (~280 MB) and the anti-spoofing weights (~2 MB) into the image: allow a few minutes and network access to GitHub; later starts are instant. The MinIO image is `cgr.dev/chainguard/minio` because `minio/minio` is no longer on Docker Hub; compose sets `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000` so the browser can PUT straight to presigned URLs (the Next.js `/api/s3-put` proxy is only a fallback, and answers `404` in production).

```sh
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:worker
npm run dev:web
```

`npm run dev` prints those three process commands. The API and the worker also run the migrations (under an advisory lock) and the demo seed at boot, so `db:migrate` / `db:seed` are only needed to prepare the database before the first `dev:web`.

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:8787 |
| MinIO | http://localhost:9000 (console http://localhost:9001) |
| Mailpit | http://localhost:8025 (SMTP `localhost:1025`) |
| face-service | http://localhost:8090 (`GET /health` → `{ ok, model, providers }`) |

Seeded data: event slug `demo` (`access = open`), admin `admin@rephoto.local`, photographer `photographer@rephoto.local` with the invite already accepted and the `event_photographers` row in place. `FACE_ENGINE=fake` is the default in `.env.example`. No real secrets are in the repo.

Flow to try: open http://localhost:3000, ask a link as `photographer@rephoto.local` (role is chosen by the page: `/` is the participant form; photographers and admins use the same magic link with their role, see `CONTRACTS.md`), read it in Mailpit, click **Entra** on `/verify`, upload on `/upload`; then as any participant e-mail ask a link, give consent and send a selfie on `/selfie`, open `/e/demo`. With the fake engine two images with the same average colour are the same person; with the InsightFace engine (below) it is real face matching.

## Face engine: `fake` or `insightface`

`fake` needs nothing and is what the tests use. `insightface` is the production engine (`docs/v4-selfhost-spec.md`, `CONTRACTS.md` → *`FACE_ENGINE=insightface`*) and runs locally as soon as compose is up:

1. `docker compose up -d` (face-service healthy: `curl -s localhost:8090/health`). The compose Postgres is the pgvector image, so migration `005_face_vectors.sql` creates `face_vectors`; on a volume created with the old `postgres:16` image the migration only prints a `NOTICE` and the engine creates the extension and the table itself on first use (the volume keeps working because the major version is the same).
2. In `.env`: `FACE_ENGINE=insightface` (`FACE_SERVICE_URL=http://localhost:8090` is already there). Restart `dev:api` and `dev:worker`.
3. Upload a few photos with faces, send a selfie: the worker log shows `index` then `attach`, and `select count(*) from face_vectors` grows by the number of faces kept (`quality >= INSIGHTFACE_MIN_FACE_QUALITY`, default 0.3).

Thresholds (`INSIGHTFACE_MIN_COSINE=0.45`, `INSIGHTFACE_SURE_COSINE=0.65`) map cosine to the 0–100 scale the gallery expects: a match at cosine 0.45 is score 0.8 («Forse sei tu»), at 0.55 score 0.9 («Le tue foto»), at 0.65 and above score 1.0. Timings on a laptop: ~150–180 ms per 1600 px photo (Apple silicon, 4 threads), ~325 ms in the arm64 container; the service runs at most two inferences at once.

**`LIVENESS_CHECK=true`** (default `false`) makes the worker's `match` job call `POST /v1/liveness` on the selfie before searching; a selfie judged not live gets an empty gallery (the page shows «Nessuna corrispondenza»), the selfie is deleted and the worker log line carries `liveness: "rejected"`. The check only exists with `FACE_ENGINE=insightface`; the compose image includes the anti-spoofing weights (`method: "silent-face"`), a build with `--build-arg WITH_LIVENESS=0` answers `method: "none"` and never rejects.

Running the Python service outside Docker (venv, `MODEL_ROOT`, `uvicorn`) is described in `apps/face-service/README.md`.

## Selfie with the camera

`/selfie` opens the front camera and runs the challenge (look → left → right → blink → automatic capture) with MediaPipe Face Landmarker, loaded from `/mediapipe/` on our own origin. Two prerequisites, otherwise the page silently falls back to the file picker (`liveness = file` in `audit_log`):

- **A secure context**: `https://` or `http://localhost` (`getUserMedia` is unavailable on a plain `http://<lan-ip>`; to try from a phone use a tunnel with TLS or `next dev --experimental-https`).
- **The MediaPipe files in `apps/web/public/mediapipe/`** (git-ignored). `npm run build -w @rephoto/web` fetches them through the `prebuild` script; for `dev:web` run it once by hand: `node apps/web/scripts/fetch-mediapipe.mjs` (copies the wasm runtime from `node_modules` and downloads the ~3.6 MB `face_landmarker.task` from Google Storage; idempotent). Offline, the script prints `mediapipe: WARNING model not available` and the build still succeeds with the camera challenge disabled; set `MEDIAPIPE_MODEL_REQUIRED=1` to make that fatal (the web Dockerfile does, so a production image build fails rather than ship without the model).

Each step has 15 s; a timeout shows «Riprova». «Usa un file invece» is always available. The captured frame is a JPEG (q0.9, long edge 1280) sent as the `selfie` field with `liveness=challenge`; the API stores that flag in `audit_log` (`selfie.submitted`) and nothing else about the challenge.

## Watched folder and two-stage upload

The continuous uploader (v3, `docs/v3-uploader-spec.md`) lives on the same `/upload` page. To try it:

1. Open http://localhost:3000/upload in **Chrome or Edge** as the photographer. Safari and Firefox do not implement the File System Access API: the page shows «Usa Chrome o Edge per caricare una cartella in automatico» and only drag-and-drop is available (it goes through the same queue and the same mode).
2. Section **Cartella sorvegliata** → **Scegli cartella**, pick an empty folder on disk (the browser asks for read permission), then **Avvia**. The status line reads «Controllo la cartella ogni 10 s · N file visti · N caricate».
3. Copy or drop jpeg / png files into that folder (subfolders are fine; dotfiles are skipped). Within ~10 s they appear in the list and start uploading; a file modified less than 3 s ago is left alone until the next scan, so a camera or tether software still writing it is not read half-way. Files removed from the folder are ignored; a failed file is retried by a later scan after a minute.
4. **Pausa** aborts the transfers in flight and keeps the queue; **Riprendi** continues; **Ferma** stops the watcher. Closing the tab while something is uploading shows the browser's leave-page warning. Reopening `/upload` later shows «Riprendi `<nome cartella>`»: one click re-asks the permission and resumes, including the originals still due (their fingerprints are in IndexedDB; the bytes are re-read from the folder). «Rimuovi cartella» forgets the handle.

**Prima il web, poi gli originali** (toggle above the drop zone, on by default where the browser can render, remembered in `localStorage`): each file is first rendered in a Web Worker to a 1600 px JPEG and sent to `web/{photoId}.jpg` (`init` with `stage: "web"`), so the photo is indexed within seconds; the original is sent afterwards, when no web version is waiting (`init` with `stage: "original"` and `photoId`). What to watch while it runs:

- the batch header shows «N originali da inviare» and the summary panel `originalsPending` (from `GET /v1/uploads/summary`, polled every 10 s); both go to zero once the originals are in;
- the worker log shows `derive` → `index` → `attach` right after the web stage and a `verify` job after each original (`sha256 mismatch` in `photos.error` means the original did not match what the web stage declared: the uploader resends it);
- a participant whose gallery contains such a photo sees the «solo web» tag until the original arrives, and the «Originali» ZIP says how many selected photos will come as web version.

Switch the toggle off to get the v2 behaviour (original only, derivatives rendered by the worker). Mixed batches are fine: the server dedupes on `(event, sha256)` either way and `GET /v1/uploads/lookup` tells the client whether only the original is still due.

**Install as app**: Chrome / Edge show «Installa come app» on `/upload` once `beforeinstallprompt` fires (needs `http://localhost` or `https`); the installed window opens straight on `/upload`. The service worker (`public/sw.js`, scope `/upload`) caches nothing and only makes the page installable; uploads never go through a cache.

## Environment

All variables are listed in `.env.example` and described in `CONTRACTS.md` (section *Environment*). The ones that matter locally:

| Variable | Default | What it does |
| --- | --- | --- |
| `FACE_ENGINE` | `fake` | `fake` \| `insightface` \| `rekognition`. See above |
| `FACE_SERVICE_URL` | `http://localhost:8090` | The compose face-service; `http://face-service:8090` inside the `app` profile |
| `INSIGHTFACE_MIN_COSINE`, `INSIGHTFACE_SURE_COSINE` | `0.45`, `0.65` | Cosine ↔ score 0.8 / 1.0. `SURE` must be greater than `MIN` |
| `INSIGHTFACE_MAX_FACES`, `INSIGHTFACE_MIN_FACE_QUALITY` | `500`, `0.3` | Search limit; minimum face quality to index |
| `FACE_INDEX_TPS`, `FACE_SEARCH_TPS` | `20` | Token buckets per process for the InsightFace engine (also honoured by Rekognition when the `REKOGNITION_*_TPS` names are blank) |
| `LIVENESS_CHECK` | `false` | Server-side anti-spoofing in the `match` job (InsightFace only) |
| `WORKER_CONCURRENCY` | `4` | Jobs in flight per worker process (1–32). The face-service runs two inferences at once; more jobs only queue inside it |
| `REKOGNITION_INDEX_TPS`, `REKOGNITION_SEARCH_TPS` | `5` | Token buckets for Rekognition. Ignored with `fake` and `insightface` |
| `DATABASE_POOL_MAX` | `10` | Pool size of the API process (the InsightFace engine opens its own pool of 4) |
| `TRUSTED_PROXY_HOPS` | `1` | How many proxies append to `x-forwarded-for` before the API (the Next.js proxy counts as one) |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_STARTTLS` | unset / unset / port-based / `auto` | Leave unset for Mailpit (no AUTH, no TLS). A provider on 587 wants both credentials and `SMTP_STARTTLS=true`; on 465 `SMTP_SECURE` defaults to `true` |
| `S3_PUBLIC_ENDPOINT` | unset | Only for MinIO behind a proxy (`deploy/`): host used in presigned URLs. Locally the browser reaches MinIO on `localhost:9000` directly |
| `WORKER_PUBLISH_METRICS` | `false` | CloudWatch export; keep `false` |
| `NEXT_PUBLIC_EVENT_SLUG` | `demo` | Event the `/selfie` and `/gallery` pages use |
| `NEXT_PUBLIC_MEDIA_ORIGINS` | `http://localhost:9000` | Origins allowed by the CSP for presigned URLs |
| `API_PROXY_TARGET` | `http://localhost:8787` | Where the web `/v1/*` proxy forwards |

## Everything in Docker (`app` profile)

The three Dockerfiles (`apps/api`, `apps/worker`, `apps/web`) can run next to the infra services for an end-to-end smoke test:

```sh
docker compose --profile app up --build
```

The profile sets `FACE_ENGINE=fake` and `FACE_SERVICE_URL=http://face-service:8090`; edit `docker-compose.yml` (`x-app-env`) to `insightface` to smoke-test the real engine in containers. The web image runs `fetch-mediapipe.mjs` at build, so the camera challenge works on `http://localhost:3000`.

Known limitation: inside the compose network the API signs S3 URLs against `S3_ENDPOINT=http://minio:9000`, and those URLs go to the browser on the host, where `minio` does not resolve. Map it once:

```sh
echo "127.0.0.1 minio" | sudo tee -a /etc/hosts
```

With that line the browser reaches the same MinIO on port 9000 and the signatures stay valid (SigV4 covers the host header, so the name must be the one the API used). Without it uploads and thumbnails fail in the browser while api and worker work. The web image is built with `NEXT_PUBLIC_MEDIA_ORIGINS="http://localhost:9000 http://minio:9000"` for the same reason. (The production stack solves this properly with `S3_PUBLIC_ENDPOINT`, see `deploy/README.md`.)

## Tests

```sh
npm test
```

`node --test` over twelve files, no Docker needed: `packages/contracts/src/collection-id.test.ts`, `packages/contracts/src/jobs.test.ts`, `packages/face-engine/src/face-engine.test.ts`, `packages/face-engine/src/insightface.test.ts` (cosine mapping, quality filter, chunked deletes, error names, with a stubbed service and a stubbed `sql`), `packages/db/src/memory.test.ts`, `apps/worker/test/mvp.test.ts`, `apps/worker/test/v2.test.ts`, `apps/worker/test/v3.test.ts` (two-stage derive and `verify`), `apps/worker/test/v4.test.ts` (liveness gate in `match`), `apps/web/lib/resize.worker.test.ts` (1600 px render geometry), `apps/api/test/routes.test.ts` (including presigned host = `S3_PUBLIC_ENDPOINT` and the selfie `liveness` audit row), `apps/api/test/mailer.test.ts` (nodemailer options from the SMTP env). They use `MemoryDatabase`, the fake engine with an in-memory store, and in-memory object store / mailer / queue.

**Integration test of the InsightFace engine** (real Postgres + real service), skipped by `npm test` unless both are reachable:

```sh
docker compose up -d
DATABASE_URL=postgres://rephoto:rephoto@localhost:5432/rephoto FACE_SERVICE_URL=http://localhost:8090 \
  node --import tsx --test packages/face-engine/src/insightface.integration.test.ts
```

**Python tests of the face-service** (`pytest`, from `apps/face-service`; details in its README):

```sh
cd apps/face-service
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && pip install --no-deps -r requirements-insightface.txt && pip install -r requirements-dev.txt
python scripts/download_models.py --root ~/.rephoto-models    # once, ~280 MB
MODEL_ROOT=~/.rephoto-models pytest
```

The stubbed tests (`test_engine.py`, `test_images.py`, `test_liveness.py`, `test_api_stub.py`: bbox normalisation, quality, size caps, error codes) always run; `test_api_real.py` loads the real model and is skipped with a reason when the pack is not available.

## Load test

k6 scripts for the two hot paths (photographer upload, participant selfie with polling until `ready`) are in `scripts/loadtest/` with their own README: how to obtain session cookies, how to run against local or against a deployed stack, thresholds.

## Useful endpoints while developing

- `GET /health` (`select 1` with a 2 s timeout; `503` when Postgres is down).
- `GET http://localhost:8090/health`: face-service model loaded; `curl -F image=@foto.jpg "localhost:8090/v1/embed?max_faces=10"` to see faces, scores and 512-d embeddings; `curl -F image=@selfie.jpg localhost:8090/v1/liveness`.
- `GET /v1/uploads/summary?eventId=…` as a photographer: counts of sessions and photos by status plus `originalsPending`, the same the `/upload` page polls every 10 s.
- `GET /v1/uploads/lookup?eventId=…&sha256=…` as a photographer: `photoId`, `originalStatus` and `status` of an own photo, `404` otherwise.
- `GET /v1/admin/metrics` as admin: queue depth (`jobsQueued`, `jobsRunning`, `jobsError`), `photosByStatus` and `originalsPending`.
- Worker stdout: one JSON line per job (`{ ts, job, type, ms, outcome, liveness? }`).
- `psql`: `select event_id, count(*) from face_vectors group by 1` and `select action, meta from audit_log order by created_at desc limit 10` (`selfie.submitted` rows carry `meta.liveness`).

## Production

Self-hosted VPS (primary): `deploy/README.md` (first deploy, update, backup, mail provider, event days) and `docs/infra.md` (topology, sizing, runbook). AWS alternative: `infra/cdk` (`npm run synth` there works offline with `CDK_DEFAULT_ACCOUNT=123456789012`), `docs/infra.md` §8, `docs/ses-produzione.md`.
