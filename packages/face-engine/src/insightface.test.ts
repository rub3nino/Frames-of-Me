import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFaceEngine } from "./index.ts";
import {
  CREATE_EXTENSION_SQL,
  DELETE_FACES_SQL,
  DELETE_PHOTO_SQL,
  EMBED_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
  FACE_VECTORS_DDL,
  FaceServiceUnavailable,
  FaceVectorsTableMissing,
  INSERT_FACES_SQL,
  InsightFaceEngine,
  SEARCH_EXCLUDING_SQL,
  SEARCH_SQL,
  SELECT_VECTOR_SQL,
  TABLE_EXISTS_SQL,
  mapCosine,
  type ServiceFace,
  type VectorSql,
} from "./insightface.ts";
import { RateLimitedFaceEngine } from "./limiter.ts";

const EVENT = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

type Call = { query: string; params: unknown[] };

/** Records every query; `answer` decides the rows per statement. */
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

/** No table; `create extension` fails unless `extensionOk`, DDL succeeds and makes the table present. */
function missingTableSql(extensionOk = false): VectorSql & { calls: string[] } {
  let present = false;
  const calls: string[] = [];
  const sql: VectorSql & { calls: string[] } = {
    calls,
    async unsafe(query) {
      calls.push(query);
      if (query === TABLE_EXISTS_SQL) return [{ present }];
      if (query === CREATE_EXTENSION_SQL) {
        if (!extensionOk) throw new Error('extension "vector" is not available');
        return [];
      }
      if (query === FACE_VECTORS_DDL[0]) present = true;
      return [];
    },
    begin(fn) {
      return fn(sql);
    },
  };
  return sql;
}

type FetchCall = { url: string; body: FormData; signal: AbortSignal | null | undefined; method: string | undefined };

function stubFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: init?.body as FormData, signal: init?.signal, method: init?.method };
    calls.push(call);
    return respond(call);
  }) as typeof fetch & { calls: FetchCall[] };
  impl.calls = calls;
  return impl;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function embedding(seed: number): number[] {
  const values = Array.from({ length: 512 }, (_, index) => ((index * 31 + seed) % 97) / 97);
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

function face(seed: number, overrides: Partial<ServiceFace> = {}): ServiceFace {
  return {
    bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
    score: 0.9,
    quality: 0.8,
    embedding: embedding(seed),
    ...overrides,
  };
}

function engine(options: { sql?: VectorSql; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  return new InsightFaceEngine({
    env: { DATABASE_URL: "postgres://x", ...options.env },
    sql: options.sql ?? stubSql(),
    fetch: options.fetch ?? stubFetch(() => json(200, { width: 1, height: 1, faces: [] })),
  });
}

describe("InsightFace similarity mapping", () => {
  it("maps MIN to 80, SURE to 100, halfway to 90 and drops below MIN", () => {
    assert.equal(mapCosine(0.45, 0.45, 0.65), 80);
    assert.equal(mapCosine(0.65, 0.45, 0.65), 100);
    assert.equal(mapCosine(0.55, 0.45, 0.65), 90);
    assert.equal(mapCosine(0.9, 0.45, 0.65), 100);
    assert.equal(mapCosine(0.4499, 0.45, 0.65), undefined);
    assert.equal(mapCosine(Number.NaN, 0.45, 0.65), undefined);
    const custom = engine({ env: { INSIGHTFACE_MIN_COSINE: "0.3", INSIGHTFACE_SURE_COSINE: "0.5" } });
    assert.equal(custom.mapSimilarity(0.4), 90);
    assert.equal(custom.mapSimilarity(0.29), undefined);
  });

  it("validates the env", () => {
    assert.throws(
      () => engine({ env: { INSIGHTFACE_MIN_COSINE: "0.7", INSIGHTFACE_SURE_COSINE: "0.6" } }),
      /SURE_COSINE/,
    );
    assert.throws(() => engine({ env: { INSIGHTFACE_MAX_FACES: "0" } }), /INSIGHTFACE_MAX_FACES/);
    assert.throws(() => engine({ env: { FACE_SERVICE_URL: "ftp://x" } }), /FACE_SERVICE_URL/);
    assert.throws(
      () => new InsightFaceEngine({ env: {}, fetch: stubFetch(() => json(200, {})) }),
      /DATABASE_URL/,
    );
    const defaults = engine({ env: { FACE_SERVICE_URL: " http://face:8090/ " } });
    assert.equal(defaults.serviceUrl, "http://face:8090");
    assert.equal(defaults.minCosine, 0.5);
    assert.equal(defaults.sureCosine, 0.7);
    assert.equal(defaults.searchMaxFaces, 200);
    assert.equal(defaults.indexMaxFaces, 100);
    assert.equal(defaults.minFaceQuality, 0.2);
    assert.throws(() => engine({ env: { INSIGHTFACE_INDEX_MAX_FACES: "151" } }), /INDEX_MAX_FACES/);
  });
});

describe("InsightFace indexPhoto", () => {
  it("posts the image, keeps faces at or above the quality floor and inserts them in one statement", async () => {
    const ids = ["a", "b"];
    const sql = stubSql((call) =>
      call.query === INSERT_FACES_SQL ? ids.map((id) => ({ external_face_id: id })) : [],
    );
    const fetch = stubFetch(() =>
      json(200, {
        width: 100,
        height: 50,
        faces: [
          face(1, { quality: 0.95, score: 0.99, bbox: { left: 0.5, top: 0.25, width: 0.3, height: 0.5 } }),
          face(2, { quality: 0.2 }),
          face(3, { quality: 0.19 }),
          face(4, { embedding: [1, 2, 3] }),
        ],
      }),
    );
    const faces = await engine({ sql, fetch }).indexPhoto({
      eventId: EVENT,
      photoId: PHOTO,
      imageBytes: BYTES,
      contentType: "image/jpeg",
    });
    assert.equal(fetch.calls[0]?.url, "http://localhost:8090/v1/embed?max_faces=100&min_size=24");
    const image = fetch.calls[0]?.body.get("image");
    assert.ok(image instanceof Blob);
    assert.equal(image.type, "image/jpeg");
    assert.equal(image.size, BYTES.byteLength);
    assert.deepEqual(faces, [
      {
        externalFaceId: "a",
        bbox: { left: 0.5, top: 0.25, width: 0.3, height: 0.5 },
        confidence: 99,
      },
      { externalFaceId: "b", bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 }, confidence: 90 },
    ]);
    const inserts = sql.calls.filter((call) => call.query === INSERT_FACES_SQL);
    assert.equal(inserts.length, 1);
    // v5 (A2): the photo's previous vectors go first, in the same transaction as the insert.
    const deletes = sql.calls.filter((call) => call.query === DELETE_PHOTO_SQL);
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0]?.params, [PHOTO]);
    assert.ok(sql.calls.indexOf(deletes[0] as Call) < sql.calls.indexOf(inserts[0] as Call));
    assert.equal(inserts[0]?.params[0], EVENT);
    assert.equal(inserts[0]?.params[1], PHOTO);
    const vectors = inserts[0]?.params[2] as string[];
    assert.equal(vectors.length, 2);
    assert.match(vectors[0] ?? "", /^\[[-0-9.e,]+\]$/);
    assert.equal(vectors[0]?.split(",").length, 512);
  });

  it("returns [] and skips the insert when no face passes the filter, still clearing old vectors", async () => {
    const sql = stubSql();
    const faces = await engine({
      sql,
      fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [face(1, { quality: 0.1 })] })),
    }).indexPhoto({ eventId: EVENT, photoId: PHOTO, imageBytes: BYTES, contentType: "image/png" });
    assert.deepEqual(faces, []);
    assert.equal(sql.calls.some((call) => call.query === INSERT_FACES_SQL), false);
    assert.equal(sql.calls.filter((call) => call.query === DELETE_PHOTO_SQL).length, 1);
  });

  it("treats 400 as no faces and 5xx / connection errors as FaceServiceUnavailable", async () => {
    const input = { eventId: EVENT, photoId: PHOTO, imageBytes: BYTES, contentType: "image/jpeg" } as const;
    assert.deepEqual(
      await engine({ fetch: stubFetch(() => new Response("bad image", { status: 400 })) }).indexPhoto(input),
      [],
    );
    await assert.rejects(
      engine({ fetch: stubFetch(() => new Response("boom", { status: 503 })) }).indexPhoto(input),
      (error: unknown) =>
        error instanceof FaceServiceUnavailable && error.name === "FaceServiceUnavailable",
    );
    await assert.rejects(
      engine({
        fetch: stubFetch(() => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        }),
      }).indexPhoto(input),
      (error: unknown) =>
        error instanceof FaceServiceUnavailable && !error.message.includes("ÿ"),
    );
    await assert.rejects(
      engine({ fetch: stubFetch(() => new Response("too big", { status: 413 })) }).indexPhoto(input),
      (error: unknown) => error instanceof Error && error.name === "FaceServiceError",
    );
  });

  it("fails with a clear error when face_vectors is missing and pgvector cannot be created", async () => {
    const sql = missingTableSql(false);
    const broken = engine({ sql });
    await assert.rejects(
      broken.indexPhoto({ eventId: EVENT, photoId: PHOTO, imageBytes: BYTES, contentType: "image/jpeg" }),
      (error: unknown) =>
        error instanceof FaceVectorsTableMissing && /pgvector/.test(error.message),
    );
    await assert.rejects(broken.ready(), FaceVectorsTableMissing);
    assert.equal(sql.calls.filter((query) => query === CREATE_EXTENSION_SQL).length, 2);
    assert.equal(sql.calls.some((query) => FACE_VECTORS_DDL.includes(query)), false);
  });

  it("creates the extension, table and indexes once when face_vectors is missing", async () => {
    const sql = missingTableSql(true);
    const subject = engine({ sql });
    await subject.ready();
    assert.deepEqual(sql.calls, [TABLE_EXISTS_SQL, CREATE_EXTENSION_SQL, ...FACE_VECTORS_DDL]);
    assert.equal(FACE_VECTORS_DDL.length, 5);
    assert.ok(FACE_VECTORS_DDL.every((statement) => /if not exists|not exists \(select 1 from pg_constraint/.test(statement)), "idempotent DDL");
    // v5 (A2): the foreign key on photos, guarded so it only runs once photos exists.
    assert.match(FACE_VECTORS_DDL[4] ?? "", /references photos\(id\) on delete cascade/);
    assert.match(FACE_VECTORS_DDL[4] ?? "", /to_regclass\('public.photos'\)/);
    await subject.ready();
    await subject.deleteCollection(EVENT);
    assert.equal(sql.calls.filter((query) => query === TABLE_EXISTS_SQL).length, 1, "checked once");
    assert.equal(sql.calls.filter((query) => query === CREATE_EXTENSION_SQL).length, 1, "healed once");
  });
});

