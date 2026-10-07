/**
 * End-to-end check of the InsightFace engine against a real pgvector database
 * and a running face service. Runs only when both are reachable:
 *
 *   DATABASE_URL=postgres://... FACE_SERVICE_URL=http://localhost:8090 \
 *     node --import tsx --test packages/face-engine/src/insightface.integration.test.ts
 *
 * Otherwise every test is skipped with the reason. The database only needs the
 * pgvector extension available (pgvector/pgvector:pg16): a fresh database with no
 * migration 005 row works, the engine creates `face_vectors` itself at first use.
 * With `FACE_ENGINE_INTEGRATION_DB_ONLY=1` the service probe is skipped and the
 * HTTP side is stubbed, so the database half runs alone.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";
import {
  DEFAULT_FACE_SERVICE_URL,
  InsightFaceEngine,
  adaptSql,
} from "./insightface.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const FACE_SERVICE_URL = (process.env.FACE_SERVICE_URL ?? DEFAULT_FACE_SERVICE_URL).replace(/\/+$/, "");
const PROBE_TIMEOUT_MS = 3000;

type Readiness = { ok: true } | { ok: false; reason: string };

async function databaseReady(): Promise<Readiness> {
  if (!DATABASE_URL) return { ok: false, reason: "DATABASE_URL is not set" };
  const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    const extension = await sql`select 1 from pg_extension where extname = 'vector'`;
    if (extension.length === 0) {
      return { ok: false, reason: "pgvector extension is not installed in DATABASE_URL" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `DATABASE_URL unreachable: ${(error as Error).message}` };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function serviceReady(): Promise<Readiness> {
  try {
    const response = await fetch(`${FACE_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `${FACE_SERVICE_URL}/health answered ${response.status}` };
    const body = (await response.json()) as { ok?: boolean };
    if (body.ok !== true) return { ok: false, reason: `${FACE_SERVICE_URL}/health reports not ok` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `${FACE_SERVICE_URL}/health unreachable: ${(error as Error).message}` };
  }
}

/** A JPEG that decodes but holds no face: the service must answer with zero faces. */
function blankJpeg(): Uint8Array {
  // 1x1 grey baseline JPEG.
  return Uint8Array.from(
    Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
      "base64",
    ),
  );
}

const DB_ONLY = process.env.FACE_ENGINE_INTEGRATION_DB_ONLY === "1";
const db = await databaseReady();
const service = DB_ONLY ? ({ ok: true } as Readiness) : await serviceReady();
const skip = !db.ok ? db.reason : !service.ok ? service.reason : false;

/** DB-only mode: the service always answers "no faces" / "live". */
const stubbedFetch: typeof fetch = async (input) =>
  String(input).endsWith("/v1/liveness")
    ? Response.json({ live: true, score: 0, method: "none" })
    : Response.json({ width: 1, height: 1, faces: [] });

describe("InsightFace engine integration", { skip }, () => {
  const eventId = randomUUID();
  let client: postgres.Sql;
  let engine: InsightFaceEngine;

  before(() => {
    client = postgres(DATABASE_URL as string, { max: 2, onnotice: () => undefined });
    engine = new InsightFaceEngine({
      env: { DATABASE_URL, FACE_SERVICE_URL },
      sql: adaptSql(client),
      ...(DB_ONLY ? { fetch: stubbedFetch } : {}),
    });
  });

  after(async () => {
    await client`delete from face_vectors where event_id = ${eventId}`;
    await client.end({ timeout: 2 });
  });

  it("creates face_vectors on first use when it is missing", async () => {
    await engine.ready();
    const table = await client`select to_regclass('public.face_vectors') as name`;
    assert.equal(table[0]?.name, "face_vectors");
    const indexes = await client<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'face_vectors' order by indexname
    `;
    assert.deepEqual(
      indexes.map((row) => row.indexname),
      ["face_vectors_embedding_idx", "face_vectors_event_idx", "face_vectors_photo_idx", "face_vectors_pkey"],
    );
  });

  it("indexes nothing for an image without faces and searches it to []", async () => {
    const photoId = randomUUID();
    const faces = await engine.indexPhoto({
      eventId,
      photoId,
      imageBytes: blankJpeg(),
      contentType: "image/jpeg",
    });
    assert.deepEqual(faces, []);
    const hits = await engine.search({ eventId, imageBytes: blankJpeg(), contentType: "image/jpeg" });
    assert.deepEqual(hits, []);
  });

  it("round-trips a stored vector through searchFaces, excluding itself", async () => {
    const photoId = randomUUID();
    const vector = `[${Array.from({ length: 512 }, (_, index) => (index === 0 ? 1 : 0)).join(",")}]`;
    const near = `[${Array.from({ length: 512 }, (_, index) => (index === 0 ? 0.9 : index === 1 ? 0.1 : 0)).join(",")}]`;
    const rows = await client<{ external_face_id: string }[]>`
      insert into face_vectors (event_id, photo_id, embedding)
      values (${eventId}, ${photoId}, ${vector}::vector), (${eventId}, ${photoId}, ${near}::vector)
      returning external_face_id
    `;
    const [self, other] = rows.map((row) => row.external_face_id);
    assert.ok(self && other);
    const hits = await engine.searchFaces({ eventId, externalFaceId: self });
    assert.deepEqual(
      hits.map((hit) => hit.externalFaceId),
      [other],
    );
    assert.ok(hits[0] && hits[0].similarity >= 80 && hits[0].similarity <= 100);
    assert.deepEqual(await engine.searchFaces({ eventId, externalFaceId: randomUUID() }), []);

    await engine.deleteFaces(eventId, [other]);
    assert.deepEqual(await engine.searchFaces({ eventId, externalFaceId: self }), []);
    await engine.deleteCollection(eventId);
    assert.deepEqual(await engine.searchFaces({ eventId, externalFaceId: self }), []);
  });

  it("answers the liveness probe", async () => {
    const verdict = await engine.checkLiveness({ imageBytes: blankJpeg(), contentType: "image/jpeg" });
    assert.equal(typeof verdict.live, "boolean");
    assert.ok(verdict.score >= 0 && verdict.score <= 1);
    assert.ok(verdict.method === "silent-face" || verdict.method === "none");
  });
});
