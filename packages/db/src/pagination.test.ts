/**
 * v6 F3/F4 — keyset pagination and the page-scoped feedback read.
 *
 * The first block runs everywhere (MemoryDatabase). The second needs a real Postgres and is
 * skipped with a reason when `DATABASE_URL` is absent or unreachable, exactly like
 * `packages/face-engine/src/insightface.integration.test.ts`:
 *
 *   DATABASE_URL=postgres://rephoto:rephoto@localhost:5433/rephoto \
 *     node --import tsx --test packages/db/src/pagination.test.ts
 *
 * The database must have the migrations applied (`npm run db:migrate`), 014 included. The block
 * creates its own event and deletes it again, so it is safe against a dev database.
 *
 * What the Postgres block proves:
 *  - F3 correctness: with rows deliberately sharing a millisecond (the cursor is a JS Date and
 *    carries only milliseconds, while created_at keeps microseconds) a full walk through the
 *    pages visits every row exactly once, in the declared order. This is the property that
 *    forbids simply dropping `date_trunc` from the ORDER BY.
 *  - F3 performance: the plan for a cursor page is an Index Scan on the migration-014 expression
 *    index with no Sort node. Without the index it is a sequential scan plus a top-N sort.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MemoryDatabase } from "./memory.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";
import type { UploadCursor } from "./types.ts";

// ------------------------------------------------------------------ memory

/** Seeded by `MemoryDatabase.seedDemo()`; the participant id is only a key in `feedback`. */
const MEM_EVENT = "00000000-0000-4000-8000-000000000001";
const MEM_PARTICIPANT = "00000000-0000-4000-8000-000000000002";
const MEM_PHOTOGRAPHER = "00000000-0000-4000-8000-000000000003";

async function seedMemoryFeedback(db: MemoryDatabase, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await db.insertPhoto({
      id,
      eventId: MEM_EVENT,
      photographerId: MEM_PHOTOGRAPHER,
      sha256: id.replace(/-/g, "").padEnd(64, "0"),
      originalKey: `originals/${MEM_EVENT}/${id}`,
      contentType: "image/jpeg",
      bytes: 10,
    });
    await db.upsertFeedback({
      userId: MEM_PARTICIPANT,
      eventId: MEM_EVENT,
      photoId: id,
      verdict: index % 2 === 0 ? "me" : "not_me",
      scoreAtTime: 0.9,
      source: "recognition",
    });
    ids.push(id);
  }
  return ids;
}

async function memoryDb(): Promise<MemoryDatabase> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  return db;
}

describe("MemoryDatabase listFeedback scoping (v6 F4)", () => {
  it("returns every verdict of the event when no ids are given", async () => {
    const db = await memoryDb();
    const ids = await seedMemoryFeedback(db, 5);
    const all = await db.listFeedback(MEM_PARTICIPANT, MEM_EVENT);
    assert.deepEqual(all.map((row) => row.photoId).sort(), [...ids].sort());
  });

  it("returns only the verdicts of the given photo ids", async () => {
    const db = await memoryDb();
    const ids = await seedMemoryFeedback(db, 5);
    const wanted = [ids[1] as string, ids[3] as string];
    const scoped = await db.listFeedback(MEM_PARTICIPANT, MEM_EVENT, wanted);
    assert.deepEqual(scoped.map((row) => row.photoId).sort(), [...wanted].sort());
  });

  it("answers an empty id list with no rows", async () => {
    const db = await memoryDb();
    await seedMemoryFeedback(db, 3);
    assert.deepEqual(await db.listFeedback(MEM_PARTICIPANT, MEM_EVENT, []), []);
  });

  it("ignores ids with no verdict", async () => {
    const db = await memoryDb();
    await seedMemoryFeedback(db, 2);
    assert.deepEqual(await db.listFeedback(MEM_PARTICIPANT, MEM_EVENT, [randomUUID()]), []);
  });
});

// ------------------------------------------------------------------ postgres

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Requires migration 014 to be applied, not just a reachable database: a developer whose local
 * database is still on 013 must get a skip with the reason, not four failures telling them
 * nothing. Only a schema that can actually satisfy the assertions runs them.
 */
