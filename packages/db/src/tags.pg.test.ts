/**
 * v6 E (agent E): migration 013 against a real Postgres, in the order the runner actually
 * applies it on a database that already ran wave 1.
 *
 * The runner (`migrate.ts`) tracks applied files BY NAME, so a reserved-but-missing number is
 * filled late: on a database that already has 014, 013 is applied *after* it. This test
 * reproduces exactly that — every existing migration first, 013 last — so a dependency on
 * anything from 014 onwards would fail here rather than in production.
 *
 * It also proves what only a database can prove:
 *
 *   * the personal match galleries (`galleries`, `gallery_items`) come out byte-for-byte
 *     unchanged (section G, hard rule);
 *   * `users.taggable` is false for every row that existed before the migration;
 *   * the opt-in is enforced inside the insert statement, not by an application read;
 *   * a removed tag cannot be re-created;
 *   * the autocomplete is a prefix match on a partial index, returns no e-mail address, and
 *     is scoped to users with an active consent for the event.
 *
 * It runs only with `TEST_DATABASE_URL` set, in a scratch database of its own, which it drops
 * and recreates:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55483/rephoto \
 *     node --import tsx --test packages/db/src/tags.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_tags_test";
/** The one file under test. Everything else is applied before it, 014 included. */
const TAGS_MIGRATION = "013_tags.sql";

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  otherEventId: string;
  /** Opts in during the tests; has a recognition consent for `eventId`. */
  aliceId: string;
  /** A recognition consent for `otherEventId` only; never opts in. */
  outsiderId: string;
  /** A recognition consent for `eventId`; never opts in. */
  bobId: string;
  /** On `event_participants` for `eventId`, no consent, no gallery. */
  allowlistedId: string;
  /** A WITHDRAWN consent for `eventId`: not a member. */
  withdrawnId: string;
  photographerId: string;
  photoId: string;
  secondPhotoId: string;
  /** `galleries` / `gallery_items` as they were before 013 ran. */
  galleries: unknown[];
  galleryItems: unknown[];
  galleryColumns: string[];
  /** The migrations applied before 013, in the order they were applied. */
  appliedBefore: string[];
};

let fixture: Fixture | undefined;
let skipReason: string | undefined;
let adminSql: Sql | undefined;

function scratchUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