describe("InsightFace search", () => {
  const rows = [
    { external_face_id: "f1", photo_id: "p1", cos: 0.9 },
    { external_face_id: "f2", photo_id: "p2", cos: "0.65" },
    { external_face_id: "f3", photo_id: "p3", cos: 0.55 },
    { external_face_id: "f4", photo_id: "p4", cos: 0.45 },
    { external_face_id: "f5", photo_id: "p5", cos: 0.449 },
    { external_face_id: "f6", photo_id: "p6", cos: -0.2 },
  ];

  it("embeds the selfie, searches with the largest face and maps cosine to 80..100 with the raw cosine", async () => {
    const sql = stubSql((call) => (call.query === SEARCH_SQL ? rows : []));
    const small = face(1, { bbox: { left: 0, top: 0, width: 0.1, height: 0.1 } });
    const big = face(2, { bbox: { left: 0, top: 0, width: 0.5, height: 0.4 } });
    const hits = await engine({
      sql,
      fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [small, big] })),
    }).search({ eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" });
    // Defaults MIN 0.5 / SURE 0.7: 0.9 → 100, 0.65 → 95, 0.55 → 85, 0.45 and below dropped.
    assert.deepEqual(hits, [
      { externalFaceId: "f1", photoId: "p1", similarity: 100, cosine: 0.9 },
      { externalFaceId: "f2", photoId: "p2", similarity: 95, cosine: 0.65 },
      { externalFaceId: "f3", photoId: "p3", similarity: 85, cosine: 0.55 },
    ]);
    const search = sql.calls.find((call) => call.query === SEARCH_SQL);
    assert.ok(search);
    assert.equal(search.params[0], `[${big.embedding.join(",")}]`);
    assert.equal(search.params[1], EVENT);
    assert.equal(search.params[2], 200);
    const setLocal = sql.calls.find((call) => call.query.startsWith("set local hnsw.ef_search"));
    assert.equal(setLocal?.query, "set local hnsw.ef_search = 200");
    assert.ok(sql.calls.indexOf(setLocal as Call) < sql.calls.indexOf(search));
  });

  it("uses ef_search 100 for small limits and the limit otherwise", async () => {
    const sql = stubSql();
    await engine({
      sql,
      env: { INSIGHTFACE_MAX_FACES: "7" },
      fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [face(1)] })),
    }).search({ eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" });
    assert.ok(sql.calls.some((call) => call.query === "set local hnsw.ef_search = 100"));
    assert.equal(sql.calls.find((call) => call.query === SEARCH_SQL)?.params[2], 7);
  });

  it("returns [] without a query when the selfie has no face or is not an image", async () => {
    const sql = stubSql();
    const input = { eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" } as const;
    assert.deepEqual(
      await engine({ sql, fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [] })) }).search(input),
      [],
    );
    assert.deepEqual(
      await engine({ sql, fetch: stubFetch(() => new Response("", { status: 400 })) }).search(input),
      [],
    );
    assert.equal(sql.calls.some((call) => call.query === SEARCH_SQL), false);
    await assert.rejects(
      engine({ sql, fetch: stubFetch(() => new Response("", { status: 500 })) }).search(input),
      FaceServiceUnavailable,
    );
  });

  it("searchFaces uses the stored vector, excludes the face itself and maps unknown ids to []", async () => {
    const stored = `[${embedding(9).join(",")}]`;
    const sql = stubSql((call) => {
      if (call.query === SELECT_VECTOR_SQL) {
        return call.params[0] === "f1" ? [{ embedding: stored }] : [];
      }
      if (call.query === SEARCH_EXCLUDING_SQL) {
        return [{ external_face_id: "f2", photo_id: "p2", cos: 0.7 }];
      }
      return [];
    });
    const fetch = stubFetch(() => json(200, {}));
    const subject = engine({ sql, fetch });
    const hits = await subject.searchFaces({ eventId: EVENT, externalFaceId: "f1" });
    assert.deepEqual(hits, [{ externalFaceId: "f2", photoId: "p2", similarity: 100, cosine: 0.7 }]);
    const query = sql.calls.find((call) => call.query === SEARCH_EXCLUDING_SQL);
    assert.deepEqual(query?.params, [stored, EVENT, 200, "f1"]);
    assert.equal(fetch.calls.length, 0, "no HTTP round trip for searchFaces");

    assert.deepEqual(await subject.searchFaces({ eventId: EVENT, externalFaceId: "nope" }), []);
    assert.equal(sql.calls.filter((call) => call.query === SEARCH_EXCLUDING_SQL).length, 1);
  });
});

