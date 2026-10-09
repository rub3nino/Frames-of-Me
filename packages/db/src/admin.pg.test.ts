/**
 * v6 D (agent D): migration 017 and the admin console's Postgres reads, against a real
 * server. These are the parts `MemoryDatabase` cannot prove:
 *
 *  - `album_photographers` exists, cascades with the album and narrows nothing by default;
 *  - `listEventCodes` / `updateEventCode` are real SQL that runs, including clearing a
 *    nullable field (where `coalesce` would silently keep the old value);
 *  - revoking a code (`expires_at = now()`) is refused by agent B's `claimEventCode` in the
 *    same statement that would have incremented `uses`;
 *  - `eventStatus` counts the right event and the right album;
 *  - the personal match galleries (`galleries`, `gallery_items`) are untouched by 017.
 *
 * It runs only with `TEST_DATABASE_URL` set, in a scratch database of its own:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55482/rephoto \
 *     node --import tsx --test packages/db/src/admin.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_admin_test";

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  otherEventId: string;
  albumId: string;
  otherAlbumId: string;
  photographerId: string;
  secondPhotographerId: string;
  participantId: string;
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
  await migrate(sql);
  const db = new PostgresDatabase(sql);

  const event = await db.createEvent({ slug: "admin-event", name: "Evento" });
  const other = await db.createEvent({ slug: "admin-altro", name: "Altro" });
  const photographer = await db.insertUser("uno@studio.it", "photographer");
  const second = await db.insertUser("due@studio.it", "photographer");
  const participant = await db.insertUser("ospite@example.com", "participant");
  await db.addEventPhotographer(event.id, photographer.id);
  await db.addEventPhotographer(event.id, second.id);

  const album = await db.findDefaultAlbum(event.id);
  assert.ok(album, "migration 009 gives every event its official album");
  const crowd = await db.createAlbum({
    eventId: event.id,
    slug: "tutti",
    name: "Album di tutti",
    kind: "crowd",
  });

  // A photo in each album, and a personal match gallery, so the counters and the
  // "untouched galleries" check have something to look at.
  await db.insertPhoto({
    id: "11111111-1111-4111-8111-111111111111",
    eventId: event.id,
    photographerId: photographer.id,
    sha256: "a".repeat(64),
    originalKey: `originals/${event.id}/a`,
    contentType: "image/jpeg",
    bytes: 1000,
    albumId: album.id,
  });
  await db.insertPhoto({
    id: "22222222-2222-4222-8222-222222222222",
    eventId: event.id,
    photographerId: photographer.id,
    sha256: "b".repeat(64),
    originalKey: `originals/${event.id}/b`,
    contentType: "image/jpeg",
    bytes: 1000,
    albumId: crowd.id,
  });
  await sql`
    insert into galleries (user_id, event_id, anchor_face_ids, matched_at)
    values (${participant.id}, ${event.id}, ${["ext-1"]}, now())
  `;

  fixture = {
    sql,
    db,
    eventId: event.id,
    otherEventId: other.id,
    albumId: album.id,
    otherAlbumId: crowd.id,
    photographerId: photographer.id,
    secondPhotographerId: second.id,
    participantId: participant.id,
    galleries: [...(await sql`select * from galleries order by id`)],
    galleryItems: [...(await sql`select * from gallery_items order by id`)],
  };
});

after(async () => {
  if (fixture) await fixture.sql.end({ timeout: 5 });
  if (adminSql) {
    try {
      await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    } catch {
      // Leave the scratch database behind rather than failing the run.
    }
    await adminSql.end({ timeout: 5 });
  }
});

function required(): Fixture {
  assert.ok(fixture, skipReason ?? "fixture missing");
  return fixture;
}

describe("migration 017 — album_photographers", () => {
  it("is applied and recorded", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const applied = await f.sql<{ id: string }[]>`
      select id from schema_migrations where id = '017_album_photographers.sql'
    `;
    assert.equal(applied.length, 1);
    const columns = (
      await f.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'album_photographers'
        order by column_name
      `
    ).map((row) => row.column_name);
    assert.deepEqual(columns, ["album_id", "created_at", "user_id"]);
  });

  it("leaves the personal match galleries exactly as they were", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    assert.deepEqual([...(await f.sql`select * from galleries order by id`)], f.galleries);
    assert.deepEqual([...(await f.sql`select * from gallery_items order by id`)], f.galleryItems);
  });

  it("narrows nothing until somebody is listed, then only lets them in", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    assert.deepEqual(await f.db.listAlbumPhotographers(f.albumId), []);
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.albumId, f.photographerId), true);
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.albumId, f.secondPhotographerId), true);

    await f.db.addAlbumPhotographer(f.albumId, f.photographerId);
    // Idempotent: the same grant twice is one row, not a unique violation.
    await f.db.addAlbumPhotographer(f.albumId, f.photographerId);
    const listed = await f.db.listAlbumPhotographers(f.albumId);
    assert.deepEqual(
      listed.map((row) => row.email),
      ["uno@studio.it"],
    );
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.albumId, f.photographerId), true);
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.albumId, f.secondPhotographerId), false);
    // Another album of the same event is unaffected.
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.otherAlbumId, f.secondPhotographerId), true);

    assert.equal(await f.db.removeAlbumPhotographer(f.albumId, f.photographerId), true);
    assert.equal(await f.db.removeAlbumPhotographer(f.albumId, f.photographerId), false);
    assert.equal(await f.db.isAlbumPhotographerAllowed(f.albumId, f.secondPhotographerId), true);
  });

  it("cascades when the album goes", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const album = await f.db.createAlbum({
      eventId: f.eventId,
      slug: "usa-e-getta",
      name: "Usa e getta",
      kind: "official",
    });
    await f.db.addAlbumPhotographer(album.id, f.photographerId);
    await f.sql`delete from albums where id = ${album.id}`;
    const left = await f.sql<{ count: number }[]>`
      select count(*)::int as count from album_photographers where album_id = ${album.id}
    `;
    assert.equal(left[0]?.count, 0);
  });
});

describe("event codes, from the console's side", () => {
  it("lists newest first and keeps the uses", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const older = await f.db.createEventCode({ eventId: f.eventId, code: "VECCHIO", label: "primo" });
    await f.sql`
      update event_codes set created_at = now() - interval '1 hour'
      where event_id = ${f.eventId} and code = ${older.code}
    `;
    await f.db.createEventCode({ eventId: f.eventId, code: "NUOVO", maxUses: 2 });
    // A code of another event never shows up in this event's list.
    await f.db.createEventCode({ eventId: f.otherEventId, code: "ALTROEVENTO" });

    const codes = await f.db.listEventCodes(f.eventId);
    assert.deepEqual(
      codes.map((row) => row.code),
      ["NUOVO", "VECCHIO"],
    );
    assert.equal(codes[1]?.label, "primo");
    assert.equal(codes[0]?.maxUses, 2);
  });

  it("clears a nullable field instead of keeping the old value", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.db.createEventCode({
      eventId: f.eventId,
      code: "DAPULIRE",
      label: "etichetta",
      maxUses: 5,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cleared = await f.db.updateEventCode(f.eventId, "DAPULIRE", {
      label: null,
      maxUses: null,
      expiresAt: null,
    });
    assert.ok(cleared);
    assert.equal(cleared.label, null);
    assert.equal(cleared.maxUses, null);
    assert.equal(cleared.expiresAt, null);

    // An untouched field stays: the patch is partial, not a replace.
    const relabelled = await f.db.updateEventCode(f.eventId, "DAPULIRE", { label: "di nuovo" });
    assert.equal(relabelled?.label, "di nuovo");
    assert.equal(relabelled?.maxUses, null);
    assert.equal(await f.db.updateEventCode(f.eventId, "NON-ESISTE", { label: "x" }), null);
    assert.equal(await f.db.revokeEventCode(f.eventId, "NON-ESISTE"), null);
  });

  it("a revoked code is refused by claimEventCode, with its uses preserved", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.db.createEventCode({ eventId: f.eventId, code: "DAREVOCARE" });
    const claimed = await f.db.claimEventCode("DAREVOCARE");
    assert.equal(claimed?.uses, 1);
    const revoked = await f.db.revokeEventCode(f.eventId, "DAREVOCARE");
    assert.equal(revoked?.uses, 1);
    assert.equal(await f.db.claimEventCode("DAREVOCARE"), null);
    const stored = await f.db.findEventCode(f.eventId, "DAREVOCARE");
    assert.equal(stored?.uses, 1, "the row still says one person registered with it");
  });

  it("a code capped at the uses already made is refused too", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.db.createEventCode({ eventId: f.eventId, code: "DACHIUDERE" });
    await f.db.claimEventCode("DACHIUDERE");
    await f.db.updateEventCode(f.eventId, "DACHIUDERE", { maxUses: 1 });
    assert.equal(await f.db.claimEventCode("DACHIUDERE"), null);
  });
});

describe("eventStatus", () => {
  it("counts this event's media, galleries and albums", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const status = await f.db.eventStatus(f.eventId);
    assert.equal(status.photos, 2);
    assert.equal(status.photosByStatus.uploaded, 2);
    assert.equal(status.photosByStatus.indexed, 0);
    assert.equal(status.galleries, 1);
    assert.equal(status.galleriesMatched, 1);
    assert.equal(status.selfiesWaiting, 0, "no selfie vector stored for that gallery");
    const albums = new Map(status.albums.map((album) => [album.slug, album]));
    assert.equal(albums.get("ufficiale")?.photos, 1);
    assert.equal(albums.get("ufficiale")?.recognition, true);
    assert.equal(albums.get("tutti")?.photos, 1);
    assert.equal(albums.get("tutti")?.recognition, false);

    const empty = await f.db.eventStatus(f.otherEventId);
    assert.equal(empty.photos, 0);
    assert.equal(empty.galleries, 0);
    assert.deepEqual(
      empty.albums.map((album) => album.slug),
      ["ufficiale"],
    );
  });
});
