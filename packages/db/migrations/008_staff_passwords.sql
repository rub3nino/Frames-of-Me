-- Staff (admin + photographer) can log in with email + password, in addition
-- to magic links. Participants stay passwordless. The column is nullable: a
-- null hash means "no password set" and password login is refused for that row.
alter table users add column if not exists password_hash text;
