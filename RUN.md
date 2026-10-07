# Run locally

API (`8787`), worker, and web (`3000`) are three host processes. Compose starts Postgres (`pgvector/pgvector:pg16`), MinIO, Mailpit and the **face-service** (`apps/face-service`, port `8090`) by default. The first `docker compose up -d` builds the face-service image, which downloads the InsightFace `buffalo_l` model pack (~280 MB) and the anti-spoofing weights (~2 MB) into the image: allow a few minutes and network access to GitHub; later starts are instant. The MinIO image is `cgr.dev/chainguard/minio` because `minio/minio` is no longer on Docker Hub; compose sets `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000` so the browser can PUT straight to presigned URLs (the Next.js `/api/s3-put` proxy is only a fallback, and answers `404` in production).

The package manager is **pnpm** (via Corepack — `corepack enable` once; the version is pinned in `package.json`).

```sh
cp .env.example .env
docker compose up -d        # Postgres, MinIO, Mailpit, face-service
pnpm install
pnpm db:seed                # migrate + seed the demo event (run once, before dev:api)
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

`pnpm dev` prints those three process commands. Migrations and the demo seed run **once** via `pnpm db:seed`; the API and worker no longer migrate at boot (so a multi-replica/container first boot is deterministic and the worker never migrates). In the full-stack compose `app` profile a one-shot `migrate` service does this and the api/worker wait for it.

| Service | URL |
| --- | --- |
| Web | http://localhost:3000 |
| API | http://localhost:8787 |
| MinIO | http://localhost:9000 (console http://localhost:9001) |
| Mailpit | http://localhost:8025 (SMTP `localhost:1025`) |
| face-service | http://localhost:8090 (`GET /health` → `{ ok, model, providers }`) |

Seeded data: event slug `demo` (`access = open`), admin `admin@rephoto.local`, photographer `photographer@rephoto.local` with the invite already accepted and the `event_photographers` row in place. `FACE_ENGINE=fake` is the default in `.env.example`. No real secrets are in the repo.

Flow to try: open http://localhost:3000/staff, ask a link as `photographer@rephoto.local` with role «Fotografo» (`/` is the participant form; photographers and admins use `/staff` since v5, same magic link with their role, see `CONTRACTS.md`), read it in Mailpit, click **Entra** on `/verify`, upload on `/upload`; then register a participant on `/registrati` with an event code (`insert into event_codes (event_id, code) select id, 'DEMO-2026' from events where slug = 'demo'`), give consent and send a selfie on `/selfie`, open `/e/demo` — or, for a pre-v6 account, mint a magic link and open `/verify?token=…`. With the fake engine two images with the same average colour are the same person; with the InsightFace engine (below) it is real face matching. The admin console (`admin@rephoto.local` on `/staff` with role «Amministratore», then `/admin`) is described further down.

## Face engine: `fake` or `insightface`

`fake` needs nothing and is what the tests use. `insightface` is the production engine (`docs/v4-selfhost-spec.md`, `CONTRACTS.md` → *`FACE_ENGINE=insightface`*) and runs locally as soon as compose is up:

1. `docker compose up -d` (face-service healthy: `curl -s localhost:8090/health`). The compose Postgres is the pgvector image, so migration `005_face_vectors.sql` creates `face_vectors`; on a volume created with the old `postgres:16` image the migration only prints a `NOTICE` and the engine creates the extension and the table itself on first use (the volume keeps working because the major version is the same).
2. In `.env`: `FACE_ENGINE=insightface` (`FACE_SERVICE_URL=http://localhost:8090` is already there). Restart `dev:api` and `dev:worker`.
3. Upload a few photos with faces, send a selfie: the worker log shows `index` then `attach`, and `select count(*) from face_vectors` grows by the number of faces kept (`quality >= INSIGHTFACE_MIN_FACE_QUALITY`, default 0.2 since v5).

