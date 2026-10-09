/**
 * v6 G (agent G): consent withdrawal and the retention scheduler against a real Postgres.
 *
 * These are the claims that only a database can settle, and that the memory implementation
 * cannot prove:
 *
 * - after a withdrawal no template of that person is left anywhere: no `galleries` row (so
 *   no `query_embedding` and no anchors), no `gallery_items`, and no `face_vectors` row for
 *   the faces the system had identified as them — checked with `select` on the real tables;
 * - a selfie search over `face_vectors` with the exact vector of one of those faces finds
 *   nothing any more, so the gallery cannot be rebuilt from what is stored;
 * - another participant's personal gallery comes out untouched (section G hard rule): same
 *   row, same items, same selfie vector;
 * - re-consent works and does not resurrect a deleted vector;
 * - `claimRetentionWindow` hands the window to exactly one of several concurrent callers.
 *
 * Runs only with `TEST_DATABASE_URL` pointing at a pgvector-enabled server, in a scratch
 * database of its own which it drops and recreates:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55484/rephoto \
 *     node --import tsx --test packages/db/src/privacy.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_privacy_test";

type Person = {
  userId: string;
  galleryId: string;
  /** `faces.external_id` of the face attributed to them, = `face_vectors.external_face_id`. */
  externalFaceId: string;
  /** The vector stored for that face, to search with later. */
  embedding: number[];
};

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  otherEventId: string;
  albumId: string;
  photoId: string;
  sharedPhotoId: string;
  withdrawer: Person;
  bystander: Person;
};

let fixture: Fixture | undefined;
let skipReason: string | undefined;
let adminSql: Sql | undefined;

function scratchUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

