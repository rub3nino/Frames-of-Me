-- v6 E (agent E): event membership and tagging.
--
-- Two things live here, and the first one is not about tagging at all.
--
-- 1. `event_members` — the NON-BIOMETRIC record of who belongs to an event. v6 built an
--    entire non-biometric half of the product (crowd albums, decision 2) on top of the
--    absence of this row. Before it, "is this person a participant of this event?" had no
--    honest answer for someone who never consented to face recognition and is not on an
--    allowlist: the only signals were `consents` (biometric), `galleries` (biometric) and
--    `event_participants` (only populated when `events.access = 'list'`). Registration with
--    an event code resolved the event and then threw it away into an audit row.
--
-- 2. `photo_tags` + the per-event tagging opt-in on `event_members`.
--
-- Tagging creates exactly the person<->photo link that face recognition creates, minus the
-- biometrics. So the tagging half is written as a privacy feature, not a social one:
--
--   * `event_members.taggable` defaults to FALSE. Nobody is taggable until they say so, per
--     event. The backfill below creates membership rows but turns `taggable` on for nobody.
--   * the opt-in is NOT the recognition consent in `consents`. Those are different legal
--     bases: decision 2 freezes that a `crowd` album is never biometric, so a participant
--     whose only involvement is the crowd album never grants recognition consent — and
--     tagging is the only way those people can find themselves in a non-biometric album.
--     Requiring a `consents` row would make tagging unavailable to exactly its population.
--   * the opt-in is PER EVENT, not per user. A global flag would mean consenting once, at one
--     event, to being nameable at every event the deployment ever runs — and the Italian
--     consent text says "questo evento", which a global flag would make a false statement the
--     day a second event exists.
--   * `users.display_name` is the ONLY thing the autocomplete may return. It exists so the
--     suggestion list never has to carry an e-mail address.
--   * `photo_tags.state` makes a removal sticky: the tagged person sets it to 'removed' and
--     the primary key keeps the row, so the tagger cannot re-add the same tag silently.
--
-- Dependencies: 001 (`users`, `events`, `photos`, `galleries`, `consents`) and 003
-- (`event_participants`, `event_photographers`), both of which are v5. Nothing from 009
-- onwards is referenced, because on a database that already ran wave 1 the runner applies
-- this file AFTER 014 (it tracks applied files by name, so a gap is filled late).
--
-- Additive only: no existing column is dropped or renamed, and `galleries` / `gallery_items`
-- (the personal match galleries) are not touched at all.