Since v5 the compose face-service detects on a **2560 px** long edge with a **1024 px** detector input (`FACE_DET_LONG_EDGE` / `FACE_DET_SIZE` in `docker-compose.yml`; 1600 / 640 were the v4 values and still work, with fewer small faces found), and the worker sends it a detection JPEG rendered from the **original** at 2560 px (`FACE_INDEX_SOURCE=original`, the default with `insightface`) instead of the 1600 px web derivative. Count on ~1.6–1.9× the v4 time per photo: 145–176 ms p50 / ~178 ms p95 on a 20 MP photo (Apple silicon, 4 threads, one worker), ~325 ms was the v4 arm64 container figure at 1600 / 640. The service runs `MODEL_CONCURRENCY` (2) inferences at once per process and `curl localhost:8090/metrics` prints its counters and p50 / p95.

Thresholds (`INSIGHTFACE_MIN_COSINE=0.50`, `INSIGHTFACE_SURE_COSINE=0.70`, v5 defaults; 0.45 / 0.65 until v4) map cosine to the 0–100 scale the gallery expects: a match at cosine 0.50 is score 0.8 («Forse sei tu»), at 0.60 score 0.9 («Le tue foto»), at 0.70 and above score 1.0. Two more v5 behaviours to expect while trying it: the `match` job **gates the selfie** before searching (no face, face under `SELFIE_MIN_FACE_PX` = 120 px, quality under `SELFIE_MIN_QUALITY` = 0.6, two people) and the gallery page then shows the reason («Nel selfie non si vede un volto», «Avvicinati alla camera», …) instead of a bare «Nessuna corrispondenza»; and the selfie's **vector is stored on the gallery** (`galleries.query_embedding`), so a selfie sent before any photo answers «Non ci sono ancora foto: ti avviseremo» and the photos uploaded afterwards attach by themselves (`select user_id, query_embedding is not null, last_match_reason from galleries`). On the first real run (39 photos of 3 people, 52 faces indexed) one person's selfie matched 13 / 13 of their photos at cosine ≈ 0.92 with no false positive.

**`LIVENESS_CHECK=true`** (default `false`) makes the worker's `match` job call `POST /v1/liveness` on the selfie before searching; a selfie judged not live gets an empty gallery with reason `liveness` («Il selfie non è stato accettato»), the selfie is deleted and the worker log line carries `liveness: "rejected"`. The check only exists with `FACE_ENGINE=insightface`; the compose image includes the anti-spoofing weights (`method: "silent-face"`), a build with `--build-arg WITH_LIVENESS=0` answers `method: "none"` and never rejects.

**Test-campaign switches** (all `false` by default, `.env.example` lists them): `MATCH_LOG=true` writes every `match` run and all its hits, down to cosine 0.25, into `match_runs` / `match_hits` (then `/admin#esporta` → «match-hits.csv», or `select cosine, kept from match_hits order by cosine desc`); `KEEP_SELFIES=true` keeps the selfie object and records its key in `galleries.selfie_key`, which enables «Rifai il confronto» on an admin gallery; `LOG_IDS=true` adds `photoId` / `userId` / `eventId` to the worker log lines. Restart `dev:worker` after changing them. With the face-service stopped (`docker compose stop face-service`) the worker now **requeues** `index` / `attach` / `match` without burning attempts and, after five in a row, prints one `{ breaker: "open", pauseMs: 30000 }` line and stops claiming those types for 30 s; `docker compose start face-service` and the queue resumes with nothing in `error`.

Running the Python service outside Docker (venv, `MODEL_ROOT`, `uvicorn`) is described in `apps/face-service/README.md`.

## Participant sign-in (v6): Google, password, event code — and the magic-link fallback

The participant home page (`/`) no longer offers a magic link. It offers **Accedi con Google** and **e-mail + password**, with `/registrati` for a new account and «Password dimenticata?» for a reset.

