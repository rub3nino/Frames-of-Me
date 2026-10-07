/**
 * v6 C1 (agent C): migration 010 against a real Postgres that already holds v5 data,
 * including personal match galleries. Proves what only the database can prove:
 *
 * - `moderation_state` is a column SEPARATE from `photos.status`, with its own check
 *   constraint and its own default (`approved`, i.e. post-moderation);
 * - `reports unique (photo_id, reporter_id)` is what makes the auto-pending threshold a
 *   count of distinct people, and the `on conflict ... where` that lets a stored `not_me` be
 *   escalated to a counting reason, one-way;
 * - only the moderation-relevant reasons count: `not_me` is recorded and shown but never
 *   moves a photo, because it is the normal error mode of face matching;
 * - `upload_sessions.album_id` exists and the pre-010 rows are backfilled to the official
 *   album, so `complete` always knows where the photo belongs;
 * - a human ruling stamps `moderated_by` / `moderated_at` while the automatic paths (the
 *   screening hook, the report threshold) leave both empty;
 * - the audit row a ruling writes is really in `audit_log`;
 * - the personal galleries (`galleries`, `gallery_items`) come out byte-for-byte unchanged
 *   and keep working (section G, hard rule).
 *
 * It also pins the migration-order constraint of this wave: on a database that already ran
 * wave 1, migration 010 is applied AFTER 011, 012 and 014 (the runner tracks applied files
 * by name), so 010 must depend only on 001-009. The test applies 001-009 and then 010 ALONE,
 * which is the strictest version of that: if 010 touched anything from 011+ it would fail
 * here.
 *
 * It runs only with `TEST_DATABASE_URL` set, in a scratch database of its own:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55481/rephoto \
 *     node --import tsx --test packages/db/src/moderation.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_moderation_test";
/** Everything migration 010 is allowed to depend on. */
const BASE_MIGRATIONS = [
  "001_init.sql",
  "002_scale.sql",
  "003_v2.sql",
  "004_two_stage.sql",
  "005_face_vectors.sql",
  "006_recognition.sql",
  "007_test_tooling.sql",
  "008_staff_passwords.sql",
  "009_albums.sql",
];
const MODERATION_MIGRATION = "010_moderation.sql";

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  albumId: string;
  participantId: string;
  otherParticipantId: string;
  moderatorId: string;
  photographerId: string;
  photoId: string;
  secondPhotoId: string;
  sessionId: string;
  galleries: unknown[];
  galleryItems: unknown[];
  galleryColumns: string[];
};

let fixture: Fixture | undefined;
let skipReason: string | undefined;
let adminSql: Sql | undefined;

function scratchUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

async function readMigration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function apply(sql: Sql, names: readonly string[]): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  for (const name of names) {
    await sql.unsafe(await readMigration(name));
    await sql`insert into schema_migrations (id) values (${name})`;
  }
}

