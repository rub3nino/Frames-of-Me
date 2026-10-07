-- v6 hardening H1 + H4 (agent H).
--
-- H1 — the password-reset token leaves `magic_links`.
--
-- Agent B built `POST /v1/auth/password-reset` on top of the magic-link table (one token
-- type, one `consumeMagicLink`). The consequence was not a detail: a magic link is a
-- *login* token, mailed for the event-day fallback and mintable from the admin console, and
-- `/v1/auth/password-reset/confirm` accepted any of them. An intercepted login link
-- therefore no longer granted a session that expires in minutes — it let the holder SET THE
-- ACCOUNT PASSWORD and keep the account for good. The two tokens have different blast
-- radii, so they get different tables, and `consumePasswordResetToken` can only ever see a
-- token this server minted for a reset.
--
-- The reset token is bound to `user_id`, not to (email, role): the e-mail is resolved once,
-- when the link is issued, so a later change of address cannot redirect an outstanding
-- token, and the row dies with the user.
--
-- `magic_links` itself is untouched: the login path (`request-link` / `verify`) keeps
-- working exactly as before — it is the deliberate event-day fallback (RUN.md).
create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  ip text null,
  created_at timestamptz not null default now()
);

-- Invalidation on use and on any password change: `update ... where user_id = $1 and
-- used_at is null`, so the partial index is the one the write needs.
create index password_reset_tokens_open_idx
  on password_reset_tokens (user_id)
  where used_at is null;

-- The route's own rate limit counts rows in a window, per user and per IP (the budget is no
-- longer shared with the login links, so a reset flood cannot exhaust the fallback and a
-- login-link flood cannot lock out a reset).
create index password_reset_tokens_user_created_idx
  on password_reset_tokens (user_id, created_at desc);
create index password_reset_tokens_ip_created_idx
  on password_reset_tokens (ip, created_at desc);

-- H4 — the fake engine's colour table learns about albums.
--
-- `face_index` is the local/dev fake engine's store (packages/face-engine/src/fake.ts, see
-- 001_init.sql). The fake accepted `albumIds` and ignored it, so every test that ran on it
-- proved only that the worker *passes* the right album ids, never that the album filter
-- holds. `album_id` is nullable on purpose: rows written before this migration have no
-- album, and a stored face whose album is unknown is excluded from any album-filtered
-- search (fake.ts) rather than silently matching all of them.
--
-- No FK to `albums`: `face_index` has no FK to `photos` or `events` either (it is a test
-- fixture table that is truncated, not cascaded), and adding one here would make the fake
-- engine's store the only thing in the schema that constrains album lifetimes.
alter table face_index add column if not exists album_id uuid null;
create index if not exists face_index_album_color_idx
  on face_index (event_id, album_id, r, g, b);