- **Self-registration:** `POST /v1/auth/register` `{ email, password, eventCode }` → creates the `participant`, scrypt-hashes the password into `users.password_hash` and sets the `rephoto_session` cookie, `201`. The password is at least 10 characters. The **event code** is the anti-bot gate: it is the code printed on the badge/QR, stored in `event_codes` (migration `012_auth_identities.sql`) with an optional `max_uses` and `expires_at`. Absent, expired and exhausted all answer `403` with one message. The claim is a single `update … where uses < max_uses returning …`, so `max_uses` holds under concurrent registrations. A code string that exists in two events charges exactly one of them.
- **Registration sends no e-mail at all** and `users.email_verified_at` stays null. Lazy verification is deliberate: 6 000 same-day registrations would blow through the Resend free tier (3 000/month, 100/day) in minutes. The address is proven later — by a password reset, a magic link, or a Google token with `email_verified`.
- **Password reset** (the only e-mail a self-registered participant can trigger): `POST /v1/auth/password-reset` `{ email }` → always `202`, and a link is mailed only when a participant with that address exists. The link lands on `/registrati?reset=<token>`, which posts `POST /v1/auth/password-reset/confirm` `{ token, password }` → new password, `email_verified_at` stamped, session started.
  - **The reset token is not a magic link** (v6 hardening, migration `016_password_reset_tokens.sql`, routes in `apps/api/src/routes.reset.ts`). It lives in `password_reset_tokens`, bound to one `user_id`, valid **15 minutes**, single use, and burnt again by any password change — so a second link mailed before the first was used dies with the password it was meant to replace. Until v6 the flow ran on `magic_links`, which meant an intercepted **login** link (mailed by `request-link`, or minted in the admin console and shown as a QR) could be posted to `…/confirm` and take the account for good. `consumePasswordResetToken` only ever sees this table, so it cannot happen again.
  - Its budget is its own too: `PASSWORD_RESET_PER_USER` (default 3/hour) and `PASSWORD_RESET_PER_IP` (default 20/hour), counted on `password_reset_tokens`. The reset flow and the event-day login fallback can no longer starve each other.
- **Google:** `GET /v1/auth/google/start` (302 to Google, with a short-lived signed `rephoto_oauth` cookie carrying state + the PKCE verifier + the nonce) and `GET /v1/auth/google/callback` (verifies state, PKCE, nonce, issuer, audience and expiry, then resolves the user and 302s into the app). Without `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URL` both routes answer `404`, and the web only shows the button when `NEXT_PUBLIC_GOOGLE_LOGIN=true`. The `email` claim is used **only** when the token says `email_verified`; an unverified claim never finds or creates an account. A sign-in resolves to `role = 'participant'` unless a `user_identities` row already points at another role, and `users.unique (email, role)` is untouched, so the same address can be a participant and a photographer.
- Register the redirect URI in the Google console exactly as `GOOGLE_REDIRECT_URL`. Through the web proxy that is `https://<web host>/v1/auth/google/callback`; pointing it straight at the API host works too.

### Magic links are the event-day fallback — the path is alive

`POST /v1/auth/request-link` + `/verify` (the `/verifica` redirect) still work for **every** role and are unchanged. They are the way in when Google is down, when a participant mistypes the address they registered with, when an account predates v6 (no password set), or when the reset mail does not arrive. Nothing in the UI links there any more, so:

- Type **http://localhost:3000/verify?token=…** (production: `https://<host>/verifica?token=…`) after minting a link, or
- mint one from the admin console, **Accessi staff** → the magic-link card, which shows it as a QR and as text for any e-mail and role and never mails it, or
- ask for one with `curl -X POST https://<api>/v1/auth/request-link -H 'content-type: application/json' -d '{"email":"guest@example.com","role":"participant"}'` and read it in Mailpit (local) or the mailbox.

Do not delete this path. `apps/api/test/v6-auth.test.ts` keeps a test that walks request-link → mail → verify → an authenticated gallery call; if it fails, participants have lost their fallback.

## Admin console, staff login and test tooling (v5)

Admins and photographers ask their magic link on **http://localhost:3000/staff** (e-mail + role; the home page form is for participants only; the page is not linked from anywhere, type the URL). A fresh database can also get an admin from `BOOTSTRAP_ADMINS=you@example.com` in `.env` (upserted when `dev:api` boots). Then http://localhost:3000/admin, sections by hash:

