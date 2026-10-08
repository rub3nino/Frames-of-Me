/**
 * v6 A (agent A): migrations 009 + 011 against a real Postgres that already holds v5 data,
 * including personal match galleries. Proves what only the database can prove:
 *
 * - the personal galleries (`galleries`, `gallery_items`) come out byte-for-byte unchanged
 *   and keep working (section G, hard rule);
 * - `kind = 'crowd'` with `recognition = true` is refused by the `check` constraint;
 * - `recognition` cannot change once `first_upload_at` is set;
 * - 019 fills `first_upload_at` on an album 009 backfilled over already-existing photos, so
 *   that lock also holds for them — the INSERT-only trigger never stamped those albums;
 * - dedup is per album: the same bytes land in a second album and are a duplicate only
 *   inside one album;
 * - the album-filtered vector search is served by the album's partial HNSW index.
 *
 * It runs only with `TEST_DATABASE_URL` set to a pgvector-enabled server, and it works in
 * a scratch database of its own (`rephoto_v6_albums_test`), which it drops and recreates:
 *
 *   TEST_DATABASE_URL=postgres://rephoto:rephoto@localhost:55439/rephoto \
 *     node --import tsx --test packages/db/src/albums.pg.test.ts
 *
 * Without the variable every test is skipped with the reason.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { searchAlbumSql } from "../../face-engine/src/insightface.ts";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";
import { AlbumRecognitionLockedError, AlbumRecognitionNotAllowedError, DuplicateKeyError } from "./types.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_albums_test";
/** Migrations that existed before v6: applied first, so 009/011 run on a v5 database. */
const V5_MIGRATIONS = [
  "001_init.sql",
  "002_scale.sql",
  "003_v2.sql",
  "004_two_stage.sql",
  "005_face_vectors.sql",
  "006_recognition.sql",
  "007_test_tooling.sql",
  "008_staff_passwords.sql",
];
const VECTORS_PER_ALBUM = 1000;

type Fixture = {
  sql: Sql;
  db: PostgresDatabase;
  eventId: string;
  otherEventId: string;
  participantId: string;
  photographerId: string;
  officialPhotoId: string;
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

/** The v5 database: migrations 001-008 applied and recorded, then realistic rows. */
async function seedV5(sql: Sql): Promise<Omit<Fixture, "sql" | "db" | "galleries" | "galleryItems" | "galleryColumns">> {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  for (const name of V5_MIGRATIONS) {
    const text = await readMigration(name);
    await sql.unsafe(text);
    await sql`insert into schema_migrations (id) values (${name})`;
  }

  const [event] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('v5-event', 'Evento v5') returning id
  `;
  const [other] = await sql<{ id: string }[]>`
    insert into events (slug, name) values ('v5-altro', 'Altro evento v5') returning id
  `;
  const [participant] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('guest@example.com', 'participant') returning id
  `;
  const [photographer] = await sql<{ id: string }[]>`
    insert into users (email, role) values ('shooter@example.com', 'photographer') returning id
  `;
  assert.ok(event && other && participant && photographer);

  const photos: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const [photo] = await sql<{ id: string }[]>`
      insert into photos (event_id, photographer_id, sha256, status, original_key, content_type, bytes)
      values (
        ${event.id}, ${photographer.id}, ${String(index + 1).repeat(64).slice(0, 64)}, 'indexed',
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
    insert into galleries (user_id, event_id, anchor_face_ids, matched_at, query_embedding)
    values (${participant.id}, ${event.id}, ${["ext-1"]}, now(), ${vectorLiteral(seededVector(1))}::vector)
    returning id
  `;
  assert.ok(gallery);
  await sql`
    insert into gallery_items (gallery_id, photo_id, face_id, score, source)
    values (${gallery.id}, ${photoId}, ${face.id}, 0.93, 'match')
  `;
  await sql`
    insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time)
    values (${participant.id}, ${event.id}, ${photoId}, 'me', 0.93)
  `;
  await sql`
    insert into face_vectors (event_id, photo_id, embedding)
    values (${event.id}, ${photoId}, ${vectorLiteral(seededVector(2))}::vector)
  `;
  return {
    eventId: event.id,
    otherEventId: other.id,
    participantId: participant.id,
    photographerId: photographer.id,
    officialPhotoId: photoId,
  };
}

function seededVector(seed: number): number[] {
  return Array.from({ length: 512 }, (_, index) => Math.sin(seed * 0.37 + index * 0.011));
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((value) => value.toFixed(6)).join(",")}]`;
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
  const seeded = await seedV5(sql);
  const galleryColumns = (
    await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'galleries'
      order by column_name
    `
  ).map((row) => row.column_name);
  const galleries = await sql`select * from galleries order by id`;
  const galleryItems = await sql`select * from gallery_items order by id`;
  fixture = {
    sql,
    db: new PostgresDatabase(sql),
    ...seeded,
    galleries: [...galleries],
    galleryItems: [...galleryItems],
    galleryColumns,
  };
  // The v6 migrations, on exactly that v5 database.
  await migrate(sql);
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

