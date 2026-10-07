-- v2: priority queue, incremental attach, list-based access, upload sizes.
-- Additive only. No v1 column is dropped or renamed.

-- jobs: priority queue + dedupe
alter table jobs add column priority smallint not null default 50;
alter table jobs add column dedupe_key text null;
create index jobs_claim_priority_idx on jobs (priority, run_after, created_at) where status = 'queued';
create unique index jobs_dedupe_active_idx on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
create index jobs_done_created_idx on jobs (created_at) where status = 'done';

-- photos: indexing time + failure reason
alter table photos add column indexed_at timestamptz null;
alter table photos add column error text null;
create index photos_event_status_idx on photos (event_id, status);

-- upload_sessions: declared size, enforced at complete
alter table upload_sessions add column bytes bigint null;
create index upload_sessions_photographer_event_idx on upload_sessions (photographer_id, event_id, created_at desc);

-- galleries: anchors for incremental attach + notification throttle
alter table galleries add column anchor_face_ids text[] not null default '{}';
alter table galleries add column matched_at timestamptz null;
alter table galleries add column notified_at timestamptz null;
create index galleries_anchor_gin_idx on galleries using gin (anchor_face_ids);
create index galleries_event_idx on galleries (event_id);

-- gallery_items: provenance
alter table gallery_items add column source text not null default 'match' check (source in ('match', 'attach'));
alter table gallery_items add column created_at timestamptz not null default now();
create index gallery_items_gallery_score_idx on gallery_items (gallery_id, score desc, photo_id);

-- magic links: rate limiting by ip
alter table magic_links add column ip text null;
alter table magic_links add column created_at timestamptz not null default now();
create index magic_links_email_created_idx on magic_links (email, created_at desc);
create index magic_links_ip_created_idx on magic_links (ip, created_at desc);

-- events: access policy
alter table events add column access text not null default 'open' check (access in ('open', 'list'));

-- who may upload to an event
create table event_photographers (
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- participant allowlist (used when events.access = 'list')
create table event_participants (
  event_id uuid not null references events (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, email)
);
