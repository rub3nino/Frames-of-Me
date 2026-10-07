# Frames of Me v5 — implementation spec for the test campaign

Source analysis: `docs/test-readiness.md`. Everything here is additive to the frozen v4 contract (new columns, new routes, new env vars, new scripts). Code/comments English, UI Italian.

Migration numbers are reserved: **006** = recognition + match log (agent A: `galleries.query_embedding`, `galleries.last_match_reason`, `galleries.selfie_key`, `face_vectors` FK, `jobs.finished_at/duration_ms`, tables `match_runs` and `match_hits`), **007** = test tooling (agent D: `photos.filename/tags`, `gallery_feedback`). Shared files (`packages/db/src/{types,postgres,memory}.ts`, `packages/contracts/src/{env,http}.ts`, `apps/api/src/routes.ts`, `apps/web/app/globals.css`) are edited by two agents at once: add new members at the END of the relevant interface/class/object/file, never reformat, never rename, re-read before each edit.

---

## A. Recognition (agent A: engine + worker + contracts + db 006)

### A1. Thresholds and anchors
- New env (after the `INSIGHTFACE_*` block in `env.ts`): `INSIGHTFACE_ATTACH_MIN_COSINE` (number 0..1, default **0.55**), `INSIGHTFACE_ANCHOR_MIN_COSINE` (default = `INSIGHTFACE_SURE_COSINE`), `SELFIE_MIN_FACE_PX` (int, default **120**), `SELFIE_MIN_QUALITY` (number, default **0.6**). Defaults of existing vars change: `INSIGHTFACE_MIN_COSINE` **0.50**, `INSIGHTFACE_SURE_COSINE` **0.70**, `INSIGHTFACE_MIN_FACE_QUALITY` **0.2**, `INSIGHTFACE_MAX_FACES` **200**.
- `FaceEngine` additions (`packages/face-engine/src/types.ts`, optional methods so fake/rekognition keep compiling): `embedSelfie?(input: { imageBytes, contentType }): Promise<{ faces: Array<{ bbox, score, quality, embedding: number[] }>, width, height }>` and `searchByVector?(input: { eventId, embedding: number[], minCosine?: number, maxFaces?: number }): Promise<Array<SearchHit & { cosine: number }>>`. `SearchHit` gains optional `cosine?: number` (raw). InsightFace implements both; `searchFaces` also returns `cosine`.
- `match` (worker): 
  1. embed the selfie via `embedSelfie` when available (else fall back to `search` as today). Reject when: no face → reason `no_face`; largest face long edge < `SELFIE_MIN_FACE_PX` (in the selfie's own pixels) → `face_too_small`; quality < `SELFIE_MIN_QUALITY` → `low_quality`; a second face with area ≥ 50 % of the largest → `multiple_faces`. On reject: `replaceGallery(user, event, [], [])`, `galleries.last_match_reason = <reason>`, selfie deleted, email `ready` NOT sent, log `{ match: "rejected", reason }`.
  2. search with `searchByVector` (`minCosine = INSIGHTFACE_MIN_COSINE`), keep best per photo as today.
  3. anchors = external ids of hits with `cosine ≥ INSIGHTFACE_ANCHOR_MIN_COSINE` (max 5, best first) — never below.
  4. **store the selfie vector**: `galleries.query_embedding vector(512)` (migration 006, nullable; also a plain `real[]`/`text` fallback is NOT needed — pgvector is required for insightface anyway; for Memory/fake store the number[] in memory). `last_match_reason = null` on success, or `no_photos_yet` when 0 hits (gallery empty but query vector stored).
- `attach` (worker): for each face of the new photo, candidates = galleries whose anchors match (as today, but with `cosine ≥ INSIGHTFACE_ATTACH_MIN_COSINE`) **plus** galleries whose `query_embedding` has `cosine ≥ INSIGHTFACE_MIN_COSINE` with the face vector (`db.findGalleriesByQueryVector(eventId, embedding, minCosine)` — pgvector query over `galleries`, HNSW index on `query_embedding`). Score stored = mapped similarity of the best of (query cosine, anchor cosine); for anchor-only hits with ≥ 3 anchors require ≥ 2 agreeing anchors. `countAnchoredGalleries` becomes "galleries with anchors or query vector".
- Gallery response (`galleryResponseSchema` + route): add `reason: "no_face" | "face_too_small" | "low_quality" | "multiple_faces" | "no_photos_yet" | "liveness" | null` (from `galleries.last_match_reason`; the liveness gate writes `liveness`). Web (agent D) shows it.
- `removeAnchors` is also called from `purgePhoto` and from the re-index path in `index` (before `replaceFaces`).

### A2. Data consistency
- `index`: `faces.deleteByPhoto` on the vector store before inserting — InsightFace `indexPhoto` first runs `delete from face_vectors where photo_id = $1`. Migration 006 adds `foreign key (photo_id) references photos(id) on delete cascade` to `face_vectors` (guarded in a DO block like 005: only when the table exists) and the engine's self-healing DDL includes it.
- `face_vectors` orphans: `scripts` not needed; FK solves it.

### A3. Detection resolution (engine side)
- The engine sends the **web derivative** today (1600 px). Add env `FACE_INDEX_SOURCE` = `web` | `original` (default **`original`** for insightface): with `original`, `index` reads the original (present) or the web derivative (pending), and the face-service receives up to 8 MiB — originals are larger: the worker renders a **detection JPEG** (long edge `FACE_DETECT_LONG_EDGE`, default **2560**, quality 85) with sharp before posting (same `renderJpeg` helper; cache nothing). `faces.bbox` stays normalised so nothing else changes.
- Pass `max_faces=100` and `min_size=24` to `/v1/embed` (engine constants, env `INSIGHTFACE_INDEX_MAX_FACES` default 100).

### B. Robustness (agent A too)
- `run.ts`: `FaceServiceUnavailable` → `requeue` (no attempt increment, 5 s) like a throttle; additionally a per-process circuit breaker: after 5 consecutive unavailables, pause claiming `index`/`attach`/`match` for 30 s (log once).
- `jobs.ts`: `JOB_PRIORITY.index = 40` (before derive 50; attach 30 stays first).
- Engine `fetch`: `AbortSignal.timeout(60_000)` on embed/search, 10 s on health.
- Heartbeat: worker refreshes `claimed_at` every 2 min for in-flight jobs (`db.touchJob(id)`); `STALE_RUNNING_MS` stays 10 min.
- Migration 006: `jobs.finished_at timestamptz null`, `jobs.duration_ms int null` written by `completeJob`/`failJob`/`failJobTerminal`/`requeueJob` (duration from `claimed_at`).
- `POST /v1/admin/photos/requeue` `{ eventId, status?: "error", errorLike?: string }` → resets matching photos to `uploaded` (or `processing` when derivatives exist) and enqueues `derive` (or `index` when the web derivative exists) → `{ requeued }`. (Route belongs to agent A; append at the end of `registerRoutes`.)
- `admin/metrics` counts use `pg_stat_user_tables.n_live_tup` for `photos`, `faces`, `users`, `jobs` (approximate; Memory keeps exact).
- Worker log lines gain `photoId`/`userId`/`eventId` when `LOG_IDS=true`.

Tests: worker (reject reasons, anchors threshold, query-vector attach, unavailable → requeue + breaker, heartbeat, priority), engine (searchByVector mapping, delete-before-insert, timeout), api (gallery `reason`, requeue route). Keep every existing test green.

---

## C. Face-service (agent B: `apps/face-service/**`, its Dockerfile, `deploy/compose.yml` face-service block only, `docker-compose.yml` face-service block only)
- Env: `DET_LONG_EDGE` (default **2560**; `images.py` max long edge now configurable), `DET_SIZE` default **1024**, `UVICORN_WORKERS` (default 1; Dockerfile CMD uses it), `MODEL_CONCURRENCY` (default 2), `DECODE_CONCURRENCY` (default 4: semaphore around Pillow decode), `MAX_FACES_CAP` 150 (query `max_faces` 1–150).
- `/v1/embed` response gains per face `norm` (pre-normalisation embedding L2 norm) and `yaw` (estimate from the 5 kps: nose x relative to eye centre / eye distance, in [-1, 1]); `quality` stays the current formula (the engine may use norm/yaw later).
- Latency log line unchanged; add `/metrics` plain-text (requests, p50/p95 of the last 500 embed calls, faces returned) — no Prometheus dependency.
- Tests updated (stub + real-model): resolution path, yaw sign, caps, concurrency env. README updated (Italian). `deploy/compose.yml` face-service: `UVICORN_WORKERS=${FACE_SERVICE_WORKERS:-1}`, `DET_SIZE=${FACE_DET_SIZE:-1024}`, `DET_LONG_EDGE=${FACE_DET_LONG_EDGE:-2560}`; `.env.production.example` lines added by agent C (ops) — agent B reports the names.

---

## D. Admin and participant tooling (agent D: `apps/api/src/routes.ts` admin section, `packages/contracts/src/http.ts`, `packages/db/**` (007), `apps/web/app/admin/**`, `apps/web/components/{gallery,viewer}.tsx`, `apps/web/app/page.tsx` + new `apps/web/app/staff/page.tsx`, `apps/web/lib/{types,event}.ts`, `apps/api/test/routes.test.ts`)

Migration **007_test_tooling.sql**:
```sql
alter table photos add column filename text null;
alter table photos add column tags text[] not null default '{}';
create index photos_event_filename_idx on photos (event_id, filename);
-- (defined in 006 by agent A, shown here for reference)
create table match_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  liveness text null, reason text null, selfie_sha256 text null, selfie_faces int null,
  engine_ms int null, hits int not null default 0, created_at timestamptz not null default now()
);
create index match_runs_user_event_idx on match_runs (user_id, event_id, created_at desc);
create table match_hits (
  run_id uuid not null references match_runs(id) on delete cascade,
  photo_id uuid not null, external_face_id text not null,
  cosine real not null, similarity real not null, kept boolean not null,
  primary key (run_id, photo_id, external_face_id)
);
create table gallery_feedback (
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  photo_id uuid not null references photos(id) on delete cascade,
  verdict text not null check (verdict in ('me','not_me')),
  score_at_time double precision null, created_at timestamptz not null default now(),
  primary key (user_id, event_id, photo_id)
);
```
`match_runs`/`match_hits` (tables in **006**, agent A) are written by the worker's `match` when env `MATCH_LOG=true` (agent A: `db.insertMatchRun(input: { userId, eventId, liveness, reason, selfieSha256, selfieFaces, engineMs, hits }): Promise<string>`, `db.insertMatchHits(runId, hits: Array<{ photoId, externalFaceId, cosine, similarity, kept }>)`; with `MATCH_LOG` the engine's `searchByVector` is called with `minCosine = 0.25`, the gallery keeps only ≥ MIN, all hits are logged). Agent D only READS them (`listMatchRuns`, CSV export) against the table definition above. `KEEP_SELFIES` + `galleries.selfie_key` are also agent A's (worker side); agent D adds the rematch route that reads `selfie_key`.

