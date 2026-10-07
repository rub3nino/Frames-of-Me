-- v3: two-stage upload (web derivative first, original later).
-- Additive only. No earlier column is dropped or renamed.

-- photos: whether the original bytes have arrived. sha256/bytes always describe the original.
alter table photos add column original_status text not null default 'present'
  check (original_status in ('pending', 'present'));
create index photos_event_original_pending_idx on photos (event_id) where original_status = 'pending';

-- upload_sessions: which stage a session uploads, and (web stage) what the original will be.
alter table upload_sessions add column stage text not null default 'original'
  check (stage in ('original', 'web'));
alter table upload_sessions add column photo_id uuid null references photos (id) on delete set null;
alter table upload_sessions add column original_content_type text null;
alter table upload_sessions add column original_bytes bigint null;