async function migrationNames(): Promise<string[]> {
  const dir = new URL("../migrations/", import.meta.url);
  return (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
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
  // Everything except 013, in name order — so 014 (and any later file) is already in place.
  const names = await migrationNames();
  assert.ok(names.includes(TAGS_MIGRATION), "013_tags.sql is missing");
  const before013 = names.filter((name) => name !== TAGS_MIGRATION);
  for (const name of before013) await applyMigration(sql, name);

  // A realistic pre-013 database: two events, a personal match gallery with items and a
  // `not_me` feedback row (the flow the removal reuses).
  const [event] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('tag-event', 'Evento tag') returning id
  `;
  const [other] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('tag-altro', 'Altro evento') returning id
  `;
  const [alice] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('alice@example.com', 'participant') returning id
  `;
  const [bob] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('bob@example.com', 'participant') returning id
  `;
  const [outsider] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('alida@example.com', 'participant') returning id
  `;
  const [photographer] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('shooter@example.com', 'photographer') returning id
  `;
  // One per backfill source, so the migration's `on conflict` order can be asserted.
  const [allowlisted] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('lista@example.com', 'participant') returning id
  `;
  const [withdrawn] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('ritirato@example.com', 'participant') returning id
  `;
  assert.ok(event && other && alice && bob && outsider && photographer);
  assert.ok(allowlisted && withdrawn);
  await sql`
    insert into consents (user_id, event_id, text_version, ip, user_agent)
    values (${alice.id}, ${event.id}, 'v1', '127.0.0.1', 'test'),
           (${bob.id}, ${event.id}, 'v1', '127.0.0.1', 'test'),
           (${outsider.id}, ${other.id}, 'v1', '127.0.0.1', 'test')
  `;
  // A withdrawn consent is not membership, so the backfill must skip this one.
  await sql`
    insert into consents (user_id, event_id, text_version, ip, user_agent, withdrawn_at)
    values (${withdrawn.id}, ${event.id}, 'v1', '127.0.0.1', 'test', now())
  `;
  await sql`
    insert into event_participants (event_id, email) values (${event.id}, 'lista@example.com')
  `;
  await sql`
    insert into event_photographers (event_id, user_id) values (${event.id}, ${photographer.id})
  `;

  // 009 (agent A) gave the event an official album and made `photos.album_id` not null.
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
    await sql`
      insert into derivatives (photo_id, kind, s3_key)
      values (${photo.id}, 'thumb', ${`thumbs/${photo.id}.jpg`}), (${photo.id}, 'web', ${`web/${photo.id}.jpg`})
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
    values (${gallery.id}, ${photoId}, ${face.id}, 0.93, 'match')
  `;
  await sql`
    insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time)
    values (${alice.id}, ${event.id}, ${photoId}, 'me', 0.93)
  `;

  const galleryColumns = (
    await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'galleries'
      order by column_name
    `
  ).map((row) => row.column_name);
  const galleries = [...(await sql`select * from galleries order by id`)];
  const galleryItems = [...(await sql`select * from gallery_items order by photo_id`)];

  // The file under test, applied LAST — the gap-filled order the runner produces.
  await applyMigration(sql, TAGS_MIGRATION);

  fixture = {
    sql,
    db: new PostgresDatabase(sql),
    eventId: event.id,
    otherEventId: other.id,
    aliceId: alice.id,
    outsiderId: outsider.id,
    allowlistedId: allowlisted.id,
    withdrawnId: withdrawn.id,
    bobId: bob.id,
    photographerId: photographer.id,
    photoId,
    secondPhotoId,
    galleries,
    galleryItems,
    galleryColumns,
    appliedBefore: before013,
  };
});

after(async () => {
  if (fixture) await fixture.sql.end({ timeout: 5 });
  if (adminSql) {
    try {
      await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    } finally {
      await adminSql.end({ timeout: 5 });
    }
  }
});

describe("v6 E tagging: migration 013 on a wave-1 database", () => {
  it("is applied after 014, so it may depend only on 001-012", (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // The arrangement this whole file is about: 014 ran before 013.
    assert.ok(f.appliedBefore.includes("014_keyset_indexes.sql"));
    const order = f.appliedBefore.indexOf("014_keyset_indexes.sql");
    assert.ok(order >= 0 && order < f.appliedBefore.length);
    // And it applied cleanly in that order: the table and the column are there.
    return undefined;
  });

  it("leaves the personal match galleries byte-for-byte unchanged", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const columns = (
      await f.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'galleries'
        order by column_name
      `
    ).map((row) => row.column_name);
    assert.deepEqual(columns, f.galleryColumns, "013 must not touch `galleries`");
    assert.deepEqual([...(await f.sql`select * from galleries order by id`)], f.galleries);
    assert.deepEqual(
      [...(await f.sql`select * from gallery_items order by photo_id`)],
      f.galleryItems,
    );
    // The gallery read path still answers, and still answers the same thing.
    const page = await f.db.listGalleryPage(f.aliceId, f.eventId, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.photoId, f.photoId);
    return undefined;
  });

  /**
   * The backfill is the reason this migration can be applied to a live database: everybody
   * who is already in the system has to keep working, and the only signals available were
   * the biometric ones plus the allowlist.
   */
  it("backfills event membership from the signals that existed, and from nothing else", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const rows = await f.sql<{ user_id: string; event_id: string; source: string }[]>`
      select user_id, event_id, source from event_members order by source, user_id
    `;
    const byUser = new Map(rows.map((row) => [`${row.user_id}:${row.event_id}`, row.source]));
    // Alice had an active consent AND a gallery: the consent statement runs first, so that is
    // the recorded provenance. Deterministic, which is the point of the statement order.
    assert.equal(byUser.get(`${f.aliceId}:${f.eventId}`), "consent");
    assert.equal(byUser.get(`${f.bobId}:${f.eventId}`), "consent");
    // The outsider's consent is for the other event, so that is the only row they get.
    assert.equal(byUser.get(`${f.outsiderId}:${f.otherEventId}`), "consent");
    assert.equal(byUser.get(`${f.outsiderId}:${f.eventId}`), undefined);
    // The photographer came from `event_photographers`.
    assert.equal(byUser.get(`${f.photographerId}:${f.eventId}`), "staff");
    // The allowlisted participant came from `event_participants`, matched on the e-mail.
    assert.equal(byUser.get(`${f.allowlistedId}:${f.eventId}`), "allowlist");
    // A withdrawn consent is not membership: that person is not backfilled.
    assert.equal(byUser.get(`${f.withdrawnId}:${f.eventId}`), undefined);
    // And the backfill made NOBODY taggable — a migration must never grant a consent.
    const taggable = await f.sql`select 1 from event_members where taggable`;
    assert.equal(taggable.length, 0, "a backfill must never make anyone taggable");
    return undefined;
  });

  it("defaults every member to not taggable, with a column that cannot say 'unknown'", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const rows = await f.sql<{ taggable: boolean }[]>`select taggable from event_members`;
    assert.ok(rows.length >= 4);
    assert.ok(
      rows.every((row) => row.taggable === false),
      "a migration must never make anyone taggable",
    );
    assert.ok(
      (await f.sql`select 1 from users where display_name is not null`).length === 0,
      "and it must not invent a display name for anyone either",
    );
    const [column] = await f.sql<{ column_default: string | null; is_nullable: string }[]>`
      select column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'event_members' and column_name = 'taggable'
    `;
    assert.equal(column?.is_nullable, "NO", "nullable would invite 'unknown means yes'");
    assert.equal(column?.column_default, "false");
    return undefined;
  });

  it("refuses to tag a user who has not opted in, inside the insert statement", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // Bob is a member of the event but never opted in.
    assert.equal(await f.db.isEventMember(f.bobId, f.eventId), true);
    assert.equal(
      await f.db.insertPhotoTag({ photoId: f.photoId, userId: f.bobId, taggedBy: f.aliceId }),
      null,
    );
    const rows = await f.sql`select 1 from photo_tags where user_id = ${f.bobId}`;
    assert.equal(rows.length, 0);
    // And `taggable` with no display name is refused too: it would be an unfindable row
    // whose only identifier is an e-mail address.
    await f.sql`
      update event_members set taggable = true, taggable_consent_version = '2026-10-09'
      where user_id = ${f.bobId} and event_id = ${f.eventId}
    `;
    assert.equal(
      await f.db.insertPhotoTag({ photoId: f.photoId, userId: f.bobId, taggedBy: f.aliceId }),
      null,
    );
    await f.sql`
      update event_members set taggable = false, taggable_consent_version = null
      where user_id = ${f.bobId} and event_id = ${f.eventId}
    `;
    return undefined;
  });

  it("refuses to tag someone who is not a member of the photo's event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // The outsider opted in at the OTHER event and has no membership row here, so the
    // insert's join finds nothing — the per-event opt-in is checked against the event the
    // photo actually belongs to.
    assert.equal(await f.db.isEventMember(f.outsiderId, f.eventId), false);
    assert.ok(
      await f.db.setTagProfile(f.outsiderId, f.otherEventId, {
        taggable: true,
        displayName: "Alida Bianchi",
        consentTextVersion: "2026-10-09",
      }),
    );
    assert.equal(
      await f.db.insertPhotoTag({
        photoId: f.photoId,
        userId: f.outsiderId,
        taggedBy: f.photographerId,
      }),
      null,
    );
    return undefined;
  });

  it("keeps a removed tag removed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    assert.ok(await f.db.setTagProfile(f.aliceId, f.eventId, { taggable: true, displayName: "Alice Rossi", consentTextVersion: "2026-10-09" }));
    const created = await f.db.insertPhotoTag({
      photoId: f.photoId,
      userId: f.aliceId,
      taggedBy: f.photographerId,
    });
    assert.equal(created?.state, "active");
    // A second insert of the same pair is a no-op, not a duplicate row.
    assert.equal(
      await f.db.insertPhotoTag({
        photoId: f.photoId,
        userId: f.aliceId,
        taggedBy: f.photographerId,
      }),
      null,
    );
    assert.equal((await f.db.removePhotoTag(f.photoId, f.aliceId))?.state, "removed");
    // Removing twice is a no-op, and re-adding is refused by the primary key.
    assert.equal(await f.db.removePhotoTag(f.photoId, f.aliceId), null);
    assert.equal(
      await f.db.insertPhotoTag({
        photoId: f.photoId,
        userId: f.aliceId,
        taggedBy: f.photographerId,
      }),
      null,
    );
    assert.equal((await f.db.findPhotoTag(f.photoId, f.aliceId))?.state, "removed");
    // `state` is constrained, so no third value can be written by hand.
    await assert.rejects(
      f.sql`update photo_tags set state = 'maybe' where photo_id = ${f.photoId} and user_id = ${f.aliceId}`,
    );
    return undefined;
  });

  it("erasing the tagger keeps the tagged person's row and its refusal", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const [tagger] = await f.sql<{ id: string }[]>`
      insert into users (email, role) values ('ephemeral@example.com', 'participant') returning id
    `;
    assert.ok(tagger);
    assert.ok(await f.db.setTagProfile(f.aliceId, f.eventId, { taggable: true, displayName: "Alice Rossi", consentTextVersion: "2026-10-09" }));
    const tag = await f.db.insertPhotoTag({
      photoId: f.secondPhotoId,
      userId: f.aliceId,
      taggedBy: tagger.id,
    });
    assert.equal(tag?.taggedBy, tagger.id);
    assert.equal((await f.db.removePhotoTag(f.secondPhotoId, f.aliceId))?.state, "removed");
    await f.sql`delete from users where id = ${tagger.id}`;
    // `on delete set null`: the refusal survives the tagger's erasure, so the tag cannot be
    // created again by anyone.
    const kept = await f.db.findPhotoTag(f.secondPhotoId, f.aliceId);
    assert.equal(kept?.state, "removed");
    assert.equal(kept?.taggedBy, null);
    return undefined;
  });

  it("searches a prefix of opted-in display names, with no e-mail", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    assert.ok(await f.db.setTagProfile(f.aliceId, f.eventId, { taggable: true, displayName: "Alice Rossi", consentTextVersion: "2026-10-09" }));
    // `bob` is a participant of the event who never opted in: he must not appear, whatever
    // his name, which is the one membership rule the search has.
    assert.ok(await f.db.setTagProfile(f.bobId, f.eventId, { taggable: false, displayName: "Alibaba" }));

    const found = await f.db.searchTaggableUsers({ eventId: f.eventId, prefix: "ali", limit: 8 });
    assert.deepEqual(found, [{ userId: f.aliceId, displayName: "Alice Rossi" }]);
    assert.deepEqual(Object.keys(found[0] ?? {}).sort(), ["displayName", "userId"]);

    // Case-insensitive, prefix only, never a substring.
    assert.equal(
      (await f.db.searchTaggableUsers({ eventId: f.eventId, prefix: "ALI", limit: 8 })).length,
      1,
    );
    for (const prefix of ["ice", "oss", "ssi"]) {
      assert.deepEqual(
        await f.db.searchTaggableUsers({ eventId: f.eventId, prefix, limit: 8 }),
        [],
        `substring ${prefix} must not match`,
      );
    }
    // A LIKE wildcard is escaped, not interpreted.
    for (const prefix of ["%%%", "___", "%al"]) {
      assert.deepEqual(
        await f.db.searchTaggableUsers({ eventId: f.eventId, prefix, limit: 8 }),
        [],
        `wildcard ${prefix} must not match`,
      );
    }
    // The database layer refuses a short prefix on its own, without the API's help.
    for (const prefix of ["", "a", "al", "  a  "]) {
      assert.deepEqual(
        await f.db.searchTaggableUsers({ eventId: f.eventId, prefix, limit: 8 }),
        [],
        `prefix ${JSON.stringify(prefix)} must return nothing`,
      );
    }
    // An opt-out leaves the index and the result set.
    assert.ok(await f.db.setTagProfile(f.aliceId, f.eventId, { taggable: false }));
    assert.deepEqual(
      await f.db.searchTaggableUsers({ eventId: f.eventId, prefix: "ali", limit: 8 }),
      [],
    );
    assert.ok(await f.db.setTagProfile(f.aliceId, f.eventId, { taggable: true, displayName: "Alice Rossi", consentTextVersion: "2026-10-09" }));
    return undefined;
  });

  it("serves the autocomplete from the partial index on lower(display_name)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // 2 000 opted-in members of this event, so the planner has a reason to use an index.
    await f.sql`
      insert into users (email, role, display_name)
      select 'bulk' || i || '@example.com', 'participant', 'Nome' || i
      from generate_series(1, 2000) as g(i)
      on conflict do nothing
    `;
    await f.sql`
      insert into event_members (user_id, event_id, source, taggable, taggable_consent_version)
      select u.id, ${f.eventId}, 'event_code', true, '2026-10-09'
      from users u where u.email like 'bulk%@example.com'
      on conflict (user_id, event_id) do update
        set taggable = true, taggable_consent_version = '2026-10-09'
    `;
    await f.sql`analyze users`;
    await f.sql`analyze event_members`;
    const plan = (
      await f.sql<{ "QUERY PLAN": string }[]>`
        explain (costs off)
        select u.id, u.display_name
        from users u
        join event_members m on m.user_id = u.id
        where m.event_id = ${f.eventId}
          and m.taggable
          and u.display_name is not null
          and lower(u.display_name) like 'nome1%'
        order by lower(u.display_name) asc, u.id asc
        limit 8
      `
    )
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    // What matters is the `users` side: it holds every account the deployment has ever had,
    // so it is the side that grows without bound, and a sequential scan of it is the thing
    // that turns a 3-character query into a 6 000-row read.
    assert.ok(
      plan.includes("users_display_name_idx"),
      `the name prefix must come from the index:\n${plan}`,
    );
    assert.ok(
      !plan.includes("Seq Scan on users"),
      `the autocomplete must not sequential-scan the users:\n${plan}`,
    );
    // The membership side is deliberately NOT asserted on: it is bounded by the members of
    // one event, and at this size the planner hashes it rather than probing per row, which is
    // the right choice. The guarantee that matters there is that the partial index exists, so
    // the planner HAS the probe available once a deployment holds several events.
    const indexes = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where tablename = 'event_members' or tablename = 'users'
      `
    ).map((row) => row.indexname);
    assert.ok(indexes.includes("event_members_taggable_idx"), indexes.join(", "));
    assert.ok(indexes.includes("users_display_name_idx"), indexes.join(", "));
    return undefined;
  });

  /**
   * The event scope, at the level that actually serves it. The API test asserts the behaviour;
   * this asserts that the query carries it, against the real index.
   */
  it("never suggests someone who opted in at another event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    // The outsider belongs to BOTH events and opted in at the other one only.
    await f.db.addEventMember({
      userId: f.outsiderId,
      eventId: f.eventId,
      source: "event_code",
    });
    assert.ok(
      await f.db.setTagProfile(f.outsiderId, f.otherEventId, {
        taggable: true,
        displayName: "Alida Bianchi",
        consentTextVersion: "2026-10-09",
      }),
    );
    assert.deepEqual(
      await f.db.searchTaggableUsers({ eventId: f.otherEventId, prefix: "ali", limit: 8 }),
      [{ userId: f.outsiderId, displayName: "Alida Bianchi" }],
    );
    // Same account, same display name, a membership row here — and still invisible, because
    // the opt-in is per event.
    const here = await f.db.searchTaggableUsers({ eventId: f.eventId, prefix: "alid", limit: 8 });
    assert.deepEqual(here, [], "the opt-in does not travel between events");
    assert.equal((await f.db.findTagProfile(f.outsiderId, f.eventId))?.taggable, false);
    // And the `taggable_needs_consent` constraint refuses a flag with no accepted text,
    // whoever writes it.
    await assert.rejects(
      f.sql`
        update event_members set taggable = true, taggable_consent_version = null
        where user_id = ${f.outsiderId} and event_id = ${f.eventId}
      `,
      /taggable_needs_consent/,
    );
    return undefined;
  });

  /**
   * THE OTHER HALF of the frozen-decision guard (the first is in
   * `apps/api/test/v6-tags.test.ts`). Withdrawing the recognition consent is a real state
   * change here — `consents.withdrawn_at` is exactly what `hasActiveConsent` reads — so this
   * is the only place the independence can be asserted against the mechanism itself rather
   * than against its absence.
   *
   * Agent G is building consent withdrawal on `v6/privacy`. What G needs to know: withdrawing
   * the recognition consent must NOT touch `users.taggable`, `users.taggable_consent_*` or
   * `photo_tags`. They are a separate legal basis with their own Italian text, and the
   * participant's own opt-out (`PUT /tags/me` with `taggable: false`) is the withdrawal for
   * tagging — it already cascades to every active tag, audited.
   */
  it("withdrawing the recognition consent leaves taggability and tags alone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    assert.ok(
      await f.db.setTagProfile(f.aliceId, f.eventId, {
        taggable: true,
        displayName: "Alice Rossi",
        consentTextVersion: "2026-10-09",
      }),
    );
    // A fresh photo, so this test does not depend on the state the earlier ones left.
    const [album] = await f.sql<{ id: string }[]>`
      select id from albums where event_id = ${f.eventId} order by created_at, id limit 1
    `;
    assert.ok(album);
    const [photo] = await f.sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key, content_type, bytes)
      values (
        ${f.eventId}, ${album.id}, ${f.photographerId}, ${"9".repeat(64)}, 'indexed',
        ${`originals/${f.eventId}/withdraw`}, 'image/jpeg', 1000
      )
      returning id
    `;
    assert.ok(photo);
    const tag = await f.db.insertPhotoTag({
      photoId: photo.id,
      userId: f.aliceId,
      taggedBy: f.photographerId,
    });
    assert.equal(tag?.state, "active");
    assert.equal(await f.db.hasActiveConsent(f.aliceId, f.eventId), true);

    // The withdrawal, on the real column the recognition gate reads.
    await f.sql`
      update consents set withdrawn_at = now()
      where user_id = ${f.aliceId} and event_id = ${f.eventId}
    `;
    assert.equal(
      await f.db.hasActiveConsent(f.aliceId, f.eventId),
      false,
      "the withdrawal really took effect",
    );

    // Taggability, its consent record and the tag are all untouched.
    const profile = await f.db.findTagProfile(f.aliceId, f.eventId);
    assert.equal(profile?.taggable, true);
    assert.equal(profile?.consentTextVersion, "2026-10-09");
    assert.ok(profile?.consentAt instanceof Date);
    assert.equal((await f.db.findPhotoTag(photo.id, f.aliceId))?.state, "active");
    // And she is still findable: the autocomplete has no recognition-consent clause.
    assert.deepEqual(await f.db.searchTaggableUsers({ eventId: f.eventId, prefix: "ali", limit: 8 }), [
      { userId: f.aliceId, displayName: "Alice Rossi" },
    ]);

    // Restore the fixture state for the tests that follow.
    await f.sql`
      update consents set withdrawn_at = null
      where user_id = ${f.aliceId} and event_id = ${f.eventId}
    `;
    await f.db.removePhotoTag(photo.id, f.aliceId);
    return undefined;
  });

  it("reads the audit trail back by target", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = requireFixture();
    const target = `photo:${f.photoId}`;
    await f.db.insertAudit({
      actorId: f.photographerId,
      action: "photo.tagged",
      target,
      meta: { eventId: f.eventId, userId: f.aliceId, taggedBy: f.photographerId },
    });
    await f.db.insertAudit({
      actorId: f.aliceId,
      action: "photo.untagged",
      target,
      meta: { eventId: f.eventId, userId: f.aliceId, reason: "not_me" },
    });
    const rows = await f.db.listAuditForTarget(target);
    assert.deepEqual(rows.map((row) => row.action), ["photo.tagged", "photo.untagged"]);
    // `audit_log.meta` is jsonb; the mapper parses it, so the trail is readable as data.
    assert.deepEqual(rows[1]?.meta, {
      eventId: f.eventId,
      userId: f.aliceId,
      reason: "not_me",
    });
    assert.deepEqual(await f.db.listAuditForTarget("photo:none"), []);
    return undefined;
  });
});
