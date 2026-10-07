-- v6 A3: face_vectors.album_id + one partial HNSW index per recognising album
-- (docs/v6-spec.md §A3).
--
-- v5 ordered by distance over a single global HNSW index and filtered `event_id`
-- afterwards (packages/face-engine/src/insightface.ts, SEARCH_SQL): with several albums per
-- event the filter throws away neighbours the index had already chosen, and recall drops.
-- The global index is therefore replaced by one partial index per album
-- (`where album_id = '<uuid>'`), which is what pgvector recommends for a filtered search,
-- and every search path passes an album id.
--
-- Everything pgvector-dependent is guarded: on a Postgres without the extension
-- `face_vectors` does not exist (see 005) and this migration only records itself.
-- `galleries` / `gallery_items` are not touched.

-- Creates (or keeps) the partial HNSW index of one album. Called by the loop below and by
-- the application when an album with recognition = true is created
-- (packages/db/src/postgres.ts, createAlbum). A no-op when `face_vectors` is absent or the
-- album does not recognise: a crowd album never holds a vector.
create or replace function face_vectors_album_index(target_album uuid) returns void as $$
declare
  recognises boolean;
  index_name text;
begin
  if to_regclass('public.face_vectors') is null then return; end if;
  select recognition into recognises from albums where id = target_album;
  if recognises is not true then return; end if;
  index_name := 'face_vectors_hnsw_' || replace(target_album::text, '-', '');
  execute format(
    'create index if not exists %I on face_vectors using hnsw (embedding vector_cosine_ops) '
    'with (m = 16, ef_construction = 64) where album_id = %L',
    index_name,
    target_album
  );
end
$$ language plpgsql;

-- Every recognising album gets its index, whatever created the row: the admin API, the
-- `events_default_album` trigger of 009, a seeding script writing plain SQL. Without this
-- an album could silently fall back to an exact scan of its own vectors.
create or replace function albums_vector_index() returns trigger as $$
begin
  if new.recognition then perform face_vectors_album_index(new.id); end if;
  return null;
end
$$ language plpgsql;

create trigger albums_vector_index_insert
  after insert on albums
  for each row execute function albums_vector_index();

create trigger albums_vector_index_update
  after update of recognition on albums
  for each row execute function albums_vector_index();

do $$
declare
  album record;
begin
  if to_regclass('public.face_vectors') is null then
    raise notice 'face_vectors absent (no pgvector): nothing to move to albums';
    return;
  end if;

  alter table face_vectors add column if not exists album_id uuid;

  update face_vectors fv
     set album_id = p.album_id
    from photos p
   where p.id = fv.photo_id
     and fv.album_id is null;

  -- A vector whose photo is gone is an orphan (006 already deletes those before adding the
  -- photo foreign key); it cannot be assigned an album, so it goes.
  delete from face_vectors where album_id is null;

  alter table face_vectors alter column album_id set not null;

  if not exists (select 1 from pg_constraint where conname = 'face_vectors_album_id_fkey') then
    alter table face_vectors
      add constraint face_vectors_album_id_fkey
      foreign key (album_id) references albums (id) on delete cascade;
  end if;

  -- The global HNSW index is what made the album filter lossy: drop it. Filtered searches
  -- use the per-album partial indexes below; an unfiltered search (admin tooling) falls
  -- back to an exact scan served by the btree indexes, which is slower but never lossy.
  drop index if exists face_vectors_embedding_idx;

  -- Plain btree on album_id: it serves the album foreign key (an album deleted with its
  -- photos must not scan the table) and the non-ordered reads. The ordered search is served
  -- by the per-album partial HNSW indexes created below.
  create index if not exists face_vectors_album_idx on face_vectors (album_id);

  for album in select id from albums where recognition loop
    perform face_vectors_album_index(album.id);
  end loop;

  -- The selfie-vector search of `attach` (findGalleriesByQueryVector) stays per event:
  -- `galleries` is the personal gallery, unique (user_id, event_id), and v6 neither adds a
  -- column to it nor changes a row of it. Its global HNSW index (006) has exactly the
  -- problem described above, one event filter instead of an album one, so it goes the same
  -- way: with this partial btree the query filters on event_id and computes exact distances
  -- over that event's galleries (one row per participant who scanned, not one per face).
  drop index if exists galleries_query_embedding_idx;
  create index if not exists galleries_event_query_vector_idx
    on galleries (event_id) where query_embedding is not null;
end
$$;