describe("InsightFace deletes", () => {
  it("deletes faces in chunks of 1000 and the whole event in one statement", async () => {
    const sql = stubSql();
    const subject = engine({ sql });
    const ids = Array.from({ length: 2345 }, (_, index) => `f${index}`);
    await subject.deleteFaces(EVENT, ids);
    const deletes = sql.calls.filter((call) => call.query === DELETE_FACES_SQL);
    assert.deepEqual(
      deletes.map((call) => (call.params[1] as string[]).length),
      [1000, 1000, 345],
    );
    assert.ok(deletes.every((call) => call.params[0] === EVENT));
    assert.equal((deletes[2]?.params[1] as string[])[0], "f2000");

    await subject.deleteFaces(EVENT, []);
    assert.equal(sql.calls.filter((call) => call.query === DELETE_FACES_SQL).length, 3);

    await subject.deleteCollection(EVENT);
    const last = sql.calls.at(-1);
    assert.match(last?.query ?? "", /delete from face_vectors\s+where event_id = \$1::uuid$/);
    assert.deepEqual(last?.params, [EVENT]);
  });
});

describe("InsightFace liveness", () => {
  it("posts to /v1/liveness and returns the verdict", async () => {
    const fetch = stubFetch(() => json(200, { live: false, score: 0.12, method: "silent-face" }));
    const verdict = await engine({ fetch }).checkLiveness({ imageBytes: BYTES, contentType: "image/jpeg" });
    assert.deepEqual(verdict, { live: false, score: 0.12, method: "silent-face" });
    assert.equal(fetch.calls[0]?.url, "http://localhost:8090/v1/liveness");
  });

  it("does not reject on 400 and raises FaceServiceUnavailable on 5xx", async () => {
    const input = { imageBytes: BYTES, contentType: "image/jpeg" } as const;
    assert.deepEqual(
      await engine({ fetch: stubFetch(() => new Response("", { status: 400 })) }).checkLiveness(input),
      { live: true, score: 0, method: "none" },
    );
    await assert.rejects(
      engine({ fetch: stubFetch(() => new Response("", { status: 502 })) }).checkLiveness(input),
      FaceServiceUnavailable,
    );
  });
});

