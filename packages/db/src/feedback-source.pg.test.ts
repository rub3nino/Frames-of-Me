/**
 * v6 (integration): migration 018 against a real Postgres, applied LAST on a database that
 * already ran everything else — which is the order the runner (`migrate.ts`) uses, because it
 * tracks applied files by name.
 *
 * What only a database can prove here:
 *
 *   * rows that existed before 018 come out as `source = 'recognition'`, which is exactly
 *     what they were (the gallery feedback route was the only writer), so the
 *     precision/recall numbers computed from the export do not change meaning;
 *   * the `check` constraint refuses any other value — the column cannot drift into a third
 *     meaning the way `verdict` did;
 *   * `source` is `not null`, so a writer that forgets it fails loudly rather than leaving a
 *     row nobody can classify;
 *   * the personal match galleries (`galleries`, `gallery_items`) come out byte-for-byte
 *     unchanged (section G, hard rule).
 *
 * It runs only with `TEST_DATABASE_URL` set, in a scratch database of its own, which it drops
 * and recreates:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55491/rephoto \
 *     node --import tsx --test packages/db/src/feedback-source.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_feedback_source_test";
/** The one file under test; everything else is applied before it. */
const MIGRATION = "018_feedback_source.sql";

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  aliceId: string;
  bobId: string;
  photoId: string;
  secondPhotoId: string;
  /** `galleries` / `gallery_items` as they were before 018 ran. */
  galleries: unknown[];
  galleryItems: unknown[];
};

let fixture: Fixture | undefined;
let skipReason: string | undefined;
let adminSql: Sql | undefined;

function scratchUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

async function applyMigration(sql: Sql, name: string): Promise<void> {
  const text = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await sql.unsafe(text);
  await sql`insert into schema_migrations (id) values (${name})`;
}

function requireFixture(): Fixture {
  assert.ok(fixture, "fixture missing");
  return fixture;
}

