-- v6 (agent B): Google OIDC identities, event codes for self-registration and the
-- lazy e-mail verification stamp. Additive only: magic links, invites, sessions and
-- `users.password_hash` (008) keep working unchanged.

create table if not exists user_identities (
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  subject text not null,
  -- The e-mail the provider asserted, kept for support/audit only. It is written only
  -- when the provider marked it verified; never used to grant access on its own.
  email text null,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists user_identities_user_idx on user_identities (user_id);

-- The anti-bot gate for participant self-registration. The code is printed on the
-- badge/QR already distributed at the event; `uses` is incremented atomically when a
-- registration claims it, so `max_uses` holds under concurrency.
create table if not exists event_codes (
  event_id uuid not null references events (id) on delete cascade,
  code text not null,
  label text null,
  max_uses int null,
  uses int not null default 0,
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  primary key (event_id, code)
);
-- Registration sends only the code (no event id), so the claim looks it up by code alone.
create index if not exists event_codes_code_idx on event_codes (code);

-- Lazy verification: null after a credential registration. Set when the user proves the
-- address (password-reset link, magic link, or a Google token with email_verified).
alter table users add column if not exists email_verified_at timestamptz null;