Env (`env.ts`, after the SMTP block — agent D): `MAGIC_LINK_PER_EMAIL` (int, default 3), `MAGIC_LINK_PER_IP` (default 20; 0 = off), `SELFIE_MAX_PER_HOUR` (default 5; 0 = off), `RATE_LIMIT_EXEMPT_IPS` (comma-separated IPs/CIDRs, default empty), `BOOTSTRAP_ADMINS` (comma-separated emails upserted as admin at API boot). Agent A adds (after the INSIGHTFACE block): `MATCH_LOG` (boolean, default false), `KEEP_SELFIES` (boolean, default false), `LOG_IDS` (boolean, default false), `FACE_INDEX_SOURCE`, `FACE_DETECT_LONG_EDGE`, `INSIGHTFACE_INDEX_MAX_FACES`.

Routes (all admin unless noted; append at the end of `registerRoutes`, before agent A's requeue route or after — order irrelevant):
- `POST /v1/admin/events { slug, name, retentionDays?, access? }` → 201 event; `GET /v1/admin/events` → `{ events: [{ ...event, photos, galleries, participants, photographers }] }`.
- `POST /v1/admin/magic-links { email, role, eventId? }` → `{ url }` (raw link, not mailed; audit `magic_link.issued`); for `photographer` also inserts the user + `event_photographers` when `eventId` given.
- `GET /v1/admin/galleries?eventId=&email=` → `{ user, gallery: { id, matchedAt, anchorFaceIds, reason, total }, items: [...gallery items + faceId + photo { sha256, filename }] }`; `GET /v1/admin/galleries?eventId=&cursor=` → list `{ galleries: [{ userId, email, total, matchedAt, reason }], nextCursor }`.
- `GET /v1/admin/photos/:id` → `{ photo, webUrl, thumbUrl, faces: [{ id, externalId, bbox, confidence }], galleries: [{ userId, email, score, source, faceId }] }`; `GET /v1/admin/faces/:externalId/neighbours?eventId=&limit=20` → `[{ externalFaceId, photoId, cosine, similarity }]` via `engine.searchFaces` (needs `cosine` from agent A — until then compute from similarity inverse mapping).
- `GET /v1/admin/photos?eventId=&sha256=&filename=&status=&photographerId=&tag=&cursor=&limit=` keyset.
- `POST /v1/admin/galleries/:userId/:eventId/rematch` (requires `KEEP_SELFIES` and a stored `selfie_key`) → enqueues `match`; `DELETE /v1/admin/galleries/:userId/:eventId`.
- `POST /v1/admin/events/:id/reset { confirm: slug }` → enqueues a `purge_event` job? No: do it inline in batches is too slow for 150k; add job type **`reset`** `{ eventId, actorId }` (agent A owns jobs.ts: add `reset` priority 90, dedupe `reset:{eventId}`; agent A implements the worker handler = retention with cutoff `now` + delete galleries + match_runs + `deleteCollection`). Route returns `{ jobId }`.
- `GET /v1/admin/export/galleries.csv?eventId=` (stream) and `GET /v1/admin/export/match-hits.csv?eventId=`, `GET /v1/admin/export/feedback.csv?eventId=`.
- `GET /v1/admin/match-runs?eventId=&email=&cursor=` → runs with hits summary.
- Participant: `POST /v1/events/:slug/gallery/feedback { photoId, verdict }` → 201; `GET .../gallery` items gain `feedback: "me" | "not_me" | null`; `replaceGallery` keeps `not_me` photos out of the gallery (filter at read time: items with `not_me` are returned with the flag; UI hides them under "Nascoste").
- Rate limits read the env values; exempt IPs skip both limits; `uploads/init` stores `filename` and optional `tags`.
- `GET /v1/events/:slug` unchanged; `apps/web/lib/event.ts`: slug at runtime: web route `/api/config` (Next route handler) returning `{ eventSlug: process.env.EVENT_SLUG ?? NEXT_PUBLIC_EVENT_SLUG ?? "demo" }` read once by a client hook `useEventSlug()`; pages keep working with the build-time value as fallback.

Web: `/staff` page (email + role photographer/admin → request-link); admin page sections: Eventi (create/list), Link di accesso (issue + show QR via a tiny inline QR renderer — no dependency, use a small SVG QR implementation or `qrcode` npm package… use npm `qrcode` (tiny)), Gallerie (search by email → grid with score overlay → open photo debug), Foto (search by filename/sha → debug page `/admin/foto/[id]` with SVG bbox overlay, faces list → neighbours with cosine, galleries list), Stato (jobs by type/status with oldest age, photos by status, last errors, face-service probe — API: extend `admin/metrics` with `jobsByType`, `oldestQueuedSeconds`, `lastErrors`, `faceService`), Esporta (3 CSV links), Reset evento (double confirm). Participant gallery: `reason` banner texts (Italian), "Non sono io" in viewer and bulk, hidden group, `?debug=1`/`localStorage rephoto.debug` shows score + source on cells.

Tests: api routes for each new route (authz, shapes), rate-limit env + exempt IP, feedback filter. Web typecheck + build.

---

## E. Ops tooling (agent C: `scripts/ingest/**`, `scripts/eval/**`, `scripts/seed-test.ts`, `deploy/scripts/{status.sh,reset-event.sh}`, `deploy/compose.test.yml`, `deploy/.env.production.example` (append), `deploy/README.md` (test section), `scripts/loadtest/README.md`, root `package.json` scripts)
- `scripts/ingest/ingest.ts` (TypeScript, runs with `node --import tsx`, uses `@rephoto/db`, `@rephoto/api/objects`, `@rephoto/contracts`, `@aws-sdk/lib-storage`): `--dir`, `--event <slug>`, `--photographer <email>`, `--parallel 8`, `--rate <photos/s>`, `--synth <N>` (repeat K real photos with random padding after EOI so sha256 differs), `--state <jsonl>` (resume), `--manifest <csv>` (`filename,sha256,photoId,status,bytes,ms`), `--tags a,b`, `--convert` (HEIC/PNG/TIFF → JPEG q92 via sharp when decodable), `--web-first` (render 1600 web + original present). Direct to MinIO + DB (no HTTP), identical rows/jobs to `uploads/complete`. Streams sha256. Progress line every 100 files.
- `scripts/seed-test.ts`: creates event(s), admin, N photographers (+membership), M participants (+consent), pre-minted sessions → writes `cookies-*.txt` for k6; `--purge-users` option.
- `scripts/eval/offline-search.py` (venv: uses the face-service HTTP `/v1/embed` + psql via `psycopg[binary]`): for each selfie file → all cosines over `face_vectors` of the event → CSV. `scripts/eval/evaluate.py`: inputs `labels.csv` (subject,filename), `manifest.csv`, `subjects.csv` (subject,email), galleries CSV export (or match-hits CSV) → per-subject and global precision/recall/F1, sure/maybe split, histograms (text + PNG via matplotlib optional), threshold sweep when cosines are available, FN by face size (needs `faces.csv` export: `photo_id,bbox` — document the `\copy`), `report.md`. `scripts/eval/synth.py`: portraits + backgrounds → crowd images at face sizes {24..300} px (on the 1600-px scale), rotation, blur, JPEG q, with auto `labels.csv`. `scripts/eval/null-selfie.md`: the protocol. `requirements-eval.txt`.
- `deploy/scripts/status.sh`: screen + CSV every N s as described in `docs/test-readiness.md` §4/§5 (queue depth/age per type, photos by status, face_vectors/galleries counts, throughput from `jobs.finished_at` (agent A adds it; until then from `claimed_at`), p50/p95 per job type from `duration_ms`, face-service `/metrics`, `docker stats`, `df`, `iostat` if present, last errors).
- `deploy/scripts/reset-event.sh <slug>`: stop worker/api, SQL cleanup (jobs, upload_sessions, face_vectors, photos cascade, galleries, match_runs), `mc rm` prefixes, `vacuum analyze`, start. (The in-app reset job of agent A/D is the online alternative.)
- `deploy/compose.test.yml`: override adding `mailpit` (SMTP sink + UI on `mail.${DOMAIN}` behind Caddy basic auth — Caddyfile snippet documented, since Caddyfile is owned by nobody else now: agent C may edit `deploy/Caddyfile` to add the optional `mail.` block guarded by comments), `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_STARTTLS=false`, bigger log rotation, Postgres `pg_stat_statements` + `log_min_duration_statement=500`, `backup` disabled (`profiles: ["backup"]`), `SEED_DEMO=false`, test env names for the new vars (`FACE_SERVICE_WORKERS`, `FACE_DET_SIZE`, `FACE_DET_LONG_EDGE`, `MATCH_LOG=true`, `KEEP_SELFIES=true`, rate limits off, `LOG_IDS=true`).
- `deploy/README.md`: "Campagna di test" section (sizing on real average size, disk, HTTPS options, how to run ingest/seed/status/reset, the test protocol from `docs/test-readiness.md` §7).

---

## F. Order and commits
Agents A, B, C, D run in parallel. The integrator (main session) runs the full test suite, typechecks, builds, the Python tests, a real end-to-end run (face-service + pgvector), then commits per area: `face-service`, `engine+worker`, `admin tooling`, `ops tooling`, then a review agent, a docs agent (`CONTRACTS.md` v5 additions, `docs/DPIA.md` for the stored selfie vector, `RUN.md`), final commit.
