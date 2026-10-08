# Production runbook

Operational, not architectural: what has to be configured outside the application, and what has
to be true before an event opens. The schema and the HTTP surface are `CONTRACTS.md`; the
self-hosted stack is `deploy/README.md`; the privacy analysis is `docs/DPIA.md`.

## Required environment

- Keep `S3_ENDPOINT` private. Set `S3_PUBLIC_ENDPOINT` only to the Cloudflare/CDN hostname used
  for signed browser URLs (`packages/contracts/src/env.ts:17,171`: `S3_ENDPOINT` stays internal,
  `S3_PUBLIC_ENDPOINT` is the host the browser sees).
- Use `FACE_ENGINE=insightface` only after the face service health check and the
  consent/retention process have been verified.
- Set `RETENTION_SCHEDULER=true` on the worker, with `RETENTION_ALARM_MAIL` and
  `RETENTION_ALARM_EMAIL`. Nothing else triggers the `retention` job: the worker's scheduler
  (`apps/worker/src/retention-scheduler.ts`) is what calls it on the ninetieth day, and with the
  scheduler off a retention period is a number in a column that nobody acts on.
- **PENDING (piece C): the shared upload limiter.** This branch has **no** `UPSTASH_*`
  configuration and no cross-replica limiter — `packages/contracts/src/env.ts` declares neither
  variable. What it does have, and what you are therefore relying on today:
  - **Database-backed, so correct across replicas**: magic links
    (`apps/api/src/routes.ts:124-135`), selfies (`routes.ts:242-249`), reports
    (`routes.crowd.ts:311-318`), password reset (`routes.reset.ts:105-122`). Each counts rows in
    a window, so two API replicas cannot each grant the full allowance.
  - **In-process `Map` windows, so the effective limit is multiplied by the replica count**:
    self-registration (`createRateLimiter`, `routes.ts:1857`) and tagging
    (`createTagLimiter`, `routes.tags.ts:334`). For registration that is deliberate — the hard
    guarantee is `event_codes.max_uses`, enforced in one statement — and for tagging there is no
    such backstop.
  - **No windowed limit at all on the crowd upload path.** `POST /v1/albums/:albumId/uploads/init`
    gates on three things only (`routes.crowd.ts:56-120`): the album's `uploads_open` kill switch
    (`423`), per-album dedup on `sha256`, and the absolute per-user cap
    `albums.max_photos_per_user` (`assertBelowCap`, `routes.crowd.ts:548`, re-checked at
    `complete`). A cap bounds total volume, not burst rate, and an album with
    `max_photos_per_user = null` is unbounded in both.

  Until piece C lands a decision, run the API as **one replica** or set a finite
  `max_photos_per_user` on every crowd album, and treat this section as the thing to re-read
  before scaling out.

## Object store lifecycle

Configure these rules in the bucket — the provider owns the policy, not the application. Written
for Cloudflare R2 / S3; on the self-hosted MinIO stack the equivalents are `mc ilm` rules plus
the daily `pg_dump` + `mc mirror` sidecar documented in `deploy/README.md` § 6. Prefixes are
`objectKeys` (`packages/contracts/src/face-engine.ts:31-44`).

1. Abort incomplete multipart uploads after 1 day.
2. Expire objects under `selfies/` after the event retention window unless `KEEP_SELFIES` is
   explicitly enabled. On the MinIO stack this one is already automated:
   `deploy/scripts/minio-provision.sh:113-139` adds the `selfies/` expiry rule when
   `S3_SELFIE_EXPIRE_DAYS` is set (and only then), idempotently — see `deploy/README.md` § 6 bis
   step 4. On R2 it is a bucket rule you add by hand.
3. Keep `thumbs/` and `web/` behind the CDN with immutable cache headers.
4. Keep `originals/` private and serve them only through short-lived signed URLs.
5. Enable object versioning where the account plan supports it and retain a daily backup copy for
   the contractual retention period.