function seededVector(seed: number): number[] {
  return Array.from({ length: 512 }, (_, index) => Math.sin(seed * 0.41 + index * 0.013));
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => value.toFixed(6)).join(",")}]`;
}

/** One event, two participants, three photos, vectors and galleries as the worker writes them. */
async function seed(sql: Sql): Promise<Omit<Fixture, "sql" | "db">> {
  const [event] = await sql<{ id: string }[]>`
    insert into events (slug, name, retention_days) values ('privacy', 'Evento privacy', 90)
    returning id
  `;
  const [other] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('privacy-altro', 'Altro evento') returning id
  `;
  assert.ok(event && other);
  const [album] = await sql<{ id: string }[]>`
    select id from albums where event_id = ${event.id} and slug = 'ufficiale'
  `;
  assert.ok(album, "migration 009 gives every event its official album");
  const [photographer] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('shooter@example.com', 'photographer') returning id
  `;
  assert.ok(photographer);

  const photoIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const [photo] = await sql<{ id: string }[]>`
      insert into photos (event_id, album_id, photographer_id, sha256, status, original_key, content_type, bytes)
      values (
        ${event.id}, ${album.id}, ${photographer.id}, ${String(index + 1).repeat(64).slice(0, 64)},
        'indexed', ${`originals/${event.id}/${index}`}, 'image/jpeg', 2000
      )
      returning id
    `;
    assert.ok(photo);
    photoIds.push(photo.id);
  }
  const [photoId, sharedPhotoId, bystanderPhotoId] = photoIds;
  assert.ok(photoId && sharedPhotoId && bystanderPhotoId);

  async function makePerson(input: {
    email: string;
    seed: number;
    /** Photos the person's gallery holds; the first one carries their anchored face. */
    photos: string[];
  }): Promise<Person> {
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, role) values (${input.email}, 'participant') returning id
    `;
    assert.ok(user);
    await sql`
      insert into consents (user_id, event_id, text_version, ip, user_agent)
      values (${user.id}, ${event.id}, '2026-10-08', '203.0.113.7', 'test-agent')
    `;
    const faceIds: string[] = [];
    let externalFaceId = "";
    let embedding: number[] = [];
    for (const [index, photo] of input.photos.entries()) {
      const external = randomUUID();
      const vector = seededVector(input.seed + index);
      const [face] = await sql<{ id: string }[]>`
        insert into faces (photo_id, event_id, external_id, bbox, confidence)
        values (
          ${photo}, ${event.id}, ${external},
          ${sql.json({ x: 0.1 * index, y: 0.1, width: 0.2, height: 0.3 })}, 0.98
        )
        returning id
      `;
      assert.ok(face);
      faceIds.push(face.id);
      await sql`
        insert into face_vectors (event_id, album_id, photo_id, external_face_id, embedding)
        values (${event.id}, ${album.id}, ${photo}, ${external}::uuid, ${vectorLiteral(vector)}::vector)
      `;
      if (index === 0) {
        externalFaceId = external;
        embedding = vector;
      }
    }
    const firstExternal = externalFaceId;
    const [gallery] = await sql<{ id: string }[]>`
      insert into galleries (user_id, event_id, anchor_face_ids, matched_at, notified_at, query_embedding)
      values (
        ${user.id}, ${event.id}, ${[firstExternal]}::text[], now(), now(),
        ${vectorLiteral(seededVector(input.seed + 100))}::vector
      )
      returning id
    `;
    assert.ok(gallery);
    for (const [index, photo] of input.photos.entries()) {
      const faceId = faceIds[index];
      assert.ok(faceId);
      await sql`
        insert into gallery_items (gallery_id, photo_id, face_id, score, source)
        values (${gallery.id}, ${photo}, ${faceId}, ${0.95 - index * 0.05}, 'match')
      `;
    }
    await sql`
      insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time)
      values (${user.id}, ${event.id}, ${input.photos[0]}, 'me', 0.95)
    `;
    const [run] = await sql<{ id: string }[]>`
      insert into match_runs (user_id, event_id, liveness, hits)
      values (${user.id}, ${event.id}, 'challenge', 1)
      returning id
    `;
    assert.ok(run);
    await sql`
      insert into match_hits (run_id, photo_id, external_face_id, cosine, similarity, kept)
      values (${run.id}, ${input.photos[0]}, ${firstExternal}, 0.81, 0.97, true)
    `;
    return { userId: user.id, galleryId: gallery.id, externalFaceId: firstExternal, embedding };
  }

  // The withdrawer appears in two photos; the bystander appears in the second of those
  // (so both galleries hold `sharedPhotoId`) and in one of their own.
  const withdrawer = await makePerson({
    email: "ritira@example.com",
    seed: 1,
    photos: [photoId, sharedPhotoId],
  });
  const bystander = await makePerson({
    email: "resta@example.com",
    seed: 20,
    photos: [bystanderPhotoId, sharedPhotoId],
  });
  return {
    eventId: event.id,
    otherEventId: other.id,
    albumId: album.id,
    photoId,
    sharedPhotoId,
    withdrawer,
    bystander,
  };
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
  const sql = createSql(scratchUrl(ADMIN_URL), { max: 4 });
  await migrate(sql);
  const seeded = await seed(sql);
  fixture = { sql, db: new PostgresDatabase(sql), ...seeded };
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

/** Faces of the event whose vector is still stored, by engine id. */
async function storedVectors(f: Fixture): Promise<string[]> {
  const rows = await f.sql<{ external_face_id: string }[]>`
    select external_face_id::text from face_vectors where event_id = ${f.eventId}
    order by external_face_id
  `;
  return rows.map((row) => row.external_face_id);
}

describe("migration 015", () => {
  it("creates retention_schedule and the two indexes, and leaves the galleries alone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const [table] = await f.sql<{ present: boolean }[]>`
      select to_regclass('public.retention_schedule') is not null as present
    `;
    assert.equal(table?.present, true);
    const indexes = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where schemaname = 'public' and indexname in ('consents_user_event_idx', 'jobs_retention_event_idx')
        order by indexname
      `
    ).map((row) => row.indexname);
    assert.deepEqual(indexes, ["consents_user_event_idx", "jobs_retention_event_idx"]);
    // The hard rule of the spec: the personal gallery tables are untouched by v6 G.
    const [galleries] = await f.sql<{ count: number }[]>`select count(*)::int as count from galleries`;
    assert.equal(galleries?.count, 2);
  });
});