create table if not exists event_members (
  user_id uuid not null references users (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  -- How this person came to belong to the event. It is provenance, not permission: no code
  -- path reads it to decide anything, it is there so a membership can be explained and
  -- audited. The list is deliberately generous so the agents who own the other entry paths
  -- (crowd upload, invites, admin) do not each need a migration to add their value:
  --   event_code  — claimed a code at `POST /v1/auth/register` (the self-registration path)
  --   consent     — backfilled from an active `consents` row (granted recognition consent)
  --   gallery     — backfilled from a personal match gallery
  --   allowlist   — backfilled from `event_participants` (events with access = 'list')
  --   staff       — backfilled from `event_photographers`
  --   invite      — accepted an invite (unused here; for agent B / the admin paths)
  --   upload      — uploaded to an album of the event (unused here; for agent C)
  --   admin       — added by the staff console (unused here; for agent D)
  source text not null check (
    source in ('event_code', 'consent', 'gallery', 'allowlist', 'staff', 'invite', 'upload', 'admin')
  ),

  -- ---- the tagging opt-in, per event -----------------------------------------------------
  -- `not null default false` is the whole point: a schema default of true, or a nullable
  -- column read as "unknown means yes", would publish 6 000 people at once.
  taggable boolean not null default false,
  -- Which Italian consent text the participant accepted, and when. The audit_log row carries
  -- the same version, so the trail is auditable on its own; these two columns exist so the
  -- current state can be read without scanning the log, and so a later change to the text is
  -- detectable (a stored version older than the current one means re-consent is due). Set on
  -- opt-in and nulled on opt-out: the pair is the present state, the audit log is the history.
  taggable_consent_version text null,
  taggable_consent_at timestamptz null,

  created_at timestamptz not null default now(),
  primary key (user_id, event_id),
  -- Taggable without an accepted consent version is not a state the application can produce;
  -- the constraint is here so no other writer can produce it either.
  constraint taggable_needs_consent check (not taggable or taggable_consent_version is not null)
);

-- "The taggable members of this event" — the autocomplete's membership probe, and the one
-- place the opt-in is read in bulk. Partial, so a member who never opted in is not in it.
create index if not exists event_members_taggable_idx
  on event_members (event_id, user_id)
  where taggable;

-- "The events this person belongs to", for the per-event opt-in screens.
create index if not exists event_members_event_idx on event_members (event_id);

-- Backfill from every signal that exists today, so nobody already in the system loses
-- access. `on conflict do nothing` plus this statement order gives a deterministic `source`
-- when a person qualifies through several paths: the most specific signal wins.
--
-- NOTE what this does NOT do: it sets `taggable` for nobody. A migration must never make
-- anyone taggable — the opt-in is the participant's own act, and a backfilled yes would be a
-- consent nobody gave.
insert into event_members (user_id, event_id, source)
select c.user_id, c.event_id, 'consent'
from consents c
where c.withdrawn_at is null
on conflict (user_id, event_id) do nothing;

insert into event_members (user_id, event_id, source)
select g.user_id, g.event_id, 'gallery'
from galleries g
on conflict (user_id, event_id) do nothing;

insert into event_members (user_id, event_id, source)
select ep.user_id, ep.event_id, 'staff'
from event_photographers ep
on conflict (user_id, event_id) do nothing;

-- `event_participants` is an e-mail allowlist written before the account exists, so this only
-- finds the people who have actually signed in since.
insert into event_members (user_id, event_id, source)
select u.id, p.event_id, 'allowlist'
from event_participants p
join users u on lower(u.email) = lower(p.email) and u.role = 'participant'
on conflict (user_id, event_id) do nothing;

-- What other participants see in the suggestion list. Chosen by the user for this purpose;
-- never derived from the e-mail, because the local part of an address is personal data the
-- user did not agree to show. It stays on `users` rather than on `event_members`: the name a
-- person wants to be called by is theirs, not the event's, and duplicating it per event would
-- mean a stale copy the day they correct the spelling.
alter table users add column if not exists display_name text null;

-- The autocomplete's name lookup. `text_pattern_ops` serves the prefix match
-- (`lower(display_name) like 'abc%'`) that the API uses; the API refuses queries shorter than
-- three characters before it gets here, and the database layer refuses them again. The
-- taggability filter is the join to `event_members_taggable_idx` above, not this index.
create index if not exists users_display_name_idx
  on users (lower(display_name) text_pattern_ops)
  where display_name is not null;

create table if not exists photo_tags (
  photo_id uuid not null references photos (id) on delete cascade,
  -- The tagged person.
  user_id uuid not null references users (id) on delete cascade,
  -- Who asserted the link. Nullable with `on delete set null`: erasing the tagger must not
  -- delete the tagged person's row, because a row in state 'removed' is their refusal and
  -- deleting it would let the tag be created again.
  tagged_by uuid null references users (id) on delete set null,
  -- 'removed' is set by the tagged person (the `not_me` feedback flow). It is terminal: there
  -- is no transition back to 'active'.
  state text not null default 'active' check (state in ('active', 'removed')),
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

-- "The photos I am tagged in", newest first; `state` is in the key so the active rows are read
-- without touching the removed ones.
create index if not exists photo_tags_user_state_idx
  on photo_tags (user_id, state, created_at desc);

-- "Who is tagged in this photo".
create index if not exists photo_tags_photo_idx on photo_tags (photo_id, state);

-- Audit: who tagged whom, read back by target. `audit_log` (001) already carries every tag and
-- untag written by the API; this index is what makes reading them back by photo cheap.
create index if not exists audit_log_target_idx on audit_log (target, created_at desc);
