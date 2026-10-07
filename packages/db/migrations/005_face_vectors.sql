-- face_vectors: ArcFace embeddings for FACE_ENGINE=insightface (packages/face-engine/src/insightface.ts).
-- Needs the pgvector extension. On a Postgres without it (plain postgres:16 image) the block
-- below raises a NOTICE and skips the table; the migration still records as applied and the
-- InsightFace engine fails with a clear message at first use. Re-run on a pgvector-enabled
-- server by deleting the '005_face_vectors.sql' row from schema_migrations.
do $$
begin
  begin
    create extension if not exists vector;
  exception
    when others then
      raise notice 'pgvector extension unavailable (%): face_vectors not created; FACE_ENGINE=insightface needs the pgvector/pgvector:pg16 image', sqlerrm;
      return;
  end;

  create table if not exists face_vectors (
    external_face_id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    photo_id uuid not null,
    embedding vector(512) not null,
    created_at timestamptz not null default now()
  );
  create index if not exists face_vectors_event_idx on face_vectors (event_id);
  create index if not exists face_vectors_photo_idx on face_vectors (photo_id);
  create index if not exists face_vectors_embedding_idx
    on face_vectors using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);
end
$$;
