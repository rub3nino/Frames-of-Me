-- Keep the actor who uploaded a photo separate from the official photographer.
-- `photographer_id` remains populated for backwards compatibility during migration.
alter table photos add column if not exists uploader_id uuid references users (id) on delete set null;
alter table upload_sessions add column if not exists uploader_id uuid references users (id) on delete set null;

update photos set uploader_id = photographer_id where uploader_id is null;
update upload_sessions set uploader_id = photographer_id where uploader_id is null;

create index if not exists photos_uploader_event_idx on photos (uploader_id, event_id, created_at desc);
create index if not exists upload_sessions_uploader_event_idx on upload_sessions (uploader_id, event_id, created_at desc);