### Staff login with e-mail + password

Admins and photographers can also log in with **e-mail + password** (in v5 participants were magic-link only; since v6 they have passwords too, see the participant section above). This is what the new `frontend/` apps use: the admin area (`frontend/apps/admin`) and the photographer area (`frontend/apps/fotografi`) show a credentials form first, with the magic link kept as a fallback link.

- **Endpoint:** `POST /v1/auth/login` `{ email, password, role }` (role `photographer` or `admin`) → sets the `rephoto_session` cookie, same as a verified magic link. Wrong credentials → `401`.
- **Create / reset credentials (admin-only):** `POST /v1/admin/staff` `{ email, role, password, eventId? }` creates the account if missing, sets the password (scrypt-hashed in `users.password_hash`, migration `008_staff_passwords.sql`), and attaches a photographer to `eventId` when given. In the admin UI it is the **Accessi staff** page (`/admin/link`), card “Credenziali con password” (with a password generator).
- **Local dev credentials** (seeded only when `SEED_DEMO` is on, i.e. not in production, and never overwriting a password already set — see `seedStaffCredentials` in `apps/api/src/bootstrap.ts`):
  - admin — `admin@rephoto.local` / `rephoto-admin`
  - photographer — `photographer@rephoto.local` / `rephoto-foto`
  - override the defaults with `DEV_ADMIN_PASSWORD` / `DEV_PHOTOGRAPHER_PASSWORD` in `.env`.

With the `frontend/` apps running (admin on `:5192`, fotografi on `:5191`), sign in at the app root with those credentials; create more staff from **Accessi staff** and hand each person their e-mail + password.



| Section | What it does | API |
| --- | --- | --- |
| **Stato** (`#stato`) | photos by status, queue by job type with the oldest age, last 20 job errors, face-service probe; refreshes every 10 s | `GET /v1/admin/metrics` |
| **Eventi** | list with counts, create an event (slug, name, retention, access); the selected event drives every other section (default: the runtime slug from `/api/config`) | `GET` / `POST /v1/admin/events` |
| **Link di accesso** / **Accessi staff** | create staff credentials (e-mail + password) for photographers/admins, and mint a magic link for any e-mail and role, shown as a QR and as text, never mailed; a photographer is created and attached to the selected event | `POST /v1/admin/staff`, `POST /v1/admin/magic-links` |
| **Gallerie** | a participant's gallery by e-mail (score and source on every cell, reason, anchors; «Elimina la galleria», «Rifai il confronto» with `KEEP_SELFIES`), the paged list of galleries | `GET /v1/admin/galleries`, `DELETE` / `rematch` |
| **Foto** | search by filename prefix, sha256, status, tag → `/admin/foto/<id>`: the web rendition with the stored face boxes, each face's «Vicini» (nearest faces of the event with the raw cosine), the galleries the photo is in | `GET /v1/admin/photos`, `/photos/:id`, `/faces/:externalId/neighbours` |
| **Esporta** | the three CSV downloads (galleries, match hits, feedback) and the match-run log with `kept` / `maxCosine` per run | `GET /v1/admin/export/*.csv`, `/match-runs` |
| **Gestione** | the v4 panels bound to the selected event: access `open` / `list`, invite a photographer, import participants, delete a photo or a participant | unchanged routes |
| **Reset** | «Azzera adesso» after typing the slug: a `reset` job deletes photos, faces, vectors, galleries and match log of the event; users stay | `POST /v1/admin/events/:id/reset` |

Participants get, in the gallery, a reason banner when the selfie produced nothing, «Non sono io» in the viewer and on the selection bar (hidden photos move to a collapsed «Nascoste» group, «Sono io» brings them back), and `?debug=1` (remembered in `localStorage rephoto.debug`; `?debug=0` clears it) to see `score · source` on every cell.