/** A database at 001-009 with realistic rows, including a personal gallery. */
async function seedBase(sql: Sql): Promise<Omit<Fixture, "sql" | "db" | "galleries" | "galleryItems" | "galleryColumns">> {
  await apply(sql, BASE_MIGRATIONS);

  const [event] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('mod-event', 'Evento') returning id
  `;
  const [participant] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('guest@example.com', 'participant') returning id
  `;
  const [other] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('altro@example.com', 'participant') returning id
  `;
  const [moderator] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('mod@example.com', 'admin') returning id
  `;
  const [photographer] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('shooter@example.com', 'photographer') returning id
  `;
  assert.ok(event && participant && other && moderator && photographer);
  const [album] = await sql<{ id: string }[]>`
    select id from albums where event_id = ${event.id} and slug = 'ufficiale'
  `;
  assert.ok(album, "migration 009 backfills the official album");

  const photos: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const [photo] = await sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key,
                          content_type, bytes)
      values (
        ${event.id}, ${album.id}, ${photographer.id},
        ${String(index + 1).repeat(64).slice(0, 64)}, 'indexed',
        ${`originals/${event.id}/${index}`}, 'image/jpeg', 1000
      )
      returning id
    `;
    assert.ok(photo);
    photos.push(photo.id);
    await sql`
      insert into derivatives (photo_id, kind, s3_key)
      values (${photo.id}, 'thumb', ${`thumbs/${photo.id}.jpg`}),
             (${photo.id}, 'web', ${`web/${photo.id}.jpg`})
    `;
  }
  const photoId = photos[0];
  const secondPhotoId = photos[1];
  assert.ok(photoId && secondPhotoId);

  // A session written BEFORE migration 010: it has no album of its own and must be
  // backfilled to the official album.
  const [session] = await sql<{ id: string }[]>`
    insert into upload_sessions (event_id, photographer_id, object_key, sha256, content_type,
                                 status, stage, bytes)
    values (${event.id}, ${photographer.id}, ${`originals/${event.id}/pre-010`},
            ${"a".repeat(64)}, 'image/jpeg', 'completed', 'original', 1000)
    returning id
  `;
  assert.ok(session);

  const [face] = await sql<{ id: string }[]>`
    insert into faces (photo_id, event_id, external_id, bbox, confidence)
    values (${photoId}, ${event.id}, 'ext-1', ${sql.json({ x: 0, y: 0, width: 1, height: 1 })}, 0.99)
    returning id
  `;
  assert.ok(face);
  const [gallery] = await sql<{ id: string }[]>`
    insert into galleries (user_id, event_id, anchor_face_ids, matched_at)
    values (${participant.id}, ${event.id}, ${["ext-1"]}, now())
    returning id
  `;
  assert.ok(gallery);
  await sql`
    insert into gallery_items (gallery_id, photo_id, face_id, score, source)
    values (${gallery.id}, ${photoId}, ${face.id}, 0.93, 'match')
  `;

  return {
    eventId: event.id,
    albumId: album.id,
    participantId: participant.id,
    otherParticipantId: other.id,
    moderatorId: moderator.id,
    photographerId: photographer.id,
    photoId,
    secondPhotoId,
    sessionId: session.id,
  };
}

