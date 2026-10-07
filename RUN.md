# Run locally

API (`8787`), worker, and web (`3000`) are three host processes. Compose starts only Postgres, MinIO, and Mailpit by default. The MinIO image is `cgr.dev/chainguard/minio` because `minio/minio` is no longer on Docker Hub; compose sets `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000` so the browser can PUT straight to presigned URLs (the Next.js `/api/s3-put` proxy is only a fallback, and answers `404` in production).

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

Seeded data: event slug `demo` (`access = open`), admin `admin@rephoto.local`, photographer `photographer@rephoto.local` with the invite already accepted and the `event_photographers` row in place. `FACE_ENGINE=fake`. No real secrets are in the repo.

Flow to try: open http://localhost:3000, ask a link as `photographer@rephoto.local` (role is chosen by the page: `/` is the participant form; photographers and admins use the same magic link with their role, see `CONTRACTS.md`), read it in Mailpit, click **Entra** on `/verify`, upload on `/upload`; then as any participant e-mail ask a link, give consent and send a selfie on `/selfie`, open `/e/demo`. With the fake engine two images with the same average colour are the same person.

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

All variables are listed in `.env.example` and described in `CONTRACTS.md` (section *Environment*). The ones added in v2:

| Variable | Default | What it does |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `4` | Jobs in flight per worker process (1–32). Raise it locally only if the fake engine and sharp keep up; with Rekognition the TPS envs are the real limit |
| `REKOGNITION_INDEX_TPS`, `REKOGNITION_SEARCH_TPS` | `5` | Token buckets per worker process for `IndexFaces` and `SearchFaces*`. Ignored with `FACE_ENGINE=fake` |
| `DATABASE_POOL_MAX` | `10` | Pool size of the API process |
| `TRUSTED_PROXY_HOPS` | `1` | How many proxies append to `x-forwarded-for` before the API (the Next.js proxy counts as one). The client IP feeds the magic-link rate limit and `consents.ip` |
| `WORKER_PUBLISH_METRICS` | `false` | Keep `false` locally; `true` publishes `rephoto/QueueDepth` to CloudWatch |
| `NEXT_PUBLIC_EVENT_SLUG` | `demo` | Event the `/selfie` and `/gallery` pages use |
| `NEXT_PUBLIC_MEDIA_ORIGINS` | `http://localhost:9000` | Origins allowed by the CSP for presigned URLs |
| `API_PROXY_TARGET` | `http://localhost:8787` | Where the web `/v1/*` proxy forwards |

## Everything in Docker (`app` profile)

The three Dockerfiles (`apps/api`, `apps/worker`, `apps/web`) can run next to the infra services for an end-to-end smoke test:

```sh
docker compose --profile app up --build
```

Known limitation: inside the compose network the API signs S3 URLs against `S3_ENDPOINT=http://minio:9000`, and those URLs go to the browser on the host, where `minio` does not resolve. Map it once:

```sh
echo "127.0.0.1 minio" | sudo tee -a /etc/hosts
```

With that line the browser reaches the same MinIO on port 9000 and the signatures stay valid (SigV4 covers the host header, so the name must be the one the API used). Without it uploads and thumbnails fail in the browser while api and worker work. The web image is built with `NEXT_PUBLIC_MEDIA_ORIGINS="http://localhost:9000 http://minio:9000"` for the same reason.

## Tests

```sh
npm test
```

`node --test` over nine files, no Docker needed: `packages/contracts/src/collection-id.test.ts`, `packages/contracts/src/jobs.test.ts`, `packages/face-engine/src/face-engine.test.ts`, `packages/db/src/memory.test.ts`, `apps/worker/test/mvp.test.ts`, `apps/worker/test/v2.test.ts`, `apps/worker/test/v3.test.ts` (two-stage derive and `verify`), `apps/web/lib/resize.worker.test.ts` (1600 px render geometry), `apps/api/test/routes.test.ts`. They use `MemoryDatabase`, the fake engine with an in-memory store, and in-memory object store / mailer / queue.

## Load test

k6 scripts for the two hot paths (photographer upload, participant selfie with polling until `ready`) are in `scripts/loadtest/` with their own README: how to obtain session cookies, how to run against local or against the AWS stack, thresholds.

## Useful endpoints while developing

- `GET /health` (`select 1` with a 2 s timeout; `503` when Postgres is down).
- `GET /v1/uploads/summary?eventId=…` as a photographer: counts of sessions and photos by status plus `originalsPending`, the same the `/upload` page polls every 10 s.
- `GET /v1/uploads/lookup?eventId=…&sha256=…` as a photographer: `photoId`, `originalStatus` and `status` of an own photo, `404` otherwise. Handy to check whether an original is still due.
- `GET /v1/admin/metrics` as admin: queue depth (`jobsQueued`, `jobsRunning`, `jobsError`), `photosByStatus` and `originalsPending`.
- Worker stdout: one JSON line per job (`{ ts, job, type, ms, outcome }`).

## AWS

Reference stack in `infra/cdk` (`npm run synth` there works offline with `CDK_DEFAULT_ACCOUNT=123456789012`). Topology, sizing and the event-day runbook: `docs/infra.md`. SES production access: `docs/ses-produzione.md`.