describe("consent withdrawal", () => {
  it("deletes the gallery, the selfie vector, the anchors and the identified templates", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const before = await storedVectors(f);
    assert.equal(before.length, 4, "two people × two faces");

    const result = await f.db.withdrawConsent({
      userId: f.withdrawer.userId,
      eventId: f.eventId,
    });
    assert.equal(result.consents, 1);
    assert.equal(result.galleryDeleted, true);
    assert.equal(result.galleryItems, 2);
    assert.equal(result.selfieVector, true);
    assert.equal(result.anchors, 1);
    // The two faces of the withdrawer's own gallery items (one of them the anchor).
    assert.equal(result.externalFaceIds.length, 2);
    assert.equal(result.faceVectors, 2);
    assert.equal(result.feedback, 1);
    assert.equal(result.matchRuns, 1);

    const consents = await f.sql<{ withdrawn_at: Date | null }[]>`
      select withdrawn_at from consents
      where user_id = ${f.withdrawer.userId} and event_id = ${f.eventId}
    `;
    assert.equal(consents.length, 1);
    assert.ok(consents[0]?.withdrawn_at instanceof Date, "withdrawn_at is written at last");

    const galleries = await f.sql`
      select id from galleries where user_id = ${f.withdrawer.userId} and event_id = ${f.eventId}
    `;
    assert.equal(galleries.length, 0, "no gallery row, so no query_embedding and no anchors");
    const [items] = await f.sql<{ count: number }[]>`
      select count(*)::int as count from gallery_items where gallery_id = ${f.withdrawer.galleryId}
    `;
    assert.equal(items?.count, 0);
    const [feedback] = await f.sql<{ count: number }[]>`
      select count(*)::int as count from gallery_feedback where user_id = ${f.withdrawer.userId}
    `;
    assert.equal(feedback?.count, 0);
    const [runs] = await f.sql<{ count: number }[]>`
      select count(*)::int as count from match_runs where user_id = ${f.withdrawer.userId}
    `;
    assert.equal(runs?.count, 0);
    const [hits] = await f.sql<{ count: number }[]>`select count(*)::int as count from match_hits`;
    assert.equal(hits?.count, 1, "only the bystander's hit is left (match_hits cascades)");

    const after = await storedVectors(f);
    assert.equal(after.length, 2);
    assert.ok(
      !after.includes(f.withdrawer.externalFaceId),
      "the template of the identified face is gone",
    );
  });

  it("leaves the photos and their faces in the album, with no link to the person", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const [photos] = await f.sql<{ count: number }[]>`
      select count(*)::int as count from photos where event_id = ${f.eventId}
    `;
    assert.equal(photos?.count, 3, "the official album keeps its photos");
    const faces = await f.sql<{ external_id: string }[]>`
      select external_id from faces where external_id = ${f.withdrawer.externalFaceId}
    `;
    assert.equal(faces.length, 1, "the bounding box stays: it is not a template");
    const links = await f.sql`
      select 1 from gallery_items gi
      join faces fa on fa.id = gi.face_id
      where fa.external_id = ${f.withdrawer.externalFaceId}
    `;
    assert.equal(links.length, 0, "nothing links that face to a person any more");
  });

  it("a selfie search over the stored vectors can no longer find the withdrawn faces", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // The exact embedding of the deleted face: the strongest possible query. Anything the
    // search returns now belongs to somebody else.
    const rows = await f.sql<{ external_face_id: string; cosine: number }[]>`
      select external_face_id::text, 1 - (embedding <=> ${vectorLiteral(f.withdrawer.embedding)}::vector) as cosine
      from face_vectors
      where event_id = ${f.eventId}
      order by embedding <=> ${vectorLiteral(f.withdrawer.embedding)}::vector
      limit 10
    `;
    assert.ok(
      !rows.some((row) => row.external_face_id === f.withdrawer.externalFaceId),
      "the deleted template cannot come back as its own nearest neighbour",
    );
    const state = await f.db.findConsentState(f.withdrawer.userId, f.eventId);
    assert.equal(state.grantedAt, null);
    assert.equal(state.gallery, null);
    assert.ok(state.withdrawnAt instanceof Date);
  });

  it("leaves the other participant's personal gallery exactly as it was", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const [gallery] = await f.sql<{
      id: string;
      anchor_face_ids: string[];
      has_vector: boolean;
    }[]>`
      select id, anchor_face_ids, (query_embedding is not null) as has_vector
      from galleries where user_id = ${f.bystander.userId} and event_id = ${f.eventId}
    `;
    assert.equal(gallery?.id, f.bystander.galleryId);
    assert.deepEqual(gallery?.anchor_face_ids, [f.bystander.externalFaceId]);
    assert.equal(gallery?.has_vector, true, "their selfie vector is untouched");
    const items = await f.sql<{ photo_id: string }[]>`
      select photo_id from gallery_items where gallery_id = ${f.bystander.galleryId} order by score desc
    `;
    assert.equal(items.length, 2, "including the photo they share with the withdrawer");
    assert.ok(items.some((row) => row.photo_id === f.sharedPhotoId));
    const vectors = await storedVectors(f);
    assert.ok(vectors.includes(f.bystander.externalFaceId), "their template is still indexed");
  });

  it("is idempotent, and re-consent does not bring a deleted vector back", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const second = await f.db.withdrawConsent({ userId: f.withdrawer.userId, eventId: f.eventId });
    assert.deepEqual(
      {
        consents: second.consents,
        gallery: second.galleryDeleted,
        items: second.galleryItems,
        vectors: second.faceVectors,
      },
      { consents: 0, gallery: false, items: 0, vectors: 0 },
    );

    await f.db.insertConsent({
      userId: f.withdrawer.userId,
      eventId: f.eventId,
      textVersion: "2026-10-08",
      ip: "203.0.113.7",
      userAgent: "test-agent",
    });
    assert.equal(await f.db.hasActiveConsent(f.withdrawer.userId, f.eventId), true);
    const state = await f.db.findConsentState(f.withdrawer.userId, f.eventId);
    assert.ok(state.grantedAt instanceof Date, "consent is active again");
    assert.ok(state.withdrawnAt instanceof Date, "the withdrawal stays on the record");
    assert.equal(state.gallery, null, "a new selfie is needed: nothing was resurrected");
    const vectors = await storedVectors(f);
    assert.ok(!vectors.includes(f.withdrawer.externalFaceId));
    assert.equal(vectors.length, 2);
  });
});

