-- v6 C1 (agent C): photo moderation, reports and the album carried by an upload session
-- (docs/v6-spec.md §C1).
--
-- `moderation_state` is a column SEPARATE from `photos.status` on purpose: `status` is the
-- processing pipeline (uploaded/processing/indexed/error), moderation is an independent
-- state machine (pending/approved/rejected/auto_rejected). The two are never merged.
--
-- Default moderation is `post` (decision 6, frozen): a photo arrives `approved` and is
-- visible at once, which is why the column default is `'approved'`. The screening hook
-- (apps/api/src/screening.ts) is what can flip it to `auto_rejected` before publication.
--
-- This file depends only on 001-009. On a database that already ran wave 1 it is applied
-- AFTER 011, 012 and 014, because packages/db/src/migrate.ts tracks applied files by name:
-- nothing here reads a table, column or function introduced by 011+ (no face_vectors, no
-- user_identities, no keyset index). `galleries` / `gallery_items` are not touched at all.

alter table photos add column moderation_state text not null default 'approved'
  check (moderation_state in ('pending', 'approved', 'rejected', 'auto_rejected'));
alter table photos add column moderated_by uuid null references users (id);
alter table photos add column moderated_at timestamptz null;

comment on column photos.moderation_state is
  'v6 moderation state machine, independent of photos.status (the processing pipeline)';

-- The moderation queue only ever reads what is not approved, so the index is partial.
create index photos_moderation_idx on photos (album_id, moderation_state)
  where moderation_state <> 'approved';

create table reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos (id) on delete cascade,
  reporter_id uuid not null references users (id) on delete cascade,
  reason text not null check (reason in ('inappropriate', 'not_me', 'copyright', 'other')),
  note text null,
  state text not null default 'open' check (state in ('open', 'closed')),
  created_at timestamptz not null default now(),
  -- One report per person per photo: the auto-pending threshold counts DISTINCT people,
  -- and this constraint is what makes that count honest.
  unique (photo_id, reporter_id)
);

-- Counting the open reports of one photo is on the hot path of every report: keep it partial.
create index reports_open_idx on reports (photo_id) where state = 'open';
create index reports_reporter_idx on reports (reporter_id);

-- C2: the album an upload session belongs to, carried from `uploads/init` to
-- `uploads/complete` so the photo row lands in the album the client asked for.
--
-- Deliberately nullable: rows written before this migration have no album of their own, and
-- `packages/db/src/pagination.test.ts` inserts fixture sessions in plain SQL without it.
-- `insertUploadSession` resolves the event's official album when the caller gives none, and
-- `complete` falls back to that album when the column is null, so a null never reaches a
-- photo row.
alter table upload_sessions add column album_id uuid references albums (id) on delete cascade;

update upload_sessions us
   set album_id = a.id
  from albums a
 where a.event_id = us.event_id
   and a.slug = 'ufficiale'
   and us.album_id is null;

create index upload_sessions_album_idx on upload_sessions (album_id);
