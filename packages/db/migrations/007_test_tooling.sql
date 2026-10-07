-- v5 test tooling (agent D). Additive only.
-- match_runs / match_hits / galleries.selfie_key / galleries.last_match_reason live in 006.

-- photos: the client filename and free tags, so the eval scripts can join labels to rows.
alter table photos add column filename text null;
alter table photos add column tags text[] not null default '{}';
create index photos_event_filename_idx on photos (event_id, filename);
create index photos_tags_gin_idx on photos using gin (tags);

-- upload_sessions: carried from uploads/init to uploads/complete, where the photo row is made.
alter table upload_sessions add column filename text null;
alter table upload_sessions add column tags text[] not null default '{}';

-- participant feedback ("Non sono io"): ground truth gathered from the volunteers.
create table gallery_feedback (
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  photo_id uuid not null references photos(id) on delete cascade,
  verdict text not null check (verdict in ('me','not_me')),
  score_at_time double precision null,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id, photo_id)
);
create index gallery_feedback_event_idx on gallery_feedback (event_id, created_at desc);