describe("migrations 009 + 011 on a v5 database", () => {
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
    assert.equal(columns.includes("album_id"), false, "galleries is not an album");
    assert.deepEqual([...(await f.sql`select * from galleries order by id`)], f.galleries);
    assert.deepEqual([...(await f.sql`select * from gallery_items order by id`)], f.galleryItems);
    // And it still works: the gallery page the participant sees is the seeded one.
    const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.photoId, f.officialPhotoId);
    const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
    assert.deepEqual(gallery?.anchorFaceIds, ["ext-1"]);
    assert.equal(gallery?.hasQueryVector, true);
    assert.equal(await f.db.countGalleriesWithQueryVector(f.eventId), 1);
    assert.equal((await f.db.findGalleriesByQueryVector(f.eventId, seededVector(1), 0.5)).length, 1);
  });

  it("backfills one official recognising album per event and puts every photo in it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const albums = await f.db.listAlbums(f.eventId);
    assert.equal(albums.length, 1);
    const album = albums[0];
    assert.equal(album?.slug, "ufficiale");
    assert.equal(album?.kind, "official");
    assert.equal(album?.recognition, true);
    assert.equal(album?.moderation, "off");
    // 019 derives `first_upload_at` from the photos 009 re-pointed into this album: the
    // album really does hold uploads, and the lock must see that (see the next test).
    assert.ok(album?.firstUploadAt instanceof Date, "019 stamps the backfilled album");
    assert.ok(await f.db.findDefaultAlbum(f.otherEventId), "the second event has one too");
    const orphans = await f.sql<{ count: number }[]>`
      select count(*)::int as count from photos p
      join albums a on a.id = p.album_id
      where a.event_id <> p.event_id
    `;
    assert.equal(orphans[0]?.count, 0);
    const assigned = await f.sql<{ count: number }[]>`
      select count(*)::int as count from photos where album_id = ${album?.id ?? ""}
    `;
    assert.equal(assigned[0]?.count, 2);
    // An event created after the migration gets its album from the trigger.
    const created = await f.db.createEvent({ slug: "post-009", name: "Dopo 009" });
    assert.ok(await f.db.findDefaultAlbum(created.id));
  });

  it("locks recognition on an album backfilled over photos that already existed (019)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // 009 creates the official album and re-points the pre-existing photos at it with an
    // UPDATE, but `photos_album_first_upload` is `after insert on photos`, so the backfilled
    // album came out of 009 with `first_upload_at = NULL` — and `albums_recognition_lock`
    // only raises when it is not null. An admin could therefore have flipped `recognition`
    // on photos uploaded under a different consent, which decision 3 (frozen) forbids.
    // 019_first_upload_backfill.sql derives the value from the photos themselves.
    const album = await f.db.findDefaultAlbum(f.eventId);
    assert.ok(album, "the backfilled official album");
    const [earliest] = await f.sql<{ first_upload: Date }[]>`
      select min(created_at) as first_upload from photos where album_id = ${album.id}
    `;
    assert.ok(earliest?.first_upload, "the album holds the pre-009 photos");
    assert.ok(album.firstUploadAt, "019 filled first_upload_at");
    assert.equal(
      album.firstUploadAt?.getTime(),
      earliest.first_upload.getTime(),
      "and it is the earliest photo's created_at, not now()",
    );
    // Which is the whole point: the lock now fires, in the database and through the app.
    const direct = await f.sql`
      update albums set recognition = false where id = ${album.id}
    `.catch((error: unknown) => error as { code?: string });
    assert.equal((direct as { code?: string }).code, "ALBRI", "the trigger refuses it");
    await assert.rejects(
      f.db.updateAlbum(album.id, { recognition: false }),
      AlbumRecognitionLockedError,
    );
    assert.equal((await f.db.findAlbum(album.id))?.recognition, true, "unchanged");
    // An album 009 backfilled onto an event with no photos is left alone: nothing was
    // uploaded into it, so it stays null and stays editable.
    const empty = await f.db.findDefaultAlbum(f.otherEventId);
    assert.ok(empty);
    assert.equal(empty.firstUploadAt, null, "019 does not invent an upload");
    assert.equal((await f.db.updateAlbum(empty.id, { recognition: false }))?.recognition, false);
    assert.equal((await f.db.updateAlbum(empty.id, { recognition: true }))?.recognition, true);
  });

  it("refuses kind = crowd with recognition = true through the check constraint", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const direct = await f.sql`
      insert into albums (event_id, slug, name, kind, recognition)
      values (${f.eventId}, 'crowd-direct', 'Album di tutti', 'crowd', true)
    `.catch((error: unknown) => error as { code?: string; constraint_name?: string });
    assert.equal((direct as { code?: string }).code, "23514");
    assert.equal((direct as { constraint_name?: string }).constraint_name, "crowd_never_recognizes");
    // The same through the application, as its typed error.
    await assert.rejects(
      f.db.createAlbum({
        eventId: f.eventId,
        slug: "crowd-typed",
        name: "Album di tutti",
        kind: "crowd",
        recognition: true,
      }),
      AlbumRecognitionNotAllowedError,
    );
    const crowd = await f.db.createAlbum({
      eventId: f.eventId,
      slug: "tutti",
      name: "Album di tutti",
      kind: "crowd",
    });
    assert.equal(crowd.recognition, false);
    await assert.rejects(
      f.db.updateAlbum(crowd.id, { recognition: true }),
      AlbumRecognitionNotAllowedError,
    );
    assert.equal((await f.db.findAlbum(crowd.id))?.recognition, false);
    await assert.rejects(
      f.db.createAlbum({ eventId: f.eventId, slug: "tutti", name: "Doppio", kind: "crowd" }),
      DuplicateKeyError,
    );
  });

  it("freezes recognition once the album has its first upload", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const album = await f.db.createAlbum({
      eventId: f.eventId,
      slug: "immutabile",
      name: "Album immutabile",
      kind: "official",
      recognition: false,
    });
    assert.equal(album.firstUploadAt, null);
    // Still free before the first upload.
    assert.equal((await f.db.updateAlbum(album.id, { recognition: true }))?.recognition, true);
    const photoId = randomUUID();
    await f.db.insertPhoto({
      id: photoId,
      eventId: f.eventId,
      photographerId: f.photographerId,
      sha256: "f".repeat(64),
      originalKey: `originals/${f.eventId}/${photoId}`,
      contentType: "image/jpeg",
      bytes: 100,
      albumId: album.id,
    });
    const stamped = await f.db.findAlbum(album.id);
    assert.ok(stamped?.firstUploadAt, "the photo insert stamped first_upload_at");
    const direct = await f.sql`
      update albums set recognition = false where id = ${album.id}
    `.catch((error: unknown) => error as { code?: string });
    assert.equal((direct as { code?: string }).code, "ALBRI", "the trigger refuses it in the database");
    await assert.rejects(f.db.updateAlbum(album.id, { recognition: false }), AlbumRecognitionLockedError);
    assert.equal((await f.db.findAlbum(album.id))?.recognition, true);
    // Everything else stays editable.
    assert.equal((await f.db.updateAlbum(album.id, { uploadsOpen: false }))?.uploadsOpen, false);
    assert.equal((await f.db.updateAlbum(album.id, { maxPhotosPerUser: 5 }))?.maxPhotosPerUser, 5);
  });

  it("dedupes per album, not per event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const official = await f.db.findDefaultAlbum(f.eventId);
    const crowd = await f.db.findAlbumBySlug(f.eventId, "tutti");
    assert.ok(official && crowd);
    const sha256 = "ab".repeat(32);
    const first = randomUUID();
    await f.db.insertPhoto({
      id: first,
      eventId: f.eventId,
      photographerId: f.photographerId,
      sha256,
      originalKey: `originals/${f.eventId}/${first}`,
      contentType: "image/jpeg",
      bytes: 10,
      albumId: official.id,
    });
    // The same bytes forwarded into the crowd album: a new photo, not an error.
    const second = randomUUID();
    await f.db.insertPhoto({
      id: second,
      eventId: f.eventId,
      photographerId: f.participantId,
      sha256,
      originalKey: `originals/${f.eventId}/${second}`,
      contentType: "image/jpeg",
      bytes: 10,
      albumId: crowd.id,
    });
    assert.equal((await f.db.findPhotoByAlbumSha(official.id, sha256))?.id, first);
    assert.equal((await f.db.findPhotoByAlbumSha(crowd.id, sha256))?.id, second);
    // Twice in the same album: already uploaded. The caller reads the existing row and
    // answers with it instead of failing.
    await assert.rejects(
      f.db.insertPhoto({
        id: randomUUID(),
        eventId: f.eventId,
        photographerId: f.participantId,
        sha256,
        originalKey: `originals/${f.eventId}/dup`,
        contentType: "image/jpeg",
        bytes: 10,
        albumId: crowd.id,
      }),
      DuplicateKeyError,
    );
    const constraints = await f.sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'photos'::regclass and contype = 'u'
    `;
    const names = constraints.map((row) => row.conname);
    assert.ok(names.includes("photos_album_sha_key"), `unique (album_id, sha256): ${names.join()}`);
    assert.equal(names.includes("photos_event_id_sha256_key"), false, "the event-wide unique is gone");
  });

  it("moves every vector into its album and serves the album search from an index", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const official = await f.db.findDefaultAlbum(f.eventId);
    const crowd = await f.db.findAlbumBySlug(f.eventId, "tutti");
    assert.ok(official && crowd);
    const backfilled = await f.sql<{ count: number; nulls: number }[]>`
      select count(*)::int as count, count(*) filter (where album_id is null)::int as nulls
      from face_vectors
    `;
    assert.equal(backfilled[0]?.count, 1, "the v5 vector survived");
    assert.equal(backfilled[0]?.nulls, 0, "and carries its album");
    const column = await f.sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'face_vectors' and column_name = 'album_id'
    `;
    assert.equal(column[0]?.is_nullable, "NO");
    const fk = await f.sql<{ count: number }[]>`
      select count(*)::int as count from pg_constraint where conname = 'face_vectors_album_id_fkey'
    `;
    assert.equal(fk[0]?.count, 1);

    // The global HNSW index is gone, replaced by one partial index per recognising album.
    const indexes = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes where tablename = 'face_vectors'
      `
    ).map((row) => row.indexname);
    assert.equal(indexes.includes("face_vectors_embedding_idx"), false, "no global HNSW index");
    const albumIndex = `face_vectors_hnsw_${official.id.replace(/-/g, "")}`;
    assert.ok(indexes.includes(albumIndex), `partial index per album: ${indexes.join()}`);
    assert.equal(
      indexes.includes(`face_vectors_hnsw_${crowd.id.replace(/-/g, "")}`),
      false,
      "a crowd album never gets a vector index",
    );
    const galleryIndexes = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes where tablename = 'galleries'
      `
    ).map((row) => row.indexname);
    assert.ok(galleryIndexes.includes("galleries_event_query_vector_idx"));

    // An album created by the event trigger, not by the application, has its index too.
    const triggered = await f.db.createEvent({ slug: "indicizzato", name: "Indicizzato" });
    const defaultAlbum = await f.db.findDefaultAlbum(triggered.id);
    assert.ok(defaultAlbum);
    const triggeredIndexes = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes where tablename = 'face_vectors'
      `
    ).map((row) => row.indexname);
    assert.ok(
      triggeredIndexes.includes(`face_vectors_hnsw_${defaultAlbum.id.replace(/-/g, "")}`),
      "the album of a new event is indexed as well",
    );

    // A second recognising album gets its index when it is created.
    const second = await f.db.createAlbum({
      eventId: f.eventId,
      slug: "backstage",
      name: "Album backstage",
      kind: "official",
      recognition: true,
    });
    const afterCreate = (
      await f.sql<{ indexname: string }[]>`
        select indexname from pg_indexes where tablename = 'face_vectors'
      `
    ).map((row) => row.indexname);
    assert.ok(afterCreate.includes(`face_vectors_hnsw_${second.id.replace(/-/g, "")}`));

    // Enough vectors in two albums for the planner to have a choice, then EXPLAIN the
    // statement the engine runs (packages/face-engine/src/insightface.ts, SEARCH_ALBUM_SQL).
    const secondPhotoId = randomUUID();
    await f.db.insertPhoto({
      id: secondPhotoId,
      eventId: f.eventId,
      photographerId: f.photographerId,
      sha256: "cd".repeat(32),
      originalKey: `originals/${f.eventId}/${secondPhotoId}`,
      contentType: "image/jpeg",
      bytes: 10,
      albumId: second.id,
    });
    for (const [albumId, photoId] of [
      [official.id, f.officialPhotoId],
      [second.id, secondPhotoId],
    ] as const) {
      await f.sql`
        insert into face_vectors (event_id, photo_id, album_id, embedding)
        select ${f.eventId}, ${photoId}, ${albumId},
               ('[' || string_agg(random()::text, ',') || ']')::vector(512)
        from generate_series(1, ${VECTORS_PER_ALBUM}) as g(n),
             generate_series(1, 512) as d(i)
        group by g.n
      `;
    }
    const distinct = await f.sql<{ count: number }[]>`
      select count(distinct embedding)::int as count from face_vectors where album_id = ${official.id}
    `;
    assert.ok((distinct[0]?.count ?? 0) > 1, "the generated vectors differ from each other");
    await f.sql`analyze face_vectors`;
    // EXPLAIN the statement the engine really runs, built by the engine itself. Forcing the
    // ordering to come from an index is what makes this a statement about the index rather
    // than about this fixture's size: 1000 vectors per album are few enough that an exact
    // scan and sort is cheaper (and lossless), while at event scale the planner picks the
    // index on its own — see the plans in docs/v6-albums-vector-recall.md.
    const FORCE_INDEX_ORDER =
      "set local enable_seqscan = off; set local enable_sort = off; set local enable_bitmapscan = off";
    const query = vectorLiteral(seededVector(3));
    const explain = async (statement: string, params: (string | number)[]): Promise<string> =>
      (
        await f.sql.begin(async (tx) => {
          await tx.unsafe(FORCE_INDEX_ORDER);
          return tx.unsafe(`explain ${statement}`, params);
        })
      )
        .map((row) => String((row as Record<string, unknown>)["QUERY PLAN"]))
        // The plan repeats the 512-dimension query vector; keep the shape, drop the numbers.
        .map((line) => line.replace(/'\[[^\]]*\]'/g, "'[…]'"))
        .join("\n");

    const plan = await explain(searchAlbumSql(official.id), [query, f.eventId, 200]);
    assert.match(plan, new RegExp(`Index Scan using ${albumIndex}`), plan);

    // Why the engine writes the album id into the statement instead of binding it: a
    // partial index predicate can only be matched against a value the planner can see. A
    // bound album survives only as long as Postgres re-plans per execution; the moment the
    // statement gets a generic plan (which is what a reused prepared statement gets, and
    // the worker runs this one thousands of times) the album becomes an opaque parameter
    // and the index is out of reach. The literal form is immune to that.
    const generic = async (prepared: string, args: string): Promise<string> =>
      (
        await f.sql.begin(async (tx) => {
          await tx.unsafe("deallocate all");
          await tx.unsafe(`prepare album_probe as ${prepared}`);
          await tx.unsafe("set local plan_cache_mode = force_generic_plan");
          await tx.unsafe(FORCE_INDEX_ORDER);
          return tx.unsafe(`explain execute album_probe(${args})`);
        })
      )
        .map((row) => String((row as Record<string, unknown>)["QUERY PLAN"]))
        .map((line) => line.replace(/'\[[^\]]*\]'/g, "'[…]'"))
        .join("\n");

    const boundAlbum = await generic(
      `select external_face_id, photo_id, 1 - (embedding <=> $1::vector) as cos
       from face_vectors
       where event_id = $2::uuid and album_id = $4::uuid
       order by embedding <=> $1::vector
       limit $3`,
      `'${query}'::vector, '${f.eventId}'::uuid, 200, '${official.id}'::uuid`,
    );
    assert.doesNotMatch(boundAlbum, new RegExp(albumIndex), boundAlbum);
    const literalAlbum = await generic(
      searchAlbumSql(official.id),
      `'${query}'::vector, '${f.eventId}'::uuid, 200`,
    );
    assert.match(literalAlbum, new RegExp(`Index Scan using ${albumIndex}`), literalAlbum);

    // And the search really stays inside the album.
    const rows = await f.sql.unsafe<{ album_id: string }[]>(
      `select album_id::text as album_id
       from face_vectors
       where event_id = $2::uuid and album_id = $3::uuid
       order by embedding <=> $1::vector
       limit 50`,
      [query, f.eventId, official.id],
    );
    assert.equal(rows.length, 50);
    assert.deepEqual([...new Set(rows.map((row) => row.album_id))], [official.id]);
  });
});