**Seed and ingest** (both read `.env`): `pnpm seed:test -- --event demo --photographers 2 --participants 20 --out ./seed` creates the event when missing, an admin (`admin@test.rephoto.local` by default), photographers in `event_photographers`, participants with a consent row, and writes pre-minted session cookies (`seed/cookies-*.txt` for k6, `users-demo.csv` mode 0600, `subjects.csv` for `scripts/eval`); `--purge-users` removes them. `pnpm ingest -- --dir photo/ --event demo --photographer photographer@rephoto.local --manifest manifest.csv` writes the photos straight into MinIO and `photos` (same rows and `derive` job as `uploads/complete`, `--parallel 8`, `--rate`, `--synth N` copies with real faces and a `synth` tag, `--state` to resume, `--web-first`, `--convert` for HEIC / PNG / TIFF, `--dry-run`): details in `scripts/ingest/README.md`. The evaluation scripts (`scripts/eval/README.md`: `offline-search.py`, `evaluate.py`, `synth.py`, the null-selfie protocol) need a Python venv with `requirements-eval.txt`. Photos ingested with `--tags` are searchable by tag in **Foto**.

To put photos back after a long face-service outage: `curl -X POST localhost:8787/v1/admin/photos/requeue -H 'content-type: application/json' -b "rephoto_session=<admin cookie>" -d '{"eventId":"<uuid>"}'` (photos in `error` go back to `uploaded` / `processing` and get a `derive` or `index` job).

## Selfie with the camera

`/selfie` opens the front camera and runs the challenge (look → left → right → blink → automatic capture) with MediaPipe Face Landmarker, loaded from `/mediapipe/` on our own origin. Two prerequisites, otherwise the page silently falls back to the file picker (`liveness = file` in `audit_log`):

