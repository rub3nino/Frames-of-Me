-- v5 recognition + match log (docs/v5-test-readiness-spec.md §A, §B, §D).
-- Everything is additive. pgvector-dependent parts (galleries.query_embedding, its HNSW index,
-- the face_vectors foreign key) are guarded so the migration also applies on a Postgres
-- without the extension (FACE_ENGINE=fake / rekognition); on such a server the InsightFace
-- engine is unusable anyway (see 005).

-- galleries: why the last match left the gallery empty, the kept selfie key (KEEP_SELFIES).
alter table galleries add column if not exists last_match_reason text null;
alter table galleries add column if not exists selfie_key text null;

-- galleries.query_embedding: the selfie vector, used by `attach` for galleries without anchors.
do $$
begin
  begin
    create extension if not exists vector;
  exception
    when others then
      raise notice 'pgvector extension unavailable (%): galleries.query_embedding not created', sqlerrm;
      return;
  end;

  alter table galleries add column if not exists query_embedding vector(512) null;
  create index if not exists galleries_query_embedding_idx
    on galleries using hnsw (query_embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

  -- face_vectors rows must belong to a photo: drop orphans, then cascade deletes.
  if to_regclass('public.face_vectors') is not null then
    delete from face_vectors fv
    where not exists (select 1 from photos p where p.id = fv.photo_id);
    if not exists (select 1 from pg_constraint where conname = 'face_vectors_photo_id_fkey') then
      alter table face_vectors
        add constraint face_vectors_photo_id_fkey
        foreign key (photo_id) references photos(id) on delete cascade;
    end if;
  end if;
end
$$;

-- jobs: when the job ended and how long it ran (from claimed_at), for status.sh and p50/p95.
alter table jobs add column if not exists finished_at timestamptz null;
alter table jobs add column if not exists duration_ms int null;
create index if not exists jobs_finished_at_idx on jobs (finished_at) where finished_at is not null;

-- match log (MATCH_LOG=true): one row per `match` run, every engine hit of the run.
create table if not exists match_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  liveness text null,
  reason text null,
  selfie_sha256 text null,
  selfie_faces int null,
  engine_ms int null,
  hits int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists match_runs_user_event_idx on match_runs (user_id, event_id, created_at desc);
create index if not exists match_runs_event_idx on match_runs (event_id, created_at desc);

create table if not exists match_hits (
  run_id uuid not null references match_runs(id) on delete cascade,
  photo_id uuid not null,
  external_face_id text not null,
  cosine real not null,
  similarity real not null,
  kept boolean not null,
  primary key (run_id, photo_id, external_face_id)
);
