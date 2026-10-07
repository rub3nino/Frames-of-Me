# v6 A3 — recall of the album-filtered vector search, before and after migration 011

Deliverable of `docs/v6-spec.md` §A3. Measured on 2026-10-07 by agent A.

## What was wrong in v5

`face_vectors` had one global HNSW index and `SEARCH_SQL`
(`packages/face-engine/src/insightface.ts`) ordered by distance over it with
`where event_id = $2` and `limit 200`. With one album per event that is fine. With several
albums per event the album filter is applied **after** the index has already chosen the 200
nearest vectors of the whole event, so the rows that belong to other albums are thrown away
and the result is a fraction of what was asked for. With N albums of similar size, roughly
1/N of the 200 rows survive.

Migration 011 replaces the global index with one partial index per album
(`where album_id = '<uuid>'`), `face_vectors.album_id` is `not null`, and every search path
passes an album id so the filter is part of the index, not applied after it.

## Method

- Postgres 16 + pgvector (`pgvector/pgvector:pg16`), on the development Mac, no other load.
- A scratch database migrated through 011, one event, **two** recognising albums.
- 30 000 synthetic 512-dimension vectors per album (60 000 in total): 400 random unit
  centroids, each vector a centroid plus Gaussian noise (σ = 0.35), re-normalised — so there
  are real neighbourhoods to find, unlike uniform noise where every distance is the same.
- 50 queries, each near a centroid (σ = 0.3). `hnsw.ef_search = 200`, the value the engine
  sets for a 200-row search.
- Ground truth per query: the exact nearest vectors **of album A**, computed with the index
  scans disabled (`enable_indexscan = off`, `enable_bitmapscan = off`).
- Recall@K = (hits of the ground-truth set that the search returned) / K.

Two row limits are reported, because both matter: K = 10 is what a "top matches" screen
needs, K = 200 is what the engine actually asks for (`INSIGHTFACE_MAX_FACES`, default 200 —
the worker keeps every hit above the cosine threshold, not the best ten).

## Results

| search | index | K | recall@K | rows returned | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| **before** — event-wide order, album filtered afterwards (v5 shape) | global HNSW | 10 | 0.886 | 10 | 2.9 ms | 3.5 ms |
| **after** — `album_id` in the statement, planner's choice | partial per album | 10 | **1.000** | 10 | 28.7 ms | 29.4 ms |
| **after** — same, ordering forced through the album's HNSW index | partial per album | 10 | 0.894 | 10 | 2.9 ms | 5.5 ms |
| **before** — event-wide order, album filtered afterwards (v5 shape) | global HNSW | 200 | **0.504** | **100.9** | 4.9 ms | 6.3 ms |
| **after** — `album_id` in the statement, planner's choice | partial per album | 200 | **1.000** | 200 | 33.9 ms | 35.8 ms |
| **after** — same, ordering forced through the album's HNSW index | partial per album | 200 | 0.852 | 200 | 4.3 ms | 8.2 ms |

The row the spec predicted is the fourth one: at the engine's real limit the v5 shape returns
**100.9 usable rows out of 200 and recall 0.50** with two albums — half the candidates for
the gallery simply do not come back, and with three albums it would be a third. After 011 the
album search returns a full 200 rows every time.

## What the planner picks, and why both numbers are there

At 30 000 vectors in the album, Postgres prefers an **exact** scan of the album
(`Index Scan using face_vectors_album_idx` + `Sort`) over the album's HNSW index: that is the
"planner's choice" row, recall 1.000 at ~34 ms. It is slower but lossless, so it is a good
default for an event of this size. The partial HNSW index is what keeps the search at ~4 ms
once an album is large enough for the planner to choose it (its cost crosses over as the
album grows); forcing it here shows what it delivers: 0.852 recall at 4.3 ms.

Either way the album filter is served by an index and no neighbour of another album is ever
in the way. Plans (query vector elided):

```
before, K = 200
Limit
  ->  Subquery Scan on picked
        Filter: (picked.album_id = '02e0…'::uuid)          <-- the loss happens here
        ->  Limit  (rows=200)
              ->  Index Scan using face_vectors_embedding_idx on face_vectors
                    Order By: (embedding <=> '[…]'::vector)
                    Filter: (event_id = '26d9…'::uuid)

after, K = 200, planner's choice
Limit
  ->  Sort
        Sort Key: ((embedding <=> '[…]'::vector))
        ->  Index Scan using face_vectors_album_idx on face_vectors
              Index Cond: (album_id = '02e0…'::uuid)

after, K = 200, ordering forced through the album index
Limit
  ->  Index Scan using face_vectors_hnsw_02e0bd70419a411e8bc46b3e7a195dad on face_vectors
        Order By: (embedding <=> '[…]'::vector)
```

## Two findings worth keeping

1. **The album id must be in the statement text, not in a parameter.** A partial index is only
   usable when the planner can prove the query's restriction implies the index predicate, and
   `album_id = $4` proves nothing the moment the statement gets a generic plan — which is what
   a reused prepared statement gets after five executions, and the worker runs this statement
   thousands of times. `searchAlbumSql()` therefore interpolates the id (checked against a
   uuid pattern first) and keeps the vector and the limit as parameters. There is a test for
   both halves of this in `packages/db/src/albums.pg.test.ts`.
2. **Every recognising album needs its index, whoever created the row.** Migration 011 indexes
   the albums that exist when it runs, `createAlbum` indexes the ones the application creates,
   and a trigger on `albums` covers the rest (the `events_default_album` trigger of 009, plain
   SQL in a seeding script). Without the trigger the default album of every event created
   after the migration would silently fall back to an exact scan.

## Reproducing

The measurement is a throwaway script, not committed: it creates a scratch database, migrates
it, inserts the synthetic vectors described above and prints the table. The numbers come from
one machine and one dataset — they are a comparison between two index layouts, not a capacity
plan. The throughput benchmark of §F1 is the one to size hardware from.
