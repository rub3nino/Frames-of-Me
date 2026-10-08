# Frames of Me v6 — implementation spec: albums, crowd gallery, Google login

Source: the product decisions taken on 2026-10-07 (conversation log) on top of the v5 code. Everything here is additive to v5 (new tables, new columns, new routes, new env vars). Code/comments English, UI Italian.

## Scope decisions (frozen — do not re-litigate)

1. **An event has N albums.** The admin creates them and sets, per album, who may upload, whether face recognition applies, visibility, moderation mode and retention.
2. **A `crowd` album NEVER gets face recognition.** Enforced by a database `check`, not by application code.
3. **The recognition flag is immutable once an album has its first upload.** Turning it on later would change the purpose of processing for media already uploaded under a different consent. To change it, create a new album.
4. **Video is OUT of v6.** Photos only. The design (reuse `photos` with `media_type`, H.264 passthrough, HEVC-only transcode, poster frame, separate low-concurrency worker) is recorded here so it is not lost, and is deferred to v7.
5. **Auth: Google OIDC + email/password self-registration gated by an event code.** Sign in with Apple is dropped. Magic links stay in the codebase as a hidden emergency fallback — do not delete that path.
6. **Moderation: 2 people, photos only.** Post-moderation (publish on upload) + automatic screening + a report button + per-user upload caps + a kill switch. No pre-moderation queue for photos.

## Two naming traps (read before touching the schema)