async function databaseReady(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!DATABASE_URL) return { ok: false, reason: "DATABASE_URL is not set" };
  const sql = createSql(DATABASE_URL, { max: 1 });
  try {
    const tables = await sql<{ name: string | null }[]>`select to_regclass('public.photos') as name`;
    if (!tables[0]?.name) {
      return { ok: false, reason: "DATABASE_URL has no `photos` table — this suite then vanishes from the totals "
          + "instead of being counted as skipped, so the run reads green while 13 tests "
          + "are missing. Fix: DATABASE_URL=<url> node --import tsx packages/db/src/migrate.ts "
          + "(not `pnpm db:migrate`, which hardcodes --env-file=.env)" };
    }
    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where indexname in ('photos_event_created_ms_idx',
                          'upload_sessions_photographer_created_ms_idx',
                          'match_runs_event_created_ms_idx',
                          'galleries_event_matched_ms_idx')
    `;
    if (indexes.length < 4) {
      return {
        ok: false,
        reason:
          `DATABASE_URL is missing migration 014 (${indexes.length}/4 keyset indexes present): ` +
          "run `npm run db:migrate`",
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `DATABASE_URL unreachable: ${(error as Error).message}` };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const probe = await databaseReady();
const skip = probe.ok ? false : probe.reason;

/** `MS_SLOTS` distinct milliseconds, `PHOTOS_PER_MS` rows inside each at distinct microseconds. */
const MS_SLOTS = 40;
const PHOTOS_PER_MS = 5;
const TOTAL_ROWS = MS_SLOTS * PHOTOS_PER_MS;
const BASE = "2026-06-01 09:00:00+00";
const MAX_UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

describe("keyset pagination over colliding milliseconds (v6 F3)", { skip }, () => {
  const eventId = randomUUID();
  const photographerId = randomUUID();
  let client: Sql;
  let db: PostgresDatabase;

  before(async () => {
    client = createSql(DATABASE_URL as string, { max: 2 });
    db = new PostgresDatabase(client);
    await client`
      insert into events (id, slug, name)
      values (${eventId}, ${`pagination-${eventId}`}, 'Pagination test')
    `;
    await client`
      insert into users (id, email, role)
      values (${photographerId}, ${`pagination-${photographerId}@test.local`}, 'photographer')
    `;
    await client`
      insert into event_photographers (event_id, user_id) values (${eventId}, ${photographerId})
    `;
    // created_at = BASE + slot ms + offset µs. Every millisecond holds PHOTOS_PER_MS rows, so a
    // page boundary at any limit that is not a multiple of PHOTOS_PER_MS lands inside a group.
    await client`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key,
                          content_type, bytes, created_at, filename)
      -- album_id is not null since migration 009; every event gets its official album from
      -- the events_default_album trigger, which is where these fixture rows belong.
      select ${eventId},
             (select id from albums where event_id = ${eventId} and slug = 'ufficiale'),
             ${photographerId},
             encode(sha256((${eventId} || i)::bytea), 'hex'), 'indexed',
             'originals/' || ${eventId} || '/' || i, 'image/jpeg', 1000,
             ${BASE}::timestamptz
               + ((i / ${PHOTOS_PER_MS}) * interval '1 millisecond')
               + ((i % ${PHOTOS_PER_MS}) * interval '137 microseconds'),
             'IMG_' || lpad(i::text, 5, '0') || '.jpg'
      from generate_series(0, ${TOTAL_ROWS - 1}) i
    `;
    await client`
      insert into upload_sessions (event_id, photographer_id, object_key, sha256, content_type,
                                   status, created_at, stage)
      select ${eventId}, ${photographerId}, 'originals/' || ${eventId} || '/u' || i,
             encode(sha256((${eventId} || 'u' || i)::bytea), 'hex'), 'image/jpeg', 'completed',
             ${BASE}::timestamptz
               + ((i / ${PHOTOS_PER_MS}) * interval '1 millisecond')
               + ((i % ${PHOTOS_PER_MS}) * interval '211 microseconds'),
             'original'
      from generate_series(0, ${TOTAL_ROWS - 1}) i
    `;
    await client`analyze photos`;
    await client`analyze upload_sessions`;
  });

  after(async () => {
    // Deleting the event cascades to photos, upload_sessions and event_photographers.
    await client`delete from events where id = ${eventId}`;
    await client`delete from users where id = ${photographerId}`;
    await client.end({ timeout: 2 });
  });

  it("the fixture really does share milliseconds", async () => {
    const rows = await client<{ max: number }[]>`
      select max(c)::int as max from (
        select count(*) as c from photos where event_id = ${eventId}
        group by date_trunc('milliseconds', created_at, 'UTC')
      ) s
    `;
    assert.equal(rows[0]?.max, PHOTOS_PER_MS);
  });

  // Limits coprime with PHOTOS_PER_MS put most page boundaries inside a millisecond group.
  for (const limit of [1, 3, 7, 13]) {
    it(`listPhotosAdmin walks all ${TOTAL_ROWS} rows exactly once with limit ${limit}`, async () => {
      const seen: string[] = [];
      let cursor: UploadCursor | undefined;
      for (let page = 0; page <= Math.ceil(TOTAL_ROWS / limit) + 1; page += 1) {
        const result = await db.listPhotosAdmin({ eventId }, { limit, ...(cursor ? { cursor } : {}) });
        for (const row of result.items) seen.push(row.id);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      assert.equal(new Set(seen).size, seen.length, "a photo was returned on two pages");
      assert.equal(seen.length, TOTAL_ROWS, "the walk did not reach every photo");
      const ordered = await client<{ id: string }[]>`
        select id from photos where event_id = ${eventId}
        order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc
      `;
      assert.deepEqual(seen, ordered.map((row) => row.id), "the pages are not in the declared order");
    });

    it(`listUploadSessionsPage walks all ${TOTAL_ROWS} rows exactly once with limit ${limit}`, async () => {
      const seen: string[] = [];
      let cursor: UploadCursor | undefined;
      for (let page = 0; page <= Math.ceil(TOTAL_ROWS / limit) + 1; page += 1) {
        const result = await db.listUploadSessionsPage(photographerId, eventId, {
          limit,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of result.items) seen.push(row.id);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      assert.equal(new Set(seen).size, seen.length, "an upload session was returned on two pages");
      assert.equal(seen.length, TOTAL_ROWS, "the walk did not reach every upload session");
    });
  }

  it("a cursor page of listPhotosAdmin is served by the 014 index without a sort", async () => {
    const plan = await explain(
      client,
      `select id from photos
         where event_id = $1
           and (date_trunc('milliseconds', created_at, 'UTC'), id)
               < ($2::timestamptz + interval '20 milliseconds', $3::uuid)
         order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc
         limit 13`,
      [eventId, BASE, MAX_UUID],
    );
    assert.match(plan, /Index Scan using photos_event_created_ms_idx/, plan);
    assert.doesNotMatch(plan, /\bSort\b/, plan);
    assert.doesNotMatch(plan, /Seq Scan on photos/, plan);
  });

  it("a cursor page of listUploadSessionsPage is served by its 014 index without a sort", async () => {
    const plan = await explain(
      client,
      `select id from upload_sessions
         where photographer_id = $1 and event_id = $2
           and (date_trunc('milliseconds', created_at, 'UTC'), id)
               < ($3::timestamptz + interval '20 milliseconds', $4::uuid)
         order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc
         limit 13`,
      [photographerId, eventId, BASE, MAX_UUID],
    );
    assert.match(plan, /Index Scan using upload_sessions_photographer_created_ms_idx/, plan);
    assert.doesNotMatch(plan, /\bSort\b/, plan);
  });

  it("migration 014 created the four expression indexes", async () => {
    const rows = await client<{ indexname: string }[]>`
      select indexname from pg_indexes
      where indexname in ('photos_event_created_ms_idx',
                          'upload_sessions_photographer_created_ms_idx',
                          'match_runs_event_created_ms_idx',
                          'galleries_event_matched_ms_idx')
      order by indexname
    `;
    assert.deepEqual(rows.map((row) => row.indexname), [
      "galleries_event_matched_ms_idx",
      "match_runs_event_created_ms_idx",
      "photos_event_created_ms_idx",
      "upload_sessions_photographer_created_ms_idx",
    ]);
  });

  it("listFeedback restricted to a page reads only those photos (v6 F4)", async () => {
    const participantId = randomUUID();
    await client`
      insert into users (id, email, role)
      values (${participantId}, ${`pagination-${participantId}@test.local`}, 'participant')
    `;
    const photos = await client<{ id: string }[]>`
      select id from photos where event_id = ${eventId} order by created_at limit 4
    `;
    for (const photo of photos) {
      await client`
        insert into gallery_feedback (user_id, event_id, photo_id, verdict)
        values (${participantId}, ${eventId}, ${photo.id}, 'not_me')
      `;
    }
    const ids = photos.map((row) => row.id);
    assert.equal((await db.listFeedback(participantId, eventId)).length, 4);
    const wanted = [ids[0] as string, ids[2] as string];
    const scoped = await db.listFeedback(participantId, eventId, wanted);
    assert.deepEqual(scoped.map((row) => row.photoId).sort(), [...wanted].sort());
    assert.deepEqual(await db.listFeedback(participantId, eventId, []), []);
    await client`delete from users where id = ${participantId}`;
  });
});

/** `explain (analyze)` of a parameterised statement, flattened to one string. */
async function explain(client: Sql, text: string, params: unknown[]): Promise<string> {
  const rows = await client.unsafe<{ "QUERY PLAN": string }[]>(
    `explain (analyze, costs off, timing off, summary off) ${text}`,
    params as never[],
  );
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}
