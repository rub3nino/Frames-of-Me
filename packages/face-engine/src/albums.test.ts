/**
 * v6 A3 (agent A): vector isolation per album in the InsightFace engine. Every search path
 * filters on `album_id` through a statement that an album's partial HNSW index can serve
 * (migration 011), instead of filtering the event after the index already chose the
 * neighbours. The SQL itself is checked against a real pgvector database in
 * `packages/db/src/albums.pg.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INSERT_FACES_SQL,
  InsightFaceEngine,
  SEARCH_EXCLUDING_SQL,
  SEARCH_SQL,
  SELECT_VECTOR_SQL,
  TABLE_EXISTS_SQL,
  albumUuid,
  searchAlbumExcludingSql,
  searchAlbumSql,
  type VectorSql,
} from "./insightface.ts";

const EVENT = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const ALBUM_A = "33333333-3333-4333-8333-333333333333";
const ALBUM_B = "44444444-4444-4444-8444-444444444444";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

type Call = { query: string; params: unknown[] };

function stubSql(answer: (call: Call) => unknown[] = () => []): VectorSql & { calls: Call[] } {
  const calls: Call[] = [];
  const sql: VectorSql & { calls: Call[] } = {
    calls,
    async unsafe(query, params = []) {
      const call = { query, params };
      calls.push(call);
      if (query === TABLE_EXISTS_SQL) return [{ present: true }];
      return answer(call) as Record<string, unknown>[];
    },
    begin(fn) {
      return fn(sql);
    },
  };
  return sql;
}

function face(quality = 0.9): Record<string, unknown> {
  return {
    bbox: { left: 0.1, top: 0.1, width: 0.5, height: 0.5 },
    score: 0.99,
    quality,
    embedding: Array.from({ length: 512 }, () => 0.04419417382415922),
  };
}

/** A face service that always answers with one usable face. */
function stubFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ width: 1600, height: 1200, faces: [face()] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function engine(sql: VectorSql): InsightFaceEngine {
  return new InsightFaceEngine({
    sql,
    fetch: stubFetch(),
    env: { DATABASE_URL: "postgres://stub/stub", FACE_SERVICE_URL: "http://face.invalid" },
  });
}

const VECTOR = Array.from({ length: 512 }, (_, index) => (index % 7) / 10);

