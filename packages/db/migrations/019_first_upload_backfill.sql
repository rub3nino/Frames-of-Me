-- Close a hole in 009's album backfill: an album backfilled OVER photos that already
-- existed has `first_upload_at = NULL`, so the recognition lock never engages.
--
-- 009_albums.sql creates one official album per existing event
-- (`select albums_default_for_event(id) from events`) and re-points every existing photo at
-- it with an UPDATE. But `albums.first_upload_at` is only ever written by trigger
-- `photos_album_first_upload`, which is `after insert on photos` — NOT `after update`. So
-- after 009 those albums hold indexed photos and still look like they have never received
-- one.
--
-- The consequence is the thing decision 3 (frozen) exists to prevent: trigger
-- `albums_recognition_lock` / `albums_recognition_immutable` only raises `ALBRI` when
-- `old.first_upload_at is not null`, so while the column is null an admin can flip
-- `recognition` on an album whose photos were all uploaded under a different consent —
-- changing the purpose of processing for media already collected.
--
-- The fix is to derive the value from the photos themselves: the earliest `created_at` in
-- the album, which is the truth the trigger would have recorded had those rows been
-- inserted after 009. Albums with no photos keep `first_upload_at = NULL`, which is correct:
-- nothing has been uploaded into them.
--
-- Deliberately UNGUARDED. On a fresh database it is a harmless no-op (every album was
-- stamped by the trigger on its first insert, and an empty album has no row to derive
-- from), and running it unconditionally also repairs any future album whose photos arrived
-- by UPDATE rather than INSERT — a move between albums, a re-point by a later migration.
-- `where a.first_upload_at is null` makes it idempotent and keeps it from ever moving a
-- value the trigger already set.
--
-- This only writes `first_upload_at`. It does not touch `recognition`, so it cannot trip
-- the lock it is restoring; it does not touch `galleries` or `gallery_items`.
--
-- Note for the next reader: the whole migration run is one transaction
-- (packages/db/src/migrate.ts) and the runner tracks applied migrations by filename only,
-- ignoring rows whose file no longer exists. A database migrated from the pre-albums
-- `photos.collection` model may therefore hold `schema_migrations` rows for four files that
-- are not in this tree and never will be — `009_photo_collections.sql`,
-- `010_upload_ownership.sql`, `011_photo_moderation.sql`,
-- `012_nullable_photographer_id.sql`. They belonged to a competing implementation of the
-- same product decisions; `albums` won, and no deployed database holds data worth
-- converting. The rows are inert. In particular `012_nullable_photographer_id.sql` must
-- never be re-introduced: in this schema `photos.photographer_id` IS the uploader (see the
-- `comment on column` in 009_albums.sql) and is non-nullable in
-- packages/db/src/types.ts.

update albums a
   set first_upload_at = p.first_upload
  from (
    select album_id, min(created_at) as first_upload
      from photos
     group by album_id
  ) p
 where p.album_id = a.id
   and a.first_upload_at is null;
