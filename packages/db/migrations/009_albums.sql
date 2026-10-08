-- v6 A1/A2: albums + photos.album_id (docs/v6-spec.md §A).
--
-- `albums` is the new admin-created entity. It is NOT `galleries` (the per-user personal
-- match gallery, 001_init.sql:92) and it is NOT a Rekognition `collection`
-- (packages/contracts/src/face-engine.ts). Those two keep their meaning untouched: this
-- migration does not read, write or rename `galleries` / `gallery_items` in any way.
--
-- Everything is additive except the `photos unique (event_id, sha256)` constraint, which is
-- replaced by `unique (album_id, sha256)`: with a crowd album people re-upload the same
-- forwarded image into a different album, and that must succeed.
--
-- Behaviour after this migration is identical to v5: every existing event gets one
-- `official` album with `recognition = true`, every existing photo is moved into it, and a
-- trigger gives any later event the same album, so the v5 code paths that only know an
-- event id (api upload routes, scripts/seed-test.ts, seedDemo) keep working unchanged.

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
  -- Decision 2 (frozen): a crowd album never gets face recognition. Enforced here, in the
  -- database, not in application code.
  constraint crowd_never_recognizes check (not (kind = 'crowd' and recognition))
);

create index albums_event_idx on albums (event_id, created_at);

-- The default album of an event: slug 'ufficiale', recognition on, no moderation, the v5
-- behaviour. Used by the backfill below and by the trigger for events created later.
create or replace function albums_default_for_event(target_event uuid) returns uuid as $$
declare
  album_id uuid;
begin
  insert into albums (event_id, slug, name, kind, recognition, moderation, visibility)
  values (target_event, 'ufficiale', 'Album ufficiale', 'official', true, 'off', 'participants')
  on conflict (event_id, slug) do nothing
  returning id into album_id;
  if album_id is null then
    select id into album_id from albums where event_id = target_event and slug = 'ufficiale';
  end if;
  return album_id;
end
$$ language plpgsql;

-- Backfill: one official album per existing event.
select albums_default_for_event(id) from events;

create or replace function albums_event_insert() returns trigger as $$
begin
  perform albums_default_for_event(new.id);
  return null;
end
$$ language plpgsql;

create trigger events_default_album
  after insert on events
  for each row execute function albums_event_insert();

-- Decision 3 (frozen): the recognition flag is immutable once the album has its first
-- upload. Turning it on later would change the purpose of processing for media uploaded
-- under a different consent. A dedicated SQLSTATE so the application maps it to its own
-- error (packages/db/src/postgres.ts, AlbumRecognitionLockedError).
create or replace function albums_recognition_immutable() returns trigger as $$
begin
  if old.first_upload_at is not null and new.recognition is distinct from old.recognition then
    raise exception 'album %: recognition is immutable once first_upload_at is set', old.id
      using errcode = 'ALBRI';
  end if;
  return new;
end
$$ language plpgsql;

create trigger albums_recognition_lock
  before update on albums
  for each row execute function albums_recognition_immutable();

-- A2: photos.album_id ---------------------------------------------------------------------

alter table photos add column album_id uuid references albums (id) on delete cascade;

update photos p
   set album_id = a.id
  from albums a
 where a.event_id = p.event_id
   and a.slug = 'ufficiale'
   and p.album_id is null;

alter table photos alter column album_id set not null;

-- Replace `unique (event_id, sha256)` with `unique (album_id, sha256)`. The old constraint
-- is looked up by its columns, not by its generated name, so this also applies to a
-- database where it was created under another name.
do $$
declare
  old_name text;
begin
  select c.conname into old_name
    from pg_constraint c
   where c.conrelid = 'photos'::regclass
     and c.contype = 'u'
     and (
       select array_agg(a.attname::text order by a.attname)
         from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     ) = array['event_id', 'sha256']
   limit 1;
  if old_name is not null then
    execute format('alter table photos drop constraint %I', old_name);
  end if;
end
$$;

alter table photos add constraint photos_album_sha_key unique (album_id, sha256);
create index photos_album_created_idx on photos (album_id, created_at);

-- `photographer_id` now also holds participants uploading into a crowd album. The column
-- keeps its v5 name (renaming it would touch too much code): it means "uploader".
comment on column photos.photographer_id is
  'uploader: a photographer for an official album, a participant for a crowd album (v6)';

-- `albums.first_upload_at` is set by the first media row of the album, whatever path
-- inserted it, so the immutability above cannot be side-stepped by a new upload route.
create or replace function albums_mark_first_upload() returns trigger as $$
begin
  update albums
     set first_upload_at = now()
   where id = new.album_id
     and first_upload_at is null;
  return null;
end
$$ language plpgsql;

create trigger photos_album_first_upload
  after insert on photos
  for each row execute function albums_mark_first_upload();
