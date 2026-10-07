-- v6 F3 — expression indexes for the keyset-paginated listings.
--
-- Four listings order by `date_trunc('milliseconds', <ts>) desc, <tiebreak>` because the cursor
-- round-trips through a JS Date (`createdAt.toISOString()` in apps/api/src/routes.ts, millisecond
-- precision) while the column keeps microseconds. Truncating is what makes the keyset correct:
-- without it a page boundary inside a millisecond either repeats or skips rows. But an ordering
-- on an expression can only use an index on that same expression, so `photos_event_created_idx`
-- (001_init.sql:60) and `match_runs_event_idx` (006) were never usable and every page was a
-- sequential scan plus a top-N sort of the whole event.
--
-- The two-argument `date_trunc(text, timestamptz)` is STABLE (it reads the session TimeZone), so
-- Postgres refuses it in an index expression. The three-argument form with an explicit zone
-- (`date_trunc(text, timestamptz, text)`, Postgres 16) is IMMUTABLE and therefore indexable.
-- For a sub-second unit the truncation is timezone-independent anyway: every real zone has a
-- whole-minute offset, so the value is identical to the two-argument form. The query text in
-- packages/db/src/postgres.ts was changed to the three-argument form to match these indexes.
--
-- The index column order mirrors the ORDER BY exactly (including DESC/ASC), so the planner gets
-- the page straight from the index with no Sort node and stops at `limit`.

-- listPhotosAdmin (postgres.ts): where event_id = $1 order by trunc desc, id desc.
create index if not exists photos_event_created_ms_idx
  on photos (event_id, date_trunc('milliseconds', created_at, 'UTC') desc, id desc);

-- listUploadSessionsPage: where photographer_id = $1 and event_id = $2 order by trunc desc, id desc.
create index if not exists upload_sessions_photographer_created_ms_idx
  on upload_sessions (
    photographer_id, event_id, date_trunc('milliseconds', created_at, 'UTC') desc, id desc
  );

-- listMatchRuns: where event_id = $1 order by trunc desc, id desc.
create index if not exists match_runs_event_created_ms_idx
  on match_runs (event_id, date_trunc('milliseconds', created_at, 'UTC') desc, id desc);

-- listGalleriesPage: sorts on coalesce(matched_at, 'epoch') so galleries that never matched sort
-- last; the tiebreak is user_id ASC while the time is DESC, so the index mixes the directions too.
create index if not exists galleries_event_matched_ms_idx
  on galleries (
    event_id,
    date_trunc('milliseconds', coalesce(matched_at, 'epoch'::timestamptz), 'UTC') desc,
    user_id asc
  );
