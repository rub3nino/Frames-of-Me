-- Separate user-contributed photos from the photographer-curated stream.
-- Existing rows remain official so current uploads keep their face-search behaviour.
alter table photos
  add column if not exists collection text not null default 'official'
  check (collection in ('public', 'official'));

alter table upload_sessions
  add column if not exists collection text not null default 'official'
  check (collection in ('public', 'official'));

create index if not exists photos_event_collection_created_idx
  on photos (event_id, collection, created_at desc, id desc);

create index if not exists upload_sessions_event_collection_idx
  on upload_sessions (event_id, collection, created_at desc);
