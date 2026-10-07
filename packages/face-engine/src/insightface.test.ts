import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFaceEngine } from "./index.ts";
import {
  CREATE_EXTENSION_SQL,
  DELETE_FACES_SQL,
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

type FetchCall = { url: string; body: FormData };

function stubFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: init?.body as FormData };
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
    assert.equal(defaults.minCosine, 0.45);
    assert.equal(defaults.sureCosine, 0.65);
    assert.equal(defaults.searchMaxFaces, 500);
    assert.equal(defaults.minFaceQuality, 0.3);
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
          face(2, { quality: 0.3 }),
          face(3, { quality: 0.29 }),
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
    assert.equal(fetch.calls[0]?.url, "http://localhost:8090/v1/embed?max_faces=50");
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
    assert.equal(inserts[0]?.params[0], EVENT);
    assert.equal(inserts[0]?.params[1], PHOTO);
    const vectors = inserts[0]?.params[2] as string[];
    assert.equal(vectors.length, 2);
    assert.match(vectors[0] ?? "", /^\[[-0-9.e,]+\]$/);
    assert.equal(vectors[0]?.split(",").length, 512);
  });

  it("returns [] and skips the insert when no face passes the filter", async () => {
    const sql = stubSql();
    const faces = await engine({
      sql,
      fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [face(1, { quality: 0.1 })] })),
    }).indexPhoto({ eventId: EVENT, photoId: PHOTO, imageBytes: BYTES, contentType: "image/png" });
    assert.deepEqual(faces, []);
    assert.equal(sql.calls.some((call) => call.query === INSERT_FACES_SQL), false);
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
    assert.equal(FACE_VECTORS_DDL.length, 4);
    assert.ok(FACE_VECTORS_DDL.every((statement) => /if not exists/.test(statement)));
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

  it("embeds the selfie, searches with the largest face and maps cosine to 80..100", async () => {
    const sql = stubSql((call) => (call.query === SEARCH_SQL ? rows : []));
    const small = face(1, { bbox: { left: 0, top: 0, width: 0.1, height: 0.1 } });
    const big = face(2, { bbox: { left: 0, top: 0, width: 0.5, height: 0.4 } });
    const hits = await engine({
      sql,
      fetch: stubFetch(() => json(200, { width: 1, height: 1, faces: [small, big] })),
    }).search({ eventId: EVENT, imageBytes: BYTES, contentType: "image/jpeg" });
    assert.deepEqual(hits, [
      { externalFaceId: "f1", photoId: "p1", similarity: 100 },
      { externalFaceId: "f2", photoId: "p2", similarity: 100 },
      { externalFaceId: "f3", photoId: "p3", similarity: 90 },
      { externalFaceId: "f4", photoId: "p4", similarity: 80 },
    ]);
    const search = sql.calls.find((call) => call.query === SEARCH_SQL);
    assert.ok(search);
    assert.equal(search.params[0], `[${big.embedding.join(",")}]`);
    assert.equal(search.params[1], EVENT);
    assert.equal(search.params[2], 500);
    const setLocal = sql.calls.find((call) => call.query.startsWith("set local hnsw.ef_search"));
    assert.equal(setLocal?.query, "set local hnsw.ef_search = 500");
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
    assert.deepEqual(hits, [{ externalFaceId: "f2", photoId: "p2", similarity: 100 }]);
    const query = sql.calls.find((call) => call.query === SEARCH_EXCLUDING_SQL);
    assert.deepEqual(query?.params, [stored, EVENT, 500, "f1"]);
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
