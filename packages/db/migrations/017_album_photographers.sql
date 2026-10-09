-- v6 D: per-album photographer authorization (docs/v6-spec.md §D).
--
-- Until now "who may upload" is per event (`event_photographers`, 003_v2.sql:42). With N
-- albums per event that is too coarse: the official album is for the hired photographers,
-- a second official album may be for one of them only.
--
-- This table NARROWS the event-level grant, it never widens it:
--
--   * an album with no row here is unrestricted — every photographer of the event may
--     upload, which is exactly the v5 behaviour, so this migration changes nothing on an
--     existing database (no backfill, and none is wanted);
--   * an album with at least one row is restricted to the users listed.
--
-- The event-level check stays in front of it: a user who is not an `event_photographers`
-- row has no business in any album of the event. `isAlbumPhotographerAllowed`
-- (packages/db/src/types.ts) is the single reader of that rule.
--
-- Additive only: no existing table, index or constraint is touched, and `galleries` /
-- `gallery_items` (the personal match galleries) are not read or written here.

create table if not exists album_photographers (
  album_id uuid not null references albums (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (album_id, user_id)
);

-- "Which albums may this photographer upload to", the reverse read of the pair.
create index if not exists album_photographers_user_idx on album_photographers (user_id);
