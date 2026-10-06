-- Domain tables from CONTRACTS.md. No embedding column.
-- face_index is the local fake engine's color table (packages/face-engine).

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null check (role in ('participant', 'photographer', 'admin')),
  created_at timestamptz not null default now(),
  unique (email, role)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  retention_days int not null default 90,
  created_at timestamptz not null default now()
);

create table magic_links (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null check (role in ('participant', 'photographer', 'admin')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null
);

create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  text_version text not null,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz null,
  ip text not null,
  user_agent text not null
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  photographer_id uuid not null references users (id),
  sha256 text not null,
  status text not null check (status in ('uploaded', 'processing', 'indexed', 'error')),
  original_key text not null,
  content_type text not null,
  bytes bigint not null,
  created_at timestamptz not null default now(),
  unique (event_id, sha256)
);

create index photos_event_created_idx on photos (event_id, created_at);
create index photos_photographer_idx on photos (photographer_id);

create table derivatives (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos (id) on delete cascade,
  kind text not null check (kind in ('thumb', 'web')),
  s3_key text not null,
  unique (photo_id, kind)
);

create table faces (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  external_id text not null,
  bbox jsonb not null,
  confidence real not null,
  created_at timestamptz not null default now(),
  unique (photo_id, external_id)
);

create table face_index (
  external_face_id text primary key,
  photo_id uuid not null,
  event_id uuid not null,
  r smallint not null,
  g smallint not null,
  b smallint not null,
  unique (event_id, photo_id)
);

create table galleries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  unique (user_id, event_id)
);

create table gallery_items (
  id uuid primary key default gen_random_uuid(),
  gallery_id uuid not null references galleries (id) on delete cascade,
  photo_id uuid not null references photos (id) on delete cascade,
  face_id uuid not null references faces (id) on delete cascade,
  score double precision not null,
  unique (gallery_id, photo_id)
);

create table upload_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  photographer_id uuid not null references users (id) on delete cascade,
  s3_upload_id text null,
  object_key text not null,
  sha256 text not null,
  content_type text not null,
  status text not null check (status in ('open', 'completed', 'aborted')),
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text null,
  created_at timestamptz not null default now()
);

create index jobs_claim_idx on jobs (status, run_after, created_at);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid null references users (id) on delete set null,
  action text not null,
  target text not null,
  created_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

create table invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  event_id uuid not null references events (id) on delete cascade,
  token_hash text not null unique,
  role text not null,
  expires_at timestamptz not null,
  used_at timestamptz null
);