The worker's housekeeping (`runHousekeeping`, `apps/worker/src/loop.ts`) aborts upload
sessions left open for more than 24 hours, aborts their S3 multipart upload, and deletes
the orphaned object a single-PUT session leaves behind when the browser disappears between
the PUT and `/complete`. That last part matters more than it looks: the crowd upload path is
single-PUT below the multipart threshold, and lifecycle rule 1 above only covers multipart,
so without it those orphans would accumulate with nothing to clear them.

## GDPR operations

- Store the consent text version, timestamp, IP and user agent for every selfie search.
- A withdrawal must delete the selfie object, face anchors, query vector and participant gallery
  data. `POST /v1/events/:slug/consent/withdraw` (participant) and
  `POST /v1/admin/participants/:id/consent/withdraw` (staff) are the two entry points
  (`apps/api/src/routes.privacy.ts:43,56`); the `consent.withdrawn` audit row records the counts
  of what was deleted and deliberately **not** the face ids.
- Run event retention before the contractual deadline and verify the deletion audit entries.
  `albums.retention_days` overrides `events.retention_days` for that album's photos.
- **Biometric data exists only for albums with `recognition = true`.** The boundary is the album,
  not the photo: a crowd album can never have recognition (`albums` constraint
  `crowd_never_recognizes`, `packages/db/migrations/009_albums.sql:34`), the flag is immutable
  once the album has its first photo (trigger `albums_recognition_lock`, `009_albums.sql:84-86`),
  and the worker refuses to embed an album without it (`apps/worker/src/handlers.ts:273` in
  `indexPhoto`, `:359` in `attachPhoto`). So a photo in an album with `recognition = false` must
  never produce a `faces`, `face_index` or `face_vectors` row. Verifying that is a check on the
  album flag, not on any per-photo column — and because the database holds both halves, a
  hand-written `UPDATE` or a new upload route cannot get around it either.
- Process photo reports through the admin moderation endpoint
  (`POST /v1/admin/photos/:id/moderate`) and retain the decision in the audit log
  (`moderation.approved` / `moderation.pending` / `moderation.rejected`, with `from` and
  `closedReports`). **`rejected` purges**: it calls `purgePhoto`, which deletes the original, the
  derivatives, the faces, the anchors and the photo row. There is no undo and no down-migration.
  Use `pending` to withhold a photo while a human decides.

## Release gate

Before opening an event to participants:

1. Run `pnpm test` and require zero failures; `pnpm -r typecheck` clean. **A clean summary is not
   enough on its own**: `packages/db/src/pagination.test.ts` guards its suite with
   `describe(..., { skip })`, so without a *migrated* `DATABASE_URL` the whole thing collapses
   into one **passing** `# SKIP` line and its 13 tests are counted in neither `# tests` nor
   `# skipped` — the run reads clean at 422 tests instead of 435. Export `DATABASE_URL` and
   `TEST_DATABASE_URL`, apply the schema with `node --import tsx packages/db/src/migrate.ts`
   (not `pnpm db:migrate`, which hardcodes `--env-file=.env`), and check the total is 435 before
   calling the gate passed.
2. Apply all migrations through `packages/db/src/migrate.ts` (`pnpm db:migrate`). The whole run is
   one transaction and is tracked by filename, so a partial apply is not a state you can reach.
3. Confirm object store lifecycle, backup restore and CDN signed URL behaviour in a staging event.
   A backup that has never been restored is not a backup — `deploy/README.md` § 6 has the restore
   drill and the checks to run on its result.
4. **PENDING (piece C): confirm the upload limiter holds across replicas.** On this branch there
   is nothing to confirm, because there is no cross-replica counter — so instead confirm the
   replica count is 1, or that every crowd album has a finite `max_photos_per_user` and
   `uploads_open` can be flipped from the console. Replace this step with the real check once
   piece C decides.
5. Verify an upload into an album with `recognition = false` never creates a face row and never
   calls the face engine. `apps/worker/test/v6.test.ts` has the named case ("index stores no
   vector for an album without recognition").
6. Verify the kill switch: setting `albums.uploads_open = false` answers `423` on the upload
   routes on the next request, with no restart of anything.
