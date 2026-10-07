/**
 * v6 A1/A2 (agent A): albums, the frozen rules around them and album-scoped dedup, against
 * the in-memory database. The same rules are proved against a real Postgres (the `check`
 * constraint and the trigger that own them) in `albums.pg.test.ts`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { MemoryDatabase } from "./memory.ts";
import {
  AlbumRecognitionLockedError,
  AlbumRecognitionNotAllowedError,
  DuplicateKeyError,
} from "./types.ts";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";

async function seeded(): Promise<MemoryDatabase> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  return db;
}

async function addPhoto(
  db: MemoryDatabase,
  input: { albumId?: string; sha256?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insertPhoto({
    id,
    eventId: EVENT_ID,
    photographerId: PHOTOGRAPHER_ID,
    sha256: input.sha256 ?? id.replace(/-/g, "").padEnd(64, "0"),
    originalKey: `originals/${EVENT_ID}/${id}`,
    contentType: "image/jpeg",
    bytes: 10,
    ...(input.albumId ? { albumId: input.albumId } : {}),
  });
  return id;
}

async function crowdAlbum(db: MemoryDatabase, slug = "tutti"): Promise<string> {
  const album = await db.createAlbum({
    eventId: EVENT_ID,
    slug,
    name: "Album di tutti",
    kind: "crowd",
  });
  return album.id;
}

describe("albums (v6 A1)", () => {
  it("gives every event an official recognising album, as v5 behaved", async () => {
    const db = await seeded();
    const album = await db.findDefaultAlbum(EVENT_ID);
    assert.ok(album, "the demo event has its official album");
    assert.equal(album.slug, "ufficiale");
    assert.equal(album.kind, "official");
    assert.equal(album.recognition, true);
    assert.equal(album.moderation, "off");
    assert.equal(album.visibility, "participants");
    assert.equal(album.firstUploadAt, null);

    const created = await db.createEvent({ slug: "altro", name: "Altro" });
    const other = await db.findDefaultAlbum(created.id);
    assert.ok(other, "an event created later gets one too");
    assert.equal(other.recognition, true);
  });

  it("puts a photo without an album into the event's official album", async () => {
    const db = await seeded();
    const official = await db.findDefaultAlbum(EVENT_ID);
    const photoId = await addPhoto(db);
    const photo = await db.findPhoto(photoId);
    assert.equal(photo?.albumId, official?.id);
  });

  it("refuses recognition on a crowd album (decision 2)", async () => {
    const db = await seeded();
    await assert.rejects(
      db.createAlbum({
        eventId: EVENT_ID,
        slug: "tutti",
        name: "Album di tutti",
        kind: "crowd",
        recognition: true,
      }),
      AlbumRecognitionNotAllowedError,
    );
    const albumId = await crowdAlbum(db);
    await assert.rejects(db.updateAlbum(albumId, { recognition: true }), AlbumRecognitionNotAllowedError);
    const album = await db.findAlbum(albumId);
    assert.equal(album?.recognition, false);
  });

  it("refuses a duplicate slug inside the event but allows it in another", async () => {
    const db = await seeded();
    await crowdAlbum(db);
    await assert.rejects(crowdAlbum(db), DuplicateKeyError);
    const other = await db.createEvent({ slug: "secondo", name: "Secondo" });
    const album = await db.createAlbum({
      eventId: other.id,
      slug: "tutti",
      name: "Album di tutti",
      kind: "crowd",
    });
    assert.equal(album.slug, "tutti");
  });

  it("freezes recognition once the album has its first upload (decision 3)", async () => {
    const db = await seeded();
    const album = await db.createAlbum({
      eventId: EVENT_ID,
      slug: "staff",
      name: "Album staff",
      kind: "official",
      recognition: false,
    });
    // Before the first upload the flag is still free.
    assert.equal((await db.updateAlbum(album.id, { recognition: true }))?.recognition, true);
    await addPhoto(db, { albumId: album.id });
    const withUpload = await db.findAlbum(album.id);
    assert.ok(withUpload?.firstUploadAt, "the first photo stamps first_upload_at");
    await assert.rejects(db.updateAlbum(album.id, { recognition: false }), AlbumRecognitionLockedError);
    assert.equal((await db.findAlbum(album.id))?.recognition, true);
    // Everything else stays editable after the first upload.
    const patched = await db.updateAlbum(album.id, { name: "Rinominato", uploadsOpen: false });
    assert.equal(patched?.name, "Rinominato");
    assert.equal(patched?.uploadsOpen, false);
    // Setting recognition to the value it already has is not a change.
    assert.equal((await db.updateAlbum(album.id, { recognition: true }))?.recognition, true);
  });

  it("lists only recognising albums as the ones that may hold vectors", async () => {
    const db = await seeded();
    const official = await db.findDefaultAlbum(EVENT_ID);
    await crowdAlbum(db);
    assert.deepEqual(await db.listRecognitionAlbumIds(EVENT_ID), [official?.id]);
  });

  it("dedupes per album: the same bytes land once per album, never as an error across albums", async () => {
    const db = await seeded();
    const official = await db.findDefaultAlbum(EVENT_ID);
    const crowd = await crowdAlbum(db);
    const sha256 = "a".repeat(64);
    const first = await addPhoto(db, { albumId: official?.id, sha256 });
    // Same bytes, another album: a new photo.
    const second = await addPhoto(db, { albumId: crowd, sha256 });
    assert.notEqual(first, second);
    assert.equal((await db.findPhotoByAlbumSha(official?.id ?? "", sha256))?.id, first);
    assert.equal((await db.findPhotoByAlbumSha(crowd, sha256))?.id, second);
    // Same bytes, same album: already uploaded. The caller sees the existing photo through
    // findPhotoByAlbumSha and answers "already uploaded" instead of failing.
    await assert.rejects(addPhoto(db, { albumId: crowd, sha256 }), DuplicateKeyError);
    assert.equal((await db.findPhotoByAlbumSha(crowd, sha256))?.id, second);
  });

  it("leaves the personal match gallery exactly as it was", async () => {
    const db = await seeded();
    const user = await db.insertUser("p@example.com", "participant");
    const official = await db.findDefaultAlbum(EVENT_ID);
    const photoId = await addPhoto(db, { albumId: official?.id });
    await db.upsertDerivative({ photoId, kind: "thumb", s3Key: `thumbs/${photoId}.jpg` });
    await db.upsertDerivative({ photoId, kind: "web", s3Key: `web/${photoId}.jpg` });
    await db.replaceFaces(photoId, EVENT_ID, [
      { externalId: "f1", bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
    ]);
    const face = (await db.findFaceRowsByPhoto(photoId))[0];
    await db.replaceGallery(user.id, EVENT_ID, [{ photoId, faceId: face?.id ?? "", score: 0.9 }], ["f1"]);
    const page = await db.listGalleryPage(user.id, EVENT_ID, { limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.photoId, photoId);
    // A crowd album added afterwards changes nothing about it.
    await crowdAlbum(db);
    const after = await db.listGalleryPage(user.id, EVENT_ID, { limit: 10 });
    assert.deepEqual(after, page);
  });
});
