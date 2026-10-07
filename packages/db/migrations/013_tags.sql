-- v6 E (agent E): tagging.
--
-- Tagging creates exactly the person<->photo link that face recognition creates, minus the
-- biometrics. So this migration is written as a privacy feature, not a social one:
--
--   * `users.taggable` defaults to FALSE. Nobody is taggable until they say so. There is no
--     backfill that turns it on for anyone, and no code path flips it except the participant's
--     own opt-in route.
--   * `users.display_name` is the ONLY thing the autocomplete may return. It exists so the
--     suggestion list never has to carry an e-mail address. It is null until the user opts in,
--     and `taggable` without a display name is not usable (see the partial index below).
--   * `photo_tags.state` makes a removal sticky: the tagged person sets it to 'removed' and the
--     primary key keeps the row, so the tagger cannot re-add the same tag silently.
--
-- Dependencies: 001 only (`users`, `photos`). Nothing from 009 onwards is referenced, because
-- on a database that already ran wave 1 the runner applies this file AFTER 014 (it tracks
-- applied files by name, so a gap is filled late).
--
-- Additive only: no existing column is dropped or renamed, and `galleries` / `gallery_items`
-- (the personal match galleries) are not touched at all.

-- The opt-in. `not null default false` is the whole point: a schema default of true, or a
-- nullable column read as "unknown means yes", would publish 6 000 people at once.
alter table users add column if not exists taggable boolean not null default false;

-- What other participants see in the suggestion list. Chosen by the user for this purpose;
-- never derived from the e-mail, because the local part of an address is personal data the
-- user did not agree to show.
alter table users add column if not exists display_name text null;

-- The autocomplete index. Partial on `taggable` and on a present display name, so a user who
-- never opted in is not even in the index. `text_pattern_ops` serves the prefix match
-- (`lower(display_name) like 'abc%'`) that the API uses; the API refuses queries shorter than
-- three characters before it gets here.
create index if not exists users_taggable_display_name_idx
  on users (lower(display_name) text_pattern_ops)
  where taggable and display_name is not null;

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
