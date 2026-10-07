-- Operational indexes for participant access checks, cleanup and admin photo views.
-- All are additive and safe to apply to an existing production database.

create index if not exists gallery_items_photo_idx
  on gallery_items (photo_id);

create index if not exists sessions_expires_idx
  on sessions (expires_at);

create index if not exists magic_links_expires_idx
  on magic_links (expires_at)
  where used_at is null;

create index if not exists invites_expires_idx
  on invites (expires_at)
  where used_at is null;

create index if not exists audit_log_created_idx
  on audit_log (created_at desc);