describe("InsightFace album isolation (v6 A3)", () => {
  it("stores the album on every vector it inserts", async () => {
    const sql = stubSql((call) =>
      call.query === INSERT_FACES_SQL ? [{ external_face_id: "f1" }] : [],
    );
    await engine(sql).indexPhoto({
      eventId: EVENT,
      photoId: PHOTO,
      albumId: ALBUM_A,
      imageBytes: BYTES,
      contentType: "image/jpeg",
    });
    const insert = sql.calls.find((call) => call.query === INSERT_FACES_SQL);
    assert.equal(insert?.params[3], ALBUM_A, "album_id is the fourth parameter");
    assert.match(INSERT_FACES_SQL, /insert into face_vectors \(event_id, photo_id, embedding, album_id\)/);
    // Without an explicit album the insert reads it from the photo row, so album_id is
    // never null (`face_vectors.album_id` is not null after migration 011).
    assert.match(INSERT_FACES_SQL, /select p\.album_id from photos p where p\.id = \$2::uuid/);
  });

  it("searches inside one album with a statement the album's partial index serves", async () => {
    const rows = [{ external_face_id: "f1", photo_id: "p1", cos: 0.9 }];
    const sql = stubSql((call) => (call.query === searchAlbumSql(ALBUM_A) ? rows : []));
    const hits = await engine(sql).searchByVector({
      eventId: EVENT,
      embedding: VECTOR,
      albumIds: [ALBUM_A],
    });
    assert.equal(hits.length, 1);
    const search = sql.calls.find((call) => call.query === searchAlbumSql(ALBUM_A));
    assert.deepEqual(search?.params, [`[${VECTOR.join(",")}]`, EVENT, 200]);
    assert.equal(sql.calls.some((call) => call.query === SEARCH_SQL), false, "no event-wide query");
    // The album id is in the statement, not in a parameter: a partial index predicate can
    // only be matched against a value the planner sees (migration 011, A3).
    assert.match(searchAlbumSql(ALBUM_A), new RegExp(`album_id = '${ALBUM_A}'::uuid`));
    assert.match(searchAlbumExcludingSql(ALBUM_A), new RegExp(`album_id = '${ALBUM_A}'::uuid`));
    // And it is a uuid or nothing: the value is interpolated, so it is checked first.
    assert.throws(() => searchAlbumSql("'; drop table face_vectors; --"), /uuid/);
    assert.throws(() => albumUuid("not-a-uuid"), /uuid/);
  });

  it("asks each album separately and merges the answers best first", async () => {
    const perAlbum: Record<string, Array<Record<string, unknown>>> = {
      [ALBUM_A]: [{ external_face_id: "a1", photo_id: "pa", cos: 0.6 }],
      [ALBUM_B]: [{ external_face_id: "b1", photo_id: "pb", cos: 0.8 }],
    };
    const byQuery: Record<string, Array<Record<string, unknown>>> = {
      [searchAlbumSql(ALBUM_A)]: perAlbum[ALBUM_A] ?? [],
      [searchAlbumSql(ALBUM_B)]: perAlbum[ALBUM_B] ?? [],
    };
    const sql = stubSql((call) => byQuery[call.query] ?? []);
    const hits = await engine(sql).searchByVector({
      eventId: EVENT,
      embedding: VECTOR,
      albumIds: [ALBUM_A, ALBUM_B],
    });
    assert.deepEqual(
      hits.map((hit) => hit.externalFaceId),
      ["b1", "a1"],
    );
    const albums = sql.calls
      .map((call) => call.query)
      .filter((query) => query === searchAlbumSql(ALBUM_A) || query === searchAlbumSql(ALBUM_B));
    assert.deepEqual(
      albums,
      [searchAlbumSql(ALBUM_A), searchAlbumSql(ALBUM_B)],
      "one indexed query per album",
    );
  });

  it("returns nothing, and queries nothing, when the event has no recognising album", async () => {
    const sql = stubSql(() => [{ external_face_id: "f1", photo_id: "p1", cos: 0.99 }]);
    const hits = await engine(sql).searchByVector({ eventId: EVENT, embedding: VECTOR, albumIds: [] });
    assert.deepEqual(hits, []);
    assert.equal(
      sql.calls.some((call) => /from face_vectors/.test(call.query)),
      false,
      "not a single query reaches face_vectors",
    );
  });

  it("searches a selfie inside the albums it is given", async () => {
    const sql = stubSql((call) =>
      call.query === searchAlbumSql(ALBUM_B)
        ? [{ external_face_id: "f1", photo_id: "p1", cos: 0.95 }]
        : [],
    );
    const hits = await engine(sql).search({
      eventId: EVENT,
      imageBytes: BYTES,
      contentType: "image/jpeg",
      albumIds: [ALBUM_B],
    });
    assert.equal(hits.length, 1);
    assert.ok(sql.calls.some((call) => call.query === searchAlbumSql(ALBUM_B)));
  });

  it("compares an indexed face inside its own album by default", async () => {
    const stored = `[${VECTOR.join(",")}]`;
    const sql = stubSql((call) => {
      if (call.query === SELECT_VECTOR_SQL) return [{ embedding: stored, album_id: ALBUM_B }];
      if (call.query === searchAlbumExcludingSql(ALBUM_B)) {
        return [{ external_face_id: "other", photo_id: "p2", cos: 0.9 }];
      }
      return [];
    });
    const hits = await engine(sql).searchFaces({ eventId: EVENT, externalFaceId: "f1" });
    assert.deepEqual(
      hits.map((hit) => hit.externalFaceId),
      ["other"],
    );
    const search = sql.calls.find((call) => call.query === searchAlbumExcludingSql(ALBUM_B));
    assert.deepEqual(search?.params, [stored, EVENT, 200, "f1"]);
    assert.equal(sql.calls.some((call) => call.query === SEARCH_EXCLUDING_SQL), false);
    assert.match(SELECT_VECTOR_SQL, /album_id::text as album_id/);
  });

  it("falls back to the v5 event-wide search when no album is known", async () => {
    // A vector stored before migration 011 has no album: the engine still answers, over the
    // event, rather than silently returning nothing.
    const stored = `[${VECTOR.join(",")}]`;
    const sql = stubSql((call) => {
      if (call.query === SELECT_VECTOR_SQL) return [{ embedding: stored }];
      if (call.query === SEARCH_EXCLUDING_SQL) {
        return [{ external_face_id: "other", photo_id: "p2", cos: 0.9 }];
      }
      return [];
    });
    const hits = await engine(sql).searchFaces({ eventId: EVENT, externalFaceId: "f1" });
    assert.equal(hits.length, 1);
    assert.equal(sql.calls.some((call) => /album_id = '/.test(call.query)), false);
  });
});