describe("createFaceEngine with insightface", () => {
  it("wraps the engine in the limiter and forwards checkLiveness", () => {
    const limited = createFaceEngine({
      FACE_ENGINE: "insightface",
      DATABASE_URL: "postgres://x",
      FACE_INDEX_TPS: "",
      FACE_SEARCH_TPS: "3",
    });
    assert.ok(limited instanceof RateLimitedFaceEngine);
    assert.equal(typeof limited.checkLiveness, "function");
    assert.throws(() =>
      createFaceEngine({ FACE_ENGINE: "insightface", DATABASE_URL: "postgres://x", FACE_INDEX_TPS: "0" }),
    );
    const rekognition = createFaceEngine({ FACE_ENGINE: "rekognition", FACE_SEARCH_TPS: "2" });
    assert.equal(rekognition.checkLiveness, undefined);
    assert.throws(() => createFaceEngine({ FACE_ENGINE: "rekognition", FACE_SEARCH_TPS: "-2" }));
    assert.throws(() => createFaceEngine({ FACE_ENGINE: "other" }), /insightface/);
  });
});

// ---- v5 (agent A): selfie embedding, vector search, timeouts ------------------------------

describe("InsightFace v5 vector path", () => {
  const rows = [
    { external_face_id: "f1", photo_id: "p1", cos: 0.9 },
    { external_face_id: "f2", photo_id: "p2", cos: 0.6 },
    { external_face_id: "f3", photo_id: "p3", cos: 0.3 },
    { external_face_id: "f4", photo_id: "p4", cos: 0.2 },
  ];

  it("embedSelfie returns every face with its embedding and the detection size, no quality filter", async () => {
    const fetch = stubFetch(() =>
      json(200, {
        width: 640,
        height: 480,
        faces: [face(1, { quality: 0.1, bbox: { left: 0.2, top: 0.1, width: 0.5, height: 0.6 } }), face(2, { embedding: [1] }), face(3)],
      }),
    );
    const result = await engine({ fetch }).embedSelfie({ imageBytes: BYTES, contentType: "image/jpeg" });
    assert.equal(result.width, 640);
    assert.equal(result.height, 480);
    assert.equal(result.faces.length, 2, "the malformed embedding is dropped, the low quality face kept");
    assert.deepEqual(result.faces[0]?.bbox, { left: 0.2, top: 0.1, width: 0.5, height: 0.6 });
    assert.equal(result.faces[0]?.quality, 0.1);
    assert.equal(result.faces[0]?.embedding.length, 512);
    assert.equal(fetch.calls[0]?.url, "http://localhost:8090/v1/embed?max_faces=100&min_size=24");
    const none = await engine({ fetch: stubFetch(() => new Response("", { status: 400 })) }).embedSelfie({
      imageBytes: BYTES,
      contentType: "image/jpeg",
    });
    assert.deepEqual(none, { faces: [], width: 0, height: 0 });
  });

  it("searchByVector maps cosine with the raw value, honours minCosine below MIN (similarity 0) and maxFaces", async () => {
    const sql = stubSql((call) => (call.query === SEARCH_SQL ? rows : []));
    const subject = engine({ sql });
    const vector = embedding(5);
    const hits = await subject.searchByVector({ eventId: EVENT, embedding: vector });
    assert.deepEqual(hits, [
      { externalFaceId: "f1", photoId: "p1", similarity: 100, cosine: 0.9 },
      { externalFaceId: "f2", photoId: "p2", similarity: 90, cosine: 0.6 },
    ]);
    const search = sql.calls.find((call) => call.query === SEARCH_SQL);
    assert.deepEqual(search?.params, [`[${vector.join(",")}]`, EVENT, 200]);

    const logged = await subject.searchByVector({ eventId: EVENT, embedding: vector, minCosine: 0.25, maxFaces: 7 });
    assert.deepEqual(
      logged.map((hit) => [hit.externalFaceId, hit.similarity, hit.cosine]),
      [
        ["f1", 100, 0.9],
        ["f2", 90, 0.6],
        ["f3", 0, 0.3],
      ],
    );
    const last = sql.calls.filter((call) => call.query === SEARCH_SQL).at(-1);
    assert.equal(last?.params[2], 7);
    assert.ok(sql.calls.some((call) => call.query === "set local hnsw.ef_search = 100"));
    await assert.rejects(subject.searchByVector({ eventId: EVENT, embedding: [1, 2, 3] }), /512/);
  });

  it("faceEmbedding parses the stored vector and returns null for unknown ids", async () => {
    const stored = embedding(3);
    const sql = stubSql((call) =>
      call.query === SELECT_VECTOR_SQL && call.params[0] === "f1" ? [{ embedding: `[${stored.join(",")}]` }] : [],
    );
    const subject = engine({ sql });
    const parsed = await subject.faceEmbedding({ eventId: EVENT, externalFaceId: "f1" });
    assert.ok(parsed);
    assert.equal(parsed.length, 512);
    assert.ok(Math.abs((parsed[0] ?? 0) - (stored[0] ?? 0)) < 1e-9);
    assert.equal(await subject.faceEmbedding({ eventId: EVENT, externalFaceId: "nope" }), null);
  });

  it("posts embed/search with a 60 s abort signal and health with a 10 s one", async () => {
    const fetch = stubFetch((call) =>
      call.method === "GET" ? new Response("ok", { status: 200 }) : json(200, { width: 1, height: 1, faces: [] }),
    );
    const subject = engine({ fetch });
    await subject.search({ eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" });
    assert.equal(EMBED_TIMEOUT_MS, 60_000);
    assert.equal(HEALTH_TIMEOUT_MS, 10_000);
    assert.ok(fetch.calls[0]?.signal instanceof AbortSignal, "embed carries an abort signal");
    assert.equal(fetch.calls[0]?.signal?.aborted, false);
    assert.equal(await subject.health(), true);
    assert.equal(fetch.calls[1]?.method, "GET");
    assert.equal(fetch.calls[1]?.url, "http://localhost:8090/health");
    assert.ok(fetch.calls[1]?.signal instanceof AbortSignal, "health carries an abort signal");
    // A timeout surfaces as FaceServiceUnavailable, like a connection failure.
    const timedOut = engine({
      fetch: stubFetch(() => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    });
    await assert.rejects(
      timedOut.search({ eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" }),
      FaceServiceUnavailable,
    );
    assert.equal(await timedOut.health(), false);
  });

  it("cosineSimilarity is 1 for equal vectors, 0 for orthogonal or empty ones", async () => {
    const { cosineSimilarity } = await import("./insightface.ts");
    assert.ok(Math.abs(cosineSimilarity(embedding(1), embedding(1)) - 1) < 1e-9);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([], [1]), 0);
  });

  it("the limiter forwards embedSelfie, searchByVector and faceEmbedding only when the inner engine has them", () => {
    const limited = createFaceEngine({
      FACE_ENGINE: "insightface",
      DATABASE_URL: "postgres://x",
    }) as RateLimitedFaceEngine;
    assert.equal(typeof limited.embedSelfie, "function");
    assert.equal(typeof limited.searchByVector, "function");
    assert.equal(typeof limited.faceEmbedding, "function");
    const rekognition = createFaceEngine({ FACE_ENGINE: "rekognition" }) as RateLimitedFaceEngine;
    assert.equal(rekognition.embedSelfie, undefined);
    assert.equal(rekognition.searchByVector, undefined);
    assert.equal(rekognition.faceEmbedding, undefined);
  });
});