1. `galleries` already means **the per-user personal match gallery** — `unique (user_id, event_id)` in `001_init.sql:92`. It is NOT an admin-created gallery.
2. `collection` already means **a Rekognition face collection** (`rekognitionCollectionId` in `packages/contracts/src/face-engine.ts:18`, `REKOGNITION_COLLECTION_PREFIX`, the `reset` job's `deleteCollection`). Never reuse that word for the new entity.

The new entity is therefore **`albums`** (`album` is unused anywhere in the repo; the Italian UI reads "Album ufficiale" / "Album di tutti"). Never overload `galleries` or `collection`, never rename `galleries` in v6, and leave `gallery_items` alone: the personal-gallery feature works today and must keep working byte-for-byte after each migration.

## Migration numbers are reserved

**009** albums + `photos.album_id` (agent A) · **010** moderation + reports + caps (agent C) · **011** `face_vectors.album_id` + partial HNSW indexes (agent A) · **012** auth identities + event codes (agent B) · **013** tags (agent E).

Shared files (`packages/db/src/{types,postgres,memory}.ts`, `packages/contracts/src/{env,http}.ts`, `apps/api/src/routes.ts`, `apps/web/app/globals.css`) are edited by several agents at once: add new members at the END of the relevant interface/class/object/file, never reformat, never rename, re-read before each edit.

---

## A. Albums core and vector isolation (agent A: `packages/db/migrations/{009,011}`, `packages/db/src/**`, `packages/face-engine/src/insightface.ts`, `apps/worker/src/handlers.ts`, `packages/contracts/src/http.ts` albums section)

### A1. Migration 009 — albums

```sql
create table albums (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  slug text not null,
  name text not null,
  kind text not null check (kind in ('official', 'crowd')),
  recognition boolean not null default false,
  moderation text not null default 'post' check (moderation in ('pre', 'post', 'off')),
  visibility text not null default 'participants' check (visibility in ('participants', 'link', 'staff')),
  max_photos_per_user int null,
  uploads_open boolean not null default true,
  retention_days int null,
  first_upload_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (event_id, slug),
  constraint crowd_never_recognizes check (not (kind = 'crowd' and recognition))
);
```

- `first_upload_at` is set by the ingest path on the first media row. A trigger (or an explicit API guard with a matching test) refuses any change to `recognition` when `first_upload_at is not null`. Decision 3 above.
- **Backfill in the same migration**: one `official` album per existing event (`slug = 'ufficiale'`, `recognition = true`, `moderation = 'off'`, `visibility = 'participants'`). Behaviour after 009 must be identical to v5.

### A2. Migration 009 — `photos.album_id`

- Add `album_id uuid references albums (id) on delete cascade`, backfill from the event's official album, then `set not null`.
- **Drop `photos.unique (event_id, sha256)` and replace it with `unique (album_id, sha256)`.** With a crowd gallery, people re-upload the same WhatsApp-forwarded image: today the second upload fails with an opaque error. Dedup is done by an explicit select (there is no `on conflict (event_id, sha256)` in `postgres.ts`), so update that select too, and return "already uploaded" rather than an error.
- Index `(album_id, created_at)`.
- `photos.photographer_id` now also holds participants. Keep the column name in v6 (renaming touches too much code); add a comment in the migration saying it means "uploader".

### A3. Migration 011 — vectors per album

- `face_vectors.album_id uuid` (backfilled from `photos`), `not null` after backfill, FK `on delete cascade`.
- **Replace the global HNSW index with partial indexes per album**, or partition `face_vectors` by album. Today `SEARCH_SQL` (`insightface.ts:438`) orders by distance over a global index and filters `event_id` afterwards: with several albums per event, the filter discards neighbours already chosen by the index and recall drops. Every search path (`SEARCH_SQL`, `SEARCH_EXCLUDING_SQL`, `findGalleriesByQueryVector`) filters on `album_id` and must be served by an index that includes it.
- **Only albums with `recognition = true` are ever indexed.** The worker's `index` handler skips media whose album has `recognition = false` — no vectors are computed, none are stored. This is the second half of decision 2; the database `check` is the first.
- Deliverable: a short recall note in `docs/` measured on a seeded dataset with ≥ 2 albums, before/after the index change.

Tests: migration up on a copy of a v5 database with existing galleries (personal galleries must be unchanged); dedup across albums; recognition skipped for crowd; search filtered by album; `check` constraint rejects `kind='crowd' and recognition=true`; recognition flag immutable after first upload.

---

## B. Authentication (agent B: `packages/db/migrations/012`, `apps/api/src/{routes.ts auth section,crypto.ts}` + new `apps/api/src/oauth.ts`, `apps/web/app/page.tsx`, `apps/web/app/verify/**`, new `apps/web/app/registrati/**`, `packages/contracts/src/{env,http}.ts` auth section)

What already exists and must be reused, not rebuilt: `users.password_hash` (`008_staff_passwords.sql`), scrypt `hashPassword`/`verifyPassword` (`crypto.ts:15`), the password login route with constant-time verification (`routes.ts:143`, takes `role` in the body), sessions, invites, magic links.

### B1. Migration 012

```sql
create table user_identities (
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  subject text not null,
  email text null,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);
create index user_identities_user_idx on user_identities (user_id);

create table event_codes (
  event_id uuid not null references events (id) on delete cascade,
  code text not null,
  label text null,
  max_uses int null,
  uses int not null default 0,
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  primary key (event_id, code)
);
alter table users add column if not exists email_verified_at timestamptz null;
```

### B2. Google OIDC
- Authorization code + PKCE, one provider. New env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`, `OAUTH_STATE_SECRET`.
- Routes: `GET /v1/auth/google/start` (state + PKCE in a short-lived signed cookie) and `GET /v1/auth/google/callback` → find `user_identities(google, sub)`; else link by verified email to an existing `participant`; else create the user. Then `startSession`.
- `users.unique (email, role)` is unchanged: the same email may exist as participant and as photographer. Google login always resolves to `role = 'participant'` unless an identity row already points elsewhere.
- Never trust `email` from the token without `email_verified`.

### B3. Credential registration
- `POST /v1/auth/register { email, password, eventCode }` → validates the code against `event_codes` (uses, expiry), creates the `participant` with a scrypt hash, starts the session. The event code is the anti-bot gate and comes from the badge/QR already distributed.
- **Lazy email verification**: registration sends nothing. `email_verified_at` stays null; an email is only sent when the user asks for a password reset. This keeps the send volume in the hundreds, not thousands — the Resend free tier is 3,000/month capped at 100/day, which 6,000 same-day registrations would blow through instantly.
- Password rules: minimum 10 characters, rate limit per IP and per code, generic error messages (reuse `MESSAGES.loginInvalid`).
- The magic-link route stays and keeps working; it is only removed from the web UI. Document it in `RUN.md` as the event-day fallback.

Tests: PKCE/state round-trip, identity linking (new user, existing email, already linked), register with a valid/exhausted/expired/absent code, rate limits, that magic-link login still works.

---

## C. Crowd upload, camera and moderation (agent C: `packages/db/migrations/010`, `apps/api/src/routes.ts` upload + moderation sections, `apps/web/app/{upload,gallery}/**` + new `apps/web/components/camera.tsx`)

### C1. Migration 010

```sql
alter table photos add column moderation_state text not null default 'approved'
  check (moderation_state in ('pending', 'approved', 'rejected', 'auto_rejected'));
alter table photos add column moderated_by uuid null references users (id);
alter table photos add column moderated_at timestamptz null;
create index photos_moderation_idx on photos (album_id, moderation_state) where moderation_state <> 'approved';

create table reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos (id) on delete cascade,
  reporter_id uuid not null references users (id) on delete cascade,
  reason text not null check (reason in ('inappropriate', 'not_me', 'copyright', 'other')),
  note text null,
  state text not null default 'open' check (state in ('open', 'closed')),
  created_at timestamptz not null default now(),
  unique (photo_id, reporter_id)
);
```

`moderation_state` is a **separate** column from `photos.status` on purpose: `status` is the processing pipeline (`uploaded/processing/indexed/error`), moderation is an independent state machine. Never merge them.

### C2. Upload for participants
- `POST /v1/albums/:id/uploads/init` reusing the existing resumable `upload_sessions` machinery. Authorization: the album is `kind='crowd'`, `uploads_open = true`, the user is a participant of the event, and their approved+pending count in that album is below `max_photos_per_user`.
- Default moderation `post`: media are `approved` on arrival and visible immediately. A pluggable screening hook runs before publication and may set `auto_rejected` (interface + a no-op default implementation in v6; the actual classifier is a later decision).
- `POST /v1/photos/:id/report { reason, note? }` for any participant. A photo reaching a configurable number of distinct open reports is set to `pending` automatically and disappears from the gallery until a moderator rules.
- Moderation routes (staff): `GET /v1/admin/moderation?albumId=&state=&cursor=`, `POST /v1/admin/photos/:id/moderate { state }`, which writes `moderated_by/at` and an `audit_log` row. Rejecting purges the object through the existing `purgePhoto`.
- `uploads_open` is the kill switch: when false, every upload route returns 423 with an Italian message.

### C3. Camera with Polaroid frame
- A side button in the crowd album opens the camera: `getUserMedia` where available, otherwise `<input type="file" accept="image/*" capture="environment">`.
- **The filter and the frame are composited on a canvas after the shot, never as a live preview effect** — same visual result, none of the iOS Safari and low-end Android problems. The frame is a white Polaroid border with the event name and date drawn with `fillText`. 2–3 filters, implemented as canvas filter strings.
- The composite is what gets uploaded. Keep the untouched capture as the `original` when the browser gives it, so the frame can be re-rendered later.
- No video capture in v6: the camera input must explicitly refuse video MIME types.

Tests: caps, closed uploads, report → auto-pending threshold, moderate transitions + audit, dedup of an identical re-upload, canvas composite unit test on dimensions/orientation (EXIF rotation).

---

## D. Admin console (agent D: `apps/web/app/admin/**`, `apps/api/src/routes.ts` admin section, `packages/contracts/src/http.ts` admin section)

- **Albums**: create/list/edit. The form makes decision 2 visible — choosing `crowd` disables and greys the recognition switch with an explanation, and after the first upload the switch is read-only with the reason shown. Fields: name, kind, recognition, moderation, visibility, per-user cap, retention, `uploads_open`.
- **Photographer authorization per album**, not only per event: extend `event_photographers` usage or add `album_photographers` (agent D owns the choice; if a table is needed, it goes in migration 010 — coordinate with agent C).
- **Moderation queue**: pending and reported media, large thumbnails, keyboard shortcuts (A approve / R reject / → next), bulk actions. This is the screen two people will use for hours — it must be fast and keyboard-first.
- **Live event status** (one screen, auto-refreshing): media ingested, queue depth and oldest age per job type, indexed, errors, selfies waiting, uploads open/closed per album, last 20 errors. Extend the existing `admin/metrics`.
- **Participants**: lookup by email → personal gallery, consent state, revoke consent, delete. This closes the open DPIA item.
- **Operations**: a plain page of external links read from env (`OPS_LINK_*`): Resend, PostHog, Sentry, Coolify, Authentik, R2. Links only — **do not** build API integrations that mirror those dashboards.

Tests: route authz, album form rules (crowd⇒no recognition, immutability after first upload), moderation actions, metrics shape. Web typecheck + build.

---

## E. Tagging (agent E: `packages/db/migrations/013`, tagging routes, `apps/web/components/tagger.tsx`) — after agent A

- `users.taggable boolean not null default false` (explicit opt-in) and `photo_tags (photo_id, user_id, tagged_by, created_at, state)`.
- Tagging creates the same person↔photo link that biometrics creates, minus the biometrics. It needs: opt-in, a notification to the tagged person, removal by the tagged person, and an `audit_log` row for every tag and untag. **Reuse the existing `not_me` feedback flow for removal** instead of inventing a second mechanism.
- **The username autocomplete must not become a directory of the event.** It returns only users with `taggable = true`, requires at least 3 characters, is rate-limited per session, and returns display names only — never emails, never a full list on an empty query.

Tests: opt-in enforcement, autocomplete leakage (empty query, 1–2 chars, non-taggable user), removal, audit rows.

---

## F. Carry-over findings and ops (agent F: `deploy/**`, `packages/db/src/postgres.ts` targeted fixes, `scripts/bench/**`) — independent, can start immediately

1. **Face-service throughput benchmark.** `scripts/bench/index-throughput.ts`: ingest N photos at 2560 px detection on the target hardware and report photos/hour, p50/p95 per job, CPU and RAM. Everything else is sized from this number, and it has never been measured. Output: a short note in `docs/`.
2. **MinIO/R2 least privilege.** `deploy/compose.yml:39` passes `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` to api and worker as `S3_ACCESS_KEY`/`S3_SECRET_KEY`. Create an application user scoped to the bucket; keep root for administration and backup only. Update `deploy/README.md` and `.env.production.example`.
3. **`date_trunc` ordering vs index.** `order by date_trunc('milliseconds', created_at) desc, id desc` (`postgres.ts:1556`, same pattern at 357, 1396, 1638) cannot use `photos_event_created_idx` (`001_init.sql:60`). Add expression indexes or drop `date_trunc` from the ordering. Verify with `EXPLAIN` on a realistic dataset and paste the plans in the PR.
4. **Paginate `listFeedback`.** `routes.ts:237` loads all of a user's feedback on every gallery page; return it only for the photo ids of the requested page (`postgres.ts:1598`).
5. **Restore drill.** Run a full backup→restore of Postgres and the object store into a scratch environment and write the timings into `deploy/README.md`. A backup that has never been restored is not a backup.

---

## G. Order and commits

**Wave 1 (parallel): A, B, F.** A is blocking for everyone else; B and F touch nothing A touches.
**Wave 2 (parallel, after A lands): C, D, E.**

The integrator (main session) runs the full test suite, typechecks, builds and a real end-to-end run (face-service + pgvector) between waves, and commits per area: `albums+vectors`, `auth`, `ops+findings`, then `crowd+moderation`, `admin`, `tagging`, then a review agent and a docs agent (`CONTRACTS.md` v6 additions, `docs/DPIA.md` for the crowd album and tagging, `RUN.md` for the magic-link fallback), final commit.

**Hard rule for every agent**: after your migration, the personal match galleries (`galleries`, `gallery_items`) must behave exactly as before. If a test covering them fails, stop and report instead of adapting the test.

## H. Deferred to v7 (recorded so the decision is not lost)

- **Video**: extend `photos` with `media_type`/`duration_ms` rather than a `videos` table (it already has `content_type`, `sha256`, resumable `upload_sessions`, derivatives, jobs, retention). Pass through H.264, transcode only HEVC, generate a poster frame, run it in a separate worker with capped concurrency so it cannot starve face indexing. Pre-moderation and a cap of 1 video × 15 s per person: with 2 moderators, video is the only media that must be watched in real time.
- Authentik as staff IdP with MFA, behind Cloudflare Access.
- Managed Postgres (the database is the first thing to move off the single host).
