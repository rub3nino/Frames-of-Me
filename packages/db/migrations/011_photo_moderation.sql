create table if not exists photo_moderation (
  photo_id uuid primary key references photos (id) on delete cascade,
  status text not null check (status in ('approved', 'pending', 'blocked')) default 'approved',
  reason text null,
  updated_by uuid null references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists photo_reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references photos (id) on delete cascade,
  reporter_id uuid not null references users (id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (photo_id, reporter_id)
);

create index if not exists photo_reports_photo_idx on photo_reports (photo_id, created_at desc);
