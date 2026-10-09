-- v4 report F05: server-verified challenge-response liveness. Each selfie match under
-- LIVENESS_CHALLENGE needs a one-time, short-lived challenge the server issued; the worker
-- consumes it atomically so a challenge (and thus a captured sequence) can be used once.
create table if not exists liveness_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  actions text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null
);

create index if not exists liveness_challenges_user_idx
  on liveness_challenges (user_id, event_id);

create index if not exists liveness_challenges_expires_idx
  on liveness_challenges (expires_at)
  where consumed_at is null;
