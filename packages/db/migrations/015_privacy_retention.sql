-- v6 G (agent G) — consent withdrawal and automatic retention.
--
-- Two gaps this migration supports:
--
-- 1. `consents.withdrawn_at` exists since 001 and is read everywhere
--    (`where withdrawn_at is null`), but nothing ever wrote it: a participant asking to
--    stop being recognised could only be served by hand-written SQL. The write path is
--    application code (`withdrawConsent` in packages/db, `registerPrivacyRoutes` in the
--    api); this file only adds the index that read path and the withdrawal both need.
-- 2. The `retention` job worked but nothing scheduled it. `retention_schedule` is the
--    state the scheduler claims a window on, and the row the admin status screen reads.
--
-- Additive only. No table of v1-v5 is altered, nothing is dropped, and `galleries` /
-- `gallery_items` (the personal match galleries) are not touched at all.

-- ---------------------------------------------------------------- consent reads
-- `hasActiveConsent` (every selfie) and the withdrawal both filter (user_id, event_id).
-- 001 gave `consents` only its primary key, so both were sequential scans.
create index if not exists consents_user_event_idx on consents (user_id, event_id);

-- ---------------------------------------------------------------- retention scheduling
-- One row per event that the scheduler has ever run for. `window_start` is the start of
-- the window whose run this row claimed: a run is claimed only for a window *strictly
-- newer* than the stored one, with
--
--   insert into retention_schedule (...) values (...)
--   on conflict (event_id) do update set ... where retention_schedule.window_start < excluded.window_start
--   returning event_id
--
-- which returns a row only to the writer that won. Two workers in the same window
-- serialise on the row lock and the loser re-evaluates the `where` against the committed
-- row, so exactly one of them enqueues. The job queue's own dedupe key
-- (`retention:<eventId>`, packages/contracts/src/jobs.ts) is the second guard; this one
-- also holds across a job that already finished, which the dedupe key does not.
create table if not exists retention_schedule (
  event_id uuid primary key references events (id) on delete cascade,
  window_start timestamptz not null,
  -- Window length used by the run, in seconds: the cadence is an env var and may change.
  window_seconds int not null,
  claimed_at timestamptz not null default now(),
  runs int not null default 1,
  last_outcome text not null default 'enqueued'
    check (last_outcome in ('enqueued', 'failed')),
  last_job_id uuid null,
  last_error text null,
  updated_at timestamptz not null default now()
);

-- The status screen asks for the last `retention` job of one event. `jobs.payload` is
-- jsonb and the type is in a separate column, so an expression index on the event id,
-- partial on the type, is the whole lookup (there are ~470k job rows per event).
create index if not exists jobs_retention_event_idx
  on jobs ((payload ->> 'eventId'), created_at desc)
  where type = 'retention';