- **A secure context**: `https://` or `http://localhost` (`getUserMedia` is unavailable on a plain `http://<lan-ip>`; to try from a phone use a tunnel with TLS or `next dev --experimental-https`).
- **The MediaPipe files in `apps/web/public/mediapipe/`** (git-ignored). `pnpm --filter @rephoto/web build` fetches them through the `prebuild` script; for `dev:web` run it once by hand: `node apps/web/scripts/fetch-mediapipe.mjs` (copies the wasm runtime from `node_modules` and downloads the ~3.6 MB `face_landmarker.task` from Google Storage; idempotent). Offline, the script prints `mediapipe: WARNING model not available` and the build still succeeds with the camera challenge disabled; set `MEDIAPIPE_MODEL_REQUIRED=1` to make that fatal (the web Dockerfile does, so a production image build fails rather than ship without the model).

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
| `INSIGHTFACE_MIN_COSINE`, `INSIGHTFACE_SURE_COSINE` | `0.50`, `0.70` | Cosine ↔ score 0.8 / 1.0. `SURE` must be greater than `MIN` (0.45 / 0.65 until v4) |
| `INSIGHTFACE_ATTACH_MIN_COSINE`, `INSIGHTFACE_ANCHOR_MIN_COSINE` | `0.55`, = `SURE` | v5. `attach` anchor threshold; minimum cosine for a match to become an anchor |
| `INSIGHTFACE_MAX_FACES`, `INSIGHTFACE_INDEX_MAX_FACES`, `INSIGHTFACE_MIN_FACE_QUALITY` | `200`, `100`, `0.2` | Search limit; faces asked per indexed photo (max 150); minimum face quality to index |
| `SELFIE_MIN_FACE_PX`, `SELFIE_MIN_QUALITY` | `120`, `0.6` | v5. Selfie gate in `match` (reasons `face_too_small` / `low_quality`) |
| `FACE_INDEX_SOURCE`, `FACE_DETECT_LONG_EDGE` | `original` (insightface) \| `web`, `2560` | v5. What `index` sends: a 2560 px JPEG from the original, or the 1600 px web derivative |
| `MATCH_LOG`, `KEEP_SELFIES`, `LOG_IDS` | `false` | v5 test switches: match log with raw cosines; keep selfie objects (+ `galleries.selfie_key`); ids in worker log lines |
| `FACE_INDEX_TPS`, `FACE_SEARCH_TPS` | `20` | Token buckets per process for the InsightFace engine (also honoured by Rekognition when the `REKOGNITION_*_TPS` names are blank) |
| `LIVENESS_CHECK` | `false` | Server-side anti-spoofing in the `match` job (InsightFace only) |
| `MAGIC_LINK_PER_EMAIL`, `MAGIC_LINK_PER_IP`, `SELFIE_MAX_PER_HOUR` | `3`, `20`, `5` | v5. Rate limits per hour; `0` = off |
| `RATE_LIMIT_EXEMPT_IPS` | empty | v5. Comma-separated IPs / CIDRs that skip the limits |
| `BOOTSTRAP_ADMINS` | empty | v5. Comma-separated e-mails upserted as admin when the API boots |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL` | unset | v6. Google OIDC client. All three together or none: a partial set fails env validation at boot, and with none set `/v1/auth/google/*` answers `404`. The redirect URL must match the Google console entry, e.g. `https://<host>/v1/auth/google/callback` |
| `OAUTH_STATE_SECRET` | = `SESSION_SECRET` | v6. HMAC key of the short-lived `rephoto_oauth` state/PKCE cookie (min 16 chars). Rotating it only invalidates sign-ins in flight |
| `REGISTER_PER_IP`, `REGISTER_PER_CODE` | `20`, `600` | v6. Self-registrations per hour per client IP and per event code; `0` = off. In-process counters (per API instance, lost on restart) — the hard cap is `event_codes.max_uses` |
| `PASSWORD_RESET_PER_USER`, `PASSWORD_RESET_PER_IP` | `3`, `20` | v6 hardening. Password-reset links per hour per account and per client IP; `0` = off. Counted on `password_reset_tokens`, so this budget is independent of `MAGIC_LINK_PER_*` |
| `NEXT_PUBLIC_GOOGLE_LOGIN` | unset | v6, web build-time: `true` shows «Accedi con Google» on `/`. Leave unset when no Google client is configured, otherwise the button leads to a `404` |
| `FACE_DET_LONG_EDGE`, `FACE_DET_SIZE`, `FACE_SERVICE_WORKERS`, `FACE_MODEL_CONCURRENCY` | `2560`, `1024`, `1`, `2` | v5, compose only: face-service detection resolution, uvicorn processes (≈ 1–1.5 GB RSS each), inferences per process |
| `WORKER_CONCURRENCY` | `4` | Jobs in flight per worker process (1–32). The face-service runs two inferences at once per process; more jobs only queue inside it |
| `REKOGNITION_INDEX_TPS`, `REKOGNITION_SEARCH_TPS` | `5` | Token buckets for Rekognition. Ignored with `fake` and `insightface` |
| `DATABASE_POOL_MAX` | `10` | Pool size of the API process (the InsightFace engine opens its own pool of 4) |
| `TRUSTED_PROXY_HOPS` | `1` | How many proxies append to `x-forwarded-for` before the API (the Next.js proxy counts as one) |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_STARTTLS` | unset / unset / port-based / `auto` | Leave unset for Mailpit (no AUTH, no TLS). A provider on 587 wants both credentials and `SMTP_STARTTLS=true`; on 465 `SMTP_SECURE` defaults to `true` |
| `S3_PUBLIC_ENDPOINT` | unset | Only for MinIO behind a proxy (`deploy/`): host used in presigned URLs. Locally the browser reaches MinIO on `localhost:9000` directly |
| `WORKER_PUBLISH_METRICS` | `false` | CloudWatch export; keep `false` |
| `NEXT_PUBLIC_EVENT_SLUG` | `demo` | Build-time event slug, used until `/api/config` answers |
| `EVENT_SLUG` | unset | v5. Runtime slug served by the web route `GET /api/config` (`{ eventSlug }`); falls back to `NEXT_PUBLIC_EVENT_SLUG`. Lets you point the pages at a new event without rebuilding the web |
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
pnpm test
```

`node --test` over thirteen files, no Docker needed: `packages/contracts/src/collection-id.test.ts`, `packages/contracts/src/jobs.test.ts` (priorities, `reset` dedupe), `packages/face-engine/src/face-engine.test.ts`, `packages/face-engine/src/insightface.test.ts` (cosine mapping, quality filter, chunked deletes, error names, `searchByVector`, delete-before-insert, the embed timeout, with a stubbed service and a stubbed `sql`), `packages/db/src/memory.test.ts`, `apps/worker/test/mvp.test.ts`, `apps/worker/test/v2.test.ts`, `apps/worker/test/v3.test.ts` (two-stage derive and `verify`), `apps/worker/test/v4.test.ts` (liveness gate in `match`), `apps/worker/test/v5.test.ts` (selfie gate reasons, anchors at `ANCHOR_MIN`, selfie-vector attach, anchor quorum, `MATCH_LOG`, `KEEP_SELFIES`, re-index anchors, `FACE_INDEX_SOURCE`, requeue + breaker, heartbeat and `finished_at`, `index` before `derive`, `LOG_IDS`, `reset`), `apps/web/lib/resize.worker.test.ts` (1600 px render geometry), `apps/api/test/routes.test.ts` (including presigned host = `S3_PUBLIC_ENDPOINT`, the selfie `liveness` audit row, and the v5 admin routes, feedback, CSV exports, env rate limits with exempt IPs), `apps/api/test/mailer.test.ts` (nodemailer options from the SMTP env). They use `MemoryDatabase`, the fake engine with an in-memory store (which also implements `embedSelfie` / `searchByVector` / `faceEmbedding` on a synthetic vector), and in-memory object store / mailer / queue. `scripts/eval/evaluate.py` has a fixture run described in `scripts/eval/README.md`.

**Integration test of the InsightFace engine** (real Postgres + real service), skipped by `pnpm test` unless both are reachable:

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

The stubbed tests (`test_engine.py`, `test_images.py`, `test_liveness.py`, `test_api_stub.py`: bbox normalisation, quality, `yaw` sign, `norm`, size and `max_faces` caps, semaphores, `/metrics`, error codes) always run; `test_api_real.py` loads the real model (small faces at 1600 / 640 vs 2560 / 1024, mirrored `yaw`, latencies, also on the 20 MP photos in `photo/` when present) and is skipped with a reason when the pack is not available.

## Load test

k6 scripts for the two hot paths (photographer upload, participant selfie with polling until `ready`) are in `scripts/loadtest/` with their own README: how to obtain session cookies (`pnpm seed:test` writes them ready to use), how to run against local or against a deployed stack, thresholds. The test-campaign stack on a VPS (`deploy/compose.test.yml`, `status.sh`, `reset-event.sh`, the protocol) is in `deploy/README.md` §9 bis.

## Useful endpoints while developing

- `GET /health` (`select 1` with a 2 s timeout; `503` when Postgres is down).
- `GET http://localhost:8090/health`: face-service model loaded; `curl -F image=@foto.jpg "localhost:8090/v1/embed?max_faces=10"` to see faces, scores and 512-d embeddings; `curl -F image=@selfie.jpg localhost:8090/v1/liveness`.
- `GET /v1/uploads/summary?eventId=…` as a photographer: counts of sessions and photos by status plus `originalsPending`, the same the `/upload` page polls every 10 s.
- `GET /v1/uploads/lookup?eventId=…&sha256=…` as a photographer: `photoId`, `originalStatus` and `status` of an own photo, `404` otherwise.
- `GET /v1/admin/metrics` as admin: queue depth (`jobsQueued`, `jobsRunning`, `jobsError`), `photosByStatus`, `originalsPending`, and since v5 `jobsByType` (with the oldest queued age), `lastErrors`, `faceService: { ok, ms }`; `photos` / `faces` / `users` are approximate on Postgres (`n_live_tup`).
- `GET http://localhost:8090/metrics`: face-service counters and embed p50 / p95 over the last 500 calls.
- Worker stdout: one JSON line per job (`{ ts, job, type, ms, outcome, liveness?, match?, reason?, hits? }`, plus the ids with `LOG_IDS=true`).
- `psql`: `select event_id, count(*) from face_vectors group by 1`; `select user_id, last_match_reason, query_embedding is not null as has_vector, cardinality(anchor_face_ids) from galleries`; `select type, status, count(*), round(avg(duration_ms)) from jobs group by 1, 2`; `select action, meta from audit_log order by created_at desc limit 10` (`selfie.submitted` rows carry `meta.liveness`; v5 adds `magic_link.issued`, `gallery.feedback`, `event.reset`, …).

## Deploy su Coolify (framesofme.com)

The test deployment runs from `docker-compose.coolify.yml` on Coolify. Public exposure is a Cloudflare Tunnel → Coolify's Traefik, so no host ports are published; you map an FQDN per service in the Coolify UI.

1. **New resource**: Coolify → project *RePhoto* → environment *test* → **+ New** → **Docker Compose** → source = the GitHub repo `rub3nino/rephoto`, branch `main`, compose file `docker-compose.coolify.yml`. Enable **automatic deploy on push**.
2. **Environment variables** (Coolify → the resource → *Environment Variables*): set the values from the *Production / Coolify* block in `.env.example`. At minimum `SESSION_SECRET` (32+ random chars), `S3_ACCESS_KEY` / `S3_SECRET_KEY`, `POSTGRES_PASSWORD`, `WEB_ORIGIN`, `API_ORIGIN`, `S3_ENDPOINT=https://s3.framesofme.com`, `NEXT_PUBLIC_WEB_ORIGIN`, `NEXT_PUBLIC_MEDIA_ORIGINS=https://s3.framesofme.com`, `SMTP_FROM`, `BOOTSTRAP_ADMINS`. The `NEXT_PUBLIC_*` ones are build-time — set them as **Build Variables** too. Do **not** set `SEED_DEMO` on api/worker (it is forced on the one-shot `migrate` service only).
3. **Domains (FQDN per service)** in each service's *Domains* field:
   - `web` → `https://framesofme.com` (+ `https://www.framesofme.com`), container port **3000**
   - `api` → `https://api.framesofme.com`, container port **8787**
   - `minio` → `https://s3.framesofme.com`, container port **9000**
   - `mailpit` → `https://mail.framesofme.com`, container port **8025** (keep behind Cloudflare Access)
4. **Deploy**. On first boot: `migrate` runs once (schema + demo event) and exits 0, then `api` and `worker` start; `minio-init` creates the bucket and the 24 h expiry rule for `selfies/`. `FACE_ENGINE=fake` by default — for real matching set `FACE_ENGINE=insightface` and keep the `face-service` (needs more RAM; first build pulls the ~280 MB model).
5. **Verify**: `https://api.framesofme.com/health` → 200, `https://framesofme.com/` → 200, `https://framesofme.com/v1/events/demo` → 200.

Cloudflare Tunnel: point the tunnel at Coolify's Traefik (the proxy's `:80`/`:443`), with a public hostname per FQDN above. No inbound ports are opened on the host.

A local smoke test of the same file (host-port-free; a throwaway project name so it does not touch the dev stack, and `--env-file /dev/null` so the repo's local `.env` does not override the in-file defaults — Coolify injects its own env instead):

```sh
docker compose -p rephoto-coolify --env-file /dev/null -f docker-compose.coolify.yml up -d --build
docker compose -p rephoto-coolify --env-file /dev/null -f docker-compose.coolify.yml exec -T api \
  node -e "fetch('http://127.0.0.1:8787/health').then(r=>console.log(r.status))"
docker compose -p rephoto-coolify --env-file /dev/null -f docker-compose.coolify.yml down -v
```

## Production

Self-hosted VPS (primary): `deploy/README.md` (first deploy, update, backup, mail provider, event days) and `docs/infra.md` (topology, sizing, runbook). AWS alternative: `infra/cdk` (`npm run synth` there works offline with `CDK_DEFAULT_ACCOUNT=123456789012`), `docs/infra.md` §8, `docs/ses-produzione.md`.