before(async () => {
  if (!ADMIN_URL) {
    skipReason = "TEST_DATABASE_URL is not set";
    return;
  }
  adminSql = createSql(ADMIN_URL, { max: 1 });
  try {
    const extension = await adminSql`select 1 from pg_available_extensions where name = 'vector'`;
    if (extension.length === 0) {
      skipReason = "the server has no pgvector extension available";
      return;
    }
    await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    await adminSql.unsafe(`create database ${SCRATCH_DATABASE}`);
  } catch (error) {
    skipReason = `TEST_DATABASE_URL unusable: ${(error as Error).message}`;
    return;
  }
  const sql = createSql(scratchUrl(ADMIN_URL), { max: 2 });
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const dir = new URL("../migrations/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(MIGRATION), `${MIGRATION} is missing`);
  for (const name of names.filter((name) => name !== MIGRATION)) await applyMigration(sql, name);

  // A realistic pre-018 database: an event, two participants, a personal match gallery with
  // items, and two `gallery_feedback` rows written WITHOUT a source column — which is how
  // every row in production was written.
  const [event] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('fb-event', 'Evento feedback') returning id
  `;
  const [alice] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('alice@example.com', 'participant') returning id
  `;
  const [bob] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('bob@example.com', 'participant') returning id
  `;
  const [photographer] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('shooter@example.com', 'photographer') returning id
  `;
  assert.ok(event && alice && bob && photographer);

  const [album] = await sql<{ id: string }[]>`
    select id from albums where event_id = ${event.id} order by created_at, id limit 1
  `;
  assert.ok(album, "migration 009 must have created an official album for the event");

  const photos: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const [photo] = await sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key, content_type, bytes)
      values (
        ${event.id}, ${album.id}, ${photographer.id}, ${String(index + 1).repeat(64).slice(0, 64)}, 'indexed',
        ${`originals/${event.id}/${index}`}, 'image/jpeg', 1000
      )
      returning id
    `;
    assert.ok(photo);
    photos.push(photo.id);
    // `listGalleryPage` only returns photos that have both derivatives.
    await sql`
      insert into derivatives (photo_id, kind, s3_key)
      values (${photo.id}, 'thumb', ${`thumbs/${photo.id}.jpg`}),
             (${photo.id}, 'web', ${`web/${photo.id}.jpg`})
    `;
  }
  const photoId = photos[0];
  const secondPhotoId = photos[1];
  assert.ok(photoId && secondPhotoId);

  const [face] = await sql<{ id: string }[]>`
    insert into faces (photo_id, event_id, external_id, bbox, confidence)
    values (${photoId}, ${event.id}, 'ext-1', ${sql.json({ x: 0, y: 0, width: 1, height: 1 })}, 0.99)
    returning id
  `;
  assert.ok(face);
  const [gallery] = await sql<{ id: string }[]>`
    insert into galleries (user_id, event_id, anchor_face_ids, matched_at)
    values (${alice.id}, ${event.id}, ${["ext-1"]}, now())
    returning id
  `;
  assert.ok(gallery);
  await sql`
    insert into gallery_items (gallery_id, photo_id, face_id, score, source)
    values (${gallery.id}, ${photoId}, ${face.id}, 0.91, 'match')
  `;

  // The pre-018 writes: no `source` column exists yet, so the statement cannot name it.
  await sql`
    insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time)
    values (${alice.id}, ${event.id}, ${photoId}, 'not_me', 0.91),
           (${bob.id}, ${event.id}, ${secondPhotoId}, 'me', 0.80)
  `;

  const galleries = await sql`select * from galleries order by user_id`;
  const galleryItems = await sql`select * from gallery_items order by photo_id`;

  // And now the file under test, last.
  await applyMigration(sql, MIGRATION);

  fixture = {
    sql,
    db: new PostgresDatabase(sql),
    eventId: event.id,
    aliceId: alice.id,
    bobId: bob.id,
    photoId,
    secondPhotoId,
    galleries: [...galleries],
    galleryItems: [...galleryItems],
  };
});

after(async () => {
  if (fixture) await fixture.sql.end({ timeout: 5 });
  if (adminSql) {
    await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    await adminSql.end({ timeout: 5 });
  }
});

describe("migration 018: gallery_feedback.source", () => {
  it("defaults every pre-existing row to 'recognition', keeping its meaning", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const rows = await f.sql<{ photo_id: string; verdict: string; source: string }[]>`
      select photo_id, verdict, source from gallery_feedback where event_id = ${f.eventId}
      order by photo_id
    `;
    assert.equal(rows.length, 2);
    // Both rows were written by the gallery feedback route, the only writer before 018.
    for (const row of rows) assert.equal(row.source, "recognition");
    assert.deepEqual(
      rows.map((row) => row.verdict).sort(),
      ["me", "not_me"],
      "the verdicts themselves are untouched",
    );
  });

  it("is not null, so a writer that forgets the flow fails loudly", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const [column] = await f.sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'gallery_feedback' and column_name = 'source'
    `;
    assert.ok(column);
    assert.equal(column.is_nullable, "NO");
    await assert.rejects(
      f.sql`
        update gallery_feedback set source = null
        where user_id = ${f.aliceId} and event_id = ${f.eventId} and photo_id = ${f.photoId}
      `,
      /null/i,
    );
  });

  it("refuses any value that is not 'recognition' or 'tag'", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    await assert.rejects(
      f.sql`
        update gallery_feedback set source = 'guess'
        where user_id = ${f.aliceId} and event_id = ${f.eventId} and photo_id = ${f.photoId}
      `,
      /gallery_feedback_source_check/,
    );
    // Both legal values are accepted, through the real upsert.
    await f.db.upsertFeedback({
      userId: f.aliceId,
      eventId: f.eventId,
      photoId: f.photoId,
      verdict: "not_me",
      scoreAtTime: 0.91,
      source: "tag",
    });
    const [row] = await f.sql<{ source: string }[]>`
      select source from gallery_feedback
      where user_id = ${f.aliceId} and event_id = ${f.eventId} and photo_id = ${f.photoId}
    `;
    assert.equal(row?.source, "tag");
  });

  it("carries the source through the export, so tuning can filter on it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // Alice's row is 'tag' from the previous test; Bob's is the untouched 'recognition' one.
    const exported: Array<{ photoId: string; verdict: string; source: string }> = [];
    for await (const row of f.db.exportFeedback(f.eventId)) {
      exported.push({ photoId: row.photoId, verdict: row.verdict, source: row.source });
    }
    assert.equal(exported.length, 2);
    const bySource = new Map(exported.map((row) => [row.photoId, row.source]));
    assert.equal(bySource.get(f.photoId), "tag");
    assert.equal(bySource.get(f.secondPhotoId), "recognition");
    // The false-positive count is the 'recognition' + 'not_me' rows alone, and Alice's
    // refused tag is correctly not among them.
    const falsePositives = exported.filter(
      (row) => row.source === "recognition" && row.verdict === "not_me",
    );
    assert.equal(falsePositives.length, 0);
  });

  it("leaves the personal match galleries byte-for-byte unchanged (hard rule)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const galleries = await f.sql`select * from galleries order by user_id`;
    const galleryItems = await f.sql`select * from gallery_items order by photo_id`;
    assert.deepEqual([...galleries], f.galleries);
    assert.deepEqual([...galleryItems], f.galleryItems);
    // And the feature still reads: the gallery page is unaffected by the new column.
    const page = await f.db.listGalleryPage(f.aliceId, f.eventId, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.photoId, f.photoId);
  });
});