before(async () => {
  if (!ADMIN_URL) {
    skipReason = "TEST_DATABASE_URL is not set";
    return;
  }
  adminSql = createSql(ADMIN_URL, { max: 1 });
  try {
    await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    await adminSql.unsafe(`create database ${SCRATCH_DATABASE}`);
  } catch (error) {
    skipReason = `TEST_DATABASE_URL unusable: ${(error as Error).message}`;
    return;
  }
  const sql = createSql(scratchUrl(ADMIN_URL), { max: 2 });
  const seeded = await seedBase(sql);
  const galleryColumns = (
    await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'galleries'
      order by column_name
    `
  ).map((row) => row.column_name);
  const galleries = await sql`select * from galleries order by id`;
  const galleryItems = await sql`select * from gallery_items order by id`;
  // Migration 010 ALONE on 001-009: nothing from 011+ is present while it runs.
  await apply(sql, [MODERATION_MIGRATION]);
  fixture = {
    sql,
    db: new PostgresDatabase(sql),
    ...seeded,
    galleries: [...galleries],
    galleryItems: [...galleryItems],
    galleryColumns,
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

describe("migration 010 on a database at 001-009", () => {
  it("leaves the personal match galleries exactly as they were", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const columns = (
      await f.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'galleries'
        order by column_name
      `
    ).map((row) => row.column_name);
    assert.deepEqual(columns, f.galleryColumns, "no column added to or removed from galleries");
    assert.equal(columns.includes("moderation_state"), false, "moderation is on photos, not galleries");
    assert.deepEqual([...(await f.sql`select * from galleries order by id`)], f.galleries);
    assert.deepEqual([...(await f.sql`select * from gallery_items order by id`)], f.galleryItems);
    // And it still works.
    const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.photoId, f.photoId);
  });

  it("adds moderation_state as a column separate from photos.status", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const rows = await f.sql<{ status: string; moderation_state: string }[]>`
      select status, moderation_state from photos where id = ${f.photoId}
    `;
    // Post-moderation (the frozen default): every existing photo is approved on arrival.
    assert.equal(rows[0]?.moderation_state, "approved");
    // And the processing pipeline is untouched: two independent state machines.
    assert.equal(rows[0]?.status, "indexed");

    const columns = (
      await f.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'photos'
          and column_name in ('status', 'moderation_state', 'moderated_by', 'moderated_at')
        order by column_name
      `
    ).map((row) => row.column_name);
    assert.deepEqual(columns, ["moderated_at", "moderated_by", "moderation_state", "status"]);
  });

  it("refuses a moderation_state outside the four of the state machine", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await assert.rejects(
      () => f.sql`update photos set moderation_state = 'maybe' where id = ${f.photoId}`,
      /moderation_state/,
    );
    // And it is not interchangeable with a `photos.status` value either.
    await assert.rejects(
      () => f.sql`update photos set moderation_state = 'indexed' where id = ${f.photoId}`,
      /moderation_state/,
    );
  });

  it("has a partial index for the queue, on (album_id, moderation_state)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const rows = await f.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'photos' and indexname = 'photos_moderation_idx'
    `;
    const definition = rows[0]?.indexdef ?? "";
    assert.match(definition, /album_id/);
    assert.match(definition, /moderation_state/);
    assert.match(definition, /WHERE \(moderation_state <> 'approved'/i);
  });

  it("allows one report per person per photo, and counts distinct people", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const first = await f.db.insertReport({
      photoId: f.secondPhotoId,
      reporterId: f.participantId,
      reason: "inappropriate",
      note: "non va bene",
    });
    assert.equal(first.created, true);
    // A second report from the SAME person is not a new row and not an error.
    const again = await f.db.insertReport({
      photoId: f.secondPhotoId,
      reporterId: f.participantId,
      reason: "other",
    });
    assert.equal(again.created, false);
    assert.equal(again.report.id, first.report.id);
    assert.equal(again.report.reason, "inappropriate", "the first reason is kept");
    assert.equal(await f.db.countOpenReports(f.secondPhotoId), 1);

    const second = await f.db.insertReport({
      photoId: f.secondPhotoId,
      reporterId: f.otherParticipantId,
      reason: "copyright",
    });
    assert.equal(second.created, true);
    assert.equal(await f.db.countOpenReports(f.secondPhotoId), 2);

    // The raw constraint, not only the typed path.
    await assert.rejects(
      () => f.sql`
        insert into reports (photo_id, reporter_id, reason)
        values (${f.secondPhotoId}, ${f.participantId}, 'other')
      `,
      /duplicate key|reports_photo_id_reporter_id_key/,
    );
    await assert.rejects(
      () => f.sql`
        insert into reports (photo_id, reporter_id, reason)
        values (${f.photoId}, ${f.participantId}, 'nonsense')
      `,
      /reason/,
    );

    // Closing settles them.
    assert.equal(await f.db.closeReports(f.secondPhotoId), 2);
    assert.equal(await f.db.countOpenReports(f.secondPhotoId), 0);
  });

  it("counts only the moderation-relevant reasons: not_me is recorded, never counted", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // Proving this against the real SQL matters: `countOpenReports` filters on
    // `reason = any(MODERATION_COUNTING_REASONS)` and `listModerationPage` uses
    // `count(...) filter (where ...)`. `not_me` is the recognition system's normal error
    // mode, so counting it would turn wrong matches into global takedowns.
    const [photo] = await f.sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key,
                          content_type, bytes)
      values (${f.eventId}, ${f.albumId}, ${f.photographerId}, ${"e".repeat(64)}, 'indexed',
              ${`originals/${f.eventId}/not-me`}, 'image/jpeg', 10)
      returning id
    `;
    assert.ok(photo);

    await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "not_me",
    });
    await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.otherParticipantId,
      reason: "not_me",
    });
    assert.equal(await f.db.countOpenReports(photo.id), 0, "two not_me reports count as zero");
    assert.equal(await f.db.countOpenNotMeReports(photo.id), 2);
    // Both rows really are there: recorded, so a moderator can ask for them.
    assert.equal((await f.db.listOpenReports(photo.id)).length, 2);

    // By default the queue leaves it alone; `includeNotMe` asks for it.
    const quiet = await f.db.listModerationPage({ albumId: f.albumId, limit: 20 });
    assert.equal(
      quiet.items.some((row) => row.photoId === photo.id),
      false,
    );
    const asked = await f.db.listModerationPage({
      albumId: f.albumId,
      includeNotMe: true,
      limit: 20,
    });
    const item = asked.items.find((row) => row.photoId === photo.id);
    assert.ok(item);
    assert.equal(item.openReports, 0);
    assert.equal(item.notMeReports, 2);
    assert.deepEqual(item.reasons, ["not_me"]);

    // A counting reason from a third person does count, and queues it without being asked.
    await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.moderatorId,
      reason: "inappropriate",
    });
    assert.equal(await f.db.countOpenReports(photo.id), 1);
    const queued = await f.db.listModerationPage({ albumId: f.albumId, limit: 20 });
    const now = queued.items.find((row) => row.photoId === photo.id);
    assert.ok(now);
    assert.equal(now.openReports, 1);
    assert.equal(now.notMeReports, 2);
    assert.deepEqual(now.reasons, ["inappropriate", "not_me"]);
  });

  it("escalates a stored not_me to a counting reason, one-way", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // The `on conflict (photo_id, reporter_id) do update ... where reports.reason = 'not_me'`
    // clause: tapping "non sono io" must not silently spend the person's only report on the
    // photo, and the escalation must never run backwards.
    const [photo] = await f.sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key,
                          content_type, bytes)
      values (${f.eventId}, ${f.albumId}, ${f.photographerId}, ${"f".repeat(64)}, 'indexed',
              ${`originals/${f.eventId}/escalate`}, 'image/jpeg', 10)
      returning id
    `;
    assert.ok(photo);

    const wrongMatch = await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "not_me",
    });
    assert.equal(wrongMatch.created, true);
    assert.equal(await f.db.countOpenReports(photo.id), 0);

    const escalated = await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "inappropriate",
      note: "ripensandoci",
    });
    assert.equal(escalated.created, true, "an escalation is a new report, not a repeat");
    assert.equal(escalated.report.id, wrongMatch.report.id, "escalated in place, one row");
    assert.equal(escalated.report.reason, "inappropriate");
    assert.equal(escalated.report.note, "ripensandoci");
    assert.equal(await f.db.countOpenReports(photo.id), 1);
    assert.equal(await f.db.countOpenNotMeReports(photo.id), 0);
    assert.equal((await f.db.listOpenReports(photo.id)).length, 1);

    // One-way: neither another counting reason nor `not_me` may overwrite it, so this is not
    // a way to un-report a photo.
    const sideways = await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "copyright",
    });
    assert.equal(sideways.created, false);
    assert.equal(sideways.report.reason, "inappropriate");
    const backwards = await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "not_me",
    });
    assert.equal(backwards.created, false);
    assert.equal(backwards.report.reason, "inappropriate");
    assert.equal(await f.db.countOpenReports(photo.id), 1);
  });

  it("stamps moderated_by/at for a human ruling and leaves them for the automatic path", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // The automatic path (screening hook, report threshold): the state moves, the two audit
    // columns stay empty, so the queue still reads "nobody has ruled".
    await f.db.setPhotoModeration({ photoId: f.photoId, state: "pending" });
    let row = (
      await f.sql<{ moderation_state: string; moderated_by: string | null; moderated_at: Date | null }[]>`
        select moderation_state, moderated_by, moderated_at from photos where id = ${f.photoId}
      `
    )[0];
    assert.equal(row?.moderation_state, "pending");
    assert.equal(row?.moderated_by, null);
    assert.equal(row?.moderated_at, null);

    // A human ruling stamps both.
    await f.db.setPhotoModeration({
      photoId: f.photoId,
      state: "approved",
      moderatorId: f.moderatorId,
    });
    row = (
      await f.sql<{ moderation_state: string; moderated_by: string | null; moderated_at: Date | null }[]>`
        select moderation_state, moderated_by, moderated_at from photos where id = ${f.photoId}
      `
    )[0];
    assert.equal(row?.moderation_state, "approved");
    assert.equal(row?.moderated_by, f.moderatorId);
    assert.ok(row?.moderated_at instanceof Date);

    // The audit row of a ruling really lands in audit_log.
    await f.db.insertAudit({
      actorId: f.moderatorId,
      action: "moderation.approved",
      target: `photo:${f.photoId}`,
      meta: { albumId: f.albumId, from: "pending", closedReports: 0 },
    });
    const audits = await f.sql<{ action: string; target: string; actor_id: string; meta: unknown }[]>`
      select action, target, actor_id, meta from audit_log
      where target = ${`photo:${f.photoId}`} order by created_at
    `;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, "moderation.approved");
    assert.equal(audits[0]?.actor_id, f.moderatorId);
    // `meta` comes back as the raw jsonb text on this driver configuration.
    const meta = audits[0]?.meta;
    const parsed = (typeof meta === "string" ? JSON.parse(meta) : meta) as Record<string, unknown>;
    assert.equal(parsed.albumId, f.albumId);
    assert.equal(parsed.from, "pending");
  });

  it("withholds a non-approved photo from the personal gallery, then gives it back", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    assert.equal((await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 })).total, 1);
    await f.db.setPhotoModeration({ photoId: f.photoId, state: "pending" });
    const during = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
    assert.equal(during.total, 0);
    assert.equal(during.items.length, 0);
    // The gallery row and its item never moved: only the view changed.
    assert.deepEqual([...(await f.sql`select * from gallery_items order by id`)], f.galleryItems);
    await f.db.setPhotoModeration({
      photoId: f.photoId,
      state: "approved",
      moderatorId: f.moderatorId,
    });
    assert.equal((await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 })).total, 1);
  });

  it("deleting a photo cascades its reports", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const [photo] = await f.sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key,
                          content_type, bytes)
      values (${f.eventId}, ${f.albumId}, ${f.photographerId}, ${"c".repeat(64)}, 'uploaded',
              ${`originals/${f.eventId}/cascade`}, 'image/jpeg', 10)
      returning id
    `;
    assert.ok(photo);
    await f.db.insertReport({
      photoId: photo.id,
      reporterId: f.participantId,
      reason: "inappropriate",
    });
    await f.db.deletePhoto(photo.id);
    const left = await f.sql<{ count: number }[]>`
      select count(*)::int as count from reports where photo_id = ${photo.id}
    `;
    assert.equal(left[0]?.count, 0);
  });

  it("gives upload_sessions an album_id and backfills the pre-010 rows", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const session = await f.db.findUploadSession(f.sessionId);
    assert.equal(session?.albumId, f.albumId, "backfilled to the event's official album");

    // A new session without an explicit album resolves to the official album too, so the
    // album is never null by the time `complete` reads it.
    const id = crypto.randomUUID();
    await f.db.insertUploadSession({
      id,
      eventId: f.eventId,
      photographerId: f.photographerId,
      s3UploadId: null,
      objectKey: `originals/${f.eventId}/${id}`,
      sha256: "d".repeat(64),
      contentType: "image/jpeg",
      bytes: 10,
    });
    assert.equal((await f.db.findUploadSession(id))?.albumId, f.albumId);
  });

  it("records itself and nothing from 011+ is needed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const applied = (
      await f.sql<{ id: string }[]>`select id from schema_migrations order by id`
    ).map((row) => row.id);
    assert.deepEqual(applied, [...BASE_MIGRATIONS, MODERATION_MIGRATION]);
    // 011 has not run here, and the whole suite above passed: 010 depends only on 001-009.
    assert.equal(applied.includes("011_vectors_per_album.sql"), false);
  });

  it("the full runner then applies the rest, in the order a wave-1 database sees", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // 011/012/014 on top of 010: the same final schema as a fresh database, whatever order
    // the files were applied in.
    await migrate(f.sql);
    const applied = (
      await f.sql<{ id: string }[]>`select id from schema_migrations order by id`
    ).map((row) => row.id);
    assert.ok(applied.includes("012_auth_identities.sql"));
    assert.ok(applied.includes("014_keyset_indexes.sql"));
    // Still approved, still separate from `status`, still one gallery item.
    const rows = await f.sql<{ moderation_state: string }[]>`
      select moderation_state from photos where id = ${f.photoId}
    `;
    assert.equal(rows[0]?.moderation_state, "approved");
    assert.deepEqual([...(await f.sql`select * from gallery_items order by id`)], f.galleryItems);
  });
});