describe("retention scheduling", () => {
  it("hands one window to exactly one of several concurrent callers", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const windowStart = new Date("2026-10-07T00:00:00.000Z");
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.db.claimRetentionWindow({ eventId: f.eventId, windowStart, windowSeconds: 86400 }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1, "exactly one claim under concurrency");

    // The same window again: never a second run.
    assert.equal(
      await f.db.claimRetentionWindow({ eventId: f.eventId, windowStart, windowSeconds: 86400 }),
      false,
    );
    // The next window: one run again.
    const next = new Date(windowStart.getTime() + 86400 * 1000);
    assert.equal(
      await f.db.claimRetentionWindow({ eventId: f.eventId, windowStart: next, windowSeconds: 86400 }),
      true,
    );
    const [row] = await f.sql<{ runs: number; window_start: Date; last_outcome: string }[]>`
      select runs, window_start, last_outcome from retention_schedule where event_id = ${f.eventId}
    `;
    assert.equal(row?.runs, 2);
    assert.equal(row?.window_start.toISOString(), next.toISOString());
    assert.equal(row?.last_outcome, "enqueued");
  });

  it("reports the state of every event, with the last retention job", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const jobId = await f.db.enqueueJob("retention", { eventId: f.eventId, actorId: null });
    await f.db.recordRetentionRun({ eventId: f.eventId, outcome: "enqueued", jobId });
    const rows = await f.db.listRetentionStatus();
    assert.equal(rows.length, 2, "one row per event, even the one never scheduled");
    const scheduled = rows.find((row) => row.eventId === f.eventId);
    const never = rows.find((row) => row.eventId === f.otherEventId);
    assert.equal(scheduled?.retentionDays, 90);
    assert.equal(scheduled?.runs, 2);
    assert.equal(scheduled?.lastOutcome, "enqueued");
    assert.equal(scheduled?.lastJobId, jobId);
    assert.equal(scheduled?.lastJob?.id, jobId);
    assert.equal(scheduled?.lastJob?.status, "queued");
    assert.equal(never?.runs, 0);
    assert.equal(never?.windowStart, null);
    assert.equal(never?.lastJob, null);

    await f.db.recordRetentionRun({
      eventId: f.eventId,
      outcome: "failed",
      error: "queue unavailable",
    });
    const failed = (await f.db.listRetentionStatus()).find((row) => row.eventId === f.eventId);
    assert.equal(failed?.lastOutcome, "failed");
    assert.equal(failed?.lastError, "queue unavailable");
  });

  it("hands one alarm mail per window to one caller, and clears it once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const window = new Date("2026-10-09T00:00:00.000Z");
    assert.equal(
      await f.db.claimRetentionWindow({ eventId: f.eventId, windowStart: window, windowSeconds: 86400 }),
      true,
    );
    // Five workers see the same alarm in the same window: one mail.
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.db.claimRetentionAlarmMail({ eventId: f.eventId, alarm: "failed", window }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1, "exactly one mail under concurrency");
    // Every later tick of the same window with the same reason: nothing.
    assert.equal(
      await f.db.claimRetentionAlarmMail({ eventId: f.eventId, alarm: "failed", window }),
      false,
    );
    // A different reason in the same window is new information.
    assert.equal(
      await f.db.claimRetentionAlarmMail({ eventId: f.eventId, alarm: "job_error", window }),
      true,
    );
    // The next window: the same reason is worth one more.
    const next = new Date(window.getTime() + 86400 * 1000);
    assert.equal(
      await f.db.claimRetentionAlarmMail({ eventId: f.eventId, alarm: "job_error", window: next }),
      true,
    );
    const [row] = await f.sql<{ notified_alarm: string; notified_window: Date }[]>`
      select notified_alarm, notified_window from retention_schedule where event_id = ${f.eventId}
    `;
    assert.equal(row?.notified_alarm, "job_error");
    assert.equal(row?.notified_window.toISOString(), next.toISOString());

    // Resolution: the previous alarm comes back once, then there is nothing to clear.
    assert.equal(await f.db.clearRetentionAlarmMail(f.eventId), "job_error");
    assert.equal(await f.db.clearRetentionAlarmMail(f.eventId), null);
    // And after a clear the same alarm can be raised again in the same window.
    assert.equal(
      await f.db.claimRetentionAlarmMail({ eventId: f.eventId, alarm: "job_error", window: next }),
      true,
    );
    await f.db.clearRetentionAlarmMail(f.eventId);
  });

  it("drops its row with the event (no orphan schedule)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const [event] = await f.sql<{ id: string }[]>`
      insert into events (slug, name) values ('privacy-usa-e-getta', 'Usa e getta') returning id
    `;
    assert.ok(event);
    assert.equal(
      await f.db.claimRetentionWindow({
        eventId: event.id,
        windowStart: new Date("2026-10-07T00:00:00.000Z"),
        windowSeconds: 86400,
      }),
      true,
    );
    await f.sql`delete from events where id = ${event.id}`;
    const rows = await f.sql`select 1 from retention_schedule where event_id = ${event.id}`;
    assert.equal(rows.length, 0);
  });
});
