/**
 * v6 hardening H4 (agent H): album isolation end to end, now that the fake engine actually
 * filters on `albumIds`.
 *
 * `v6.test.ts` (agent A) proves the worker passes the right album ids. Until the fake
 * honoured them, that was all any test on the fake engine could prove. These two go the rest
 * of the way: with a vector for a crowd album deliberately present in the engine — a
 * re-index from an older build, a seed script writing SQL, rows that predate the rule — a
 * personal match gallery still never contains a crowd photo, and the official album still
 * matches exactly as before.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { objectKeys } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { MemoryObjectStore, RecordingMailer, drain, env, quiet, solidPng, storePhoto } from "./helpers.ts";

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  participantId: string;
  officialAlbumId: string;
  crowdAlbumId: string;
  objects: MemoryObjectStore;
  faces: FakeFaceEngine;
  queue: JobQueue;
  deps: WorkerDeps;
};

async function fixture(): Promise<Fixture> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const official = await db.findDefaultAlbum(event.id);
  assert.ok(official);
  const crowd = await db.createAlbum({
    eventId: event.id,
    slug: "tutti",
    name: "Album di tutti",
    kind: "crowd",
  });
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const faces = new FakeFaceEngine(new MemoryFaceIndexStore());
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
    log: quiet,
  };
  return {
    db,
    eventId: event.id,
    photographerId: photographer.id,
    participantId: participant.id,
    officialAlbumId: official.id,
    crowdAlbumId: crowd.id,
    objects,
    faces,
    queue,
    deps,
  };
}

let size = 16;

async function ingest(f: Fixture, albumId: string, rgb: [number, number, number]): Promise<string> {
  size += 8;
  const bytes = new Uint8Array(await solidPng(...rgb, size));
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
    albumId,
  });
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);
  return photoId;
}

async function runMatch(f: Fixture, rgb: [number, number, number]): Promise<void> {
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(...rgb)), "image/png");
  await f.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey,
  });
  await drain(f.deps);
}

async function galleryPhotoIds(f: Fixture): Promise<string[]> {
  const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 50 });
  return page.items.map((item) => item.photoId).sort();
}

const RED: [number, number, number] = [200, 10, 30];

test("a crowd album's media are never in a match gallery, even with a vector for it in the engine", async () => {
  const f = await fixture();
  const official = await ingest(f, f.officialAlbumId, RED);
  const crowd = await ingest(f, f.crowdAlbumId, RED);
  // The worker refused to index the crowd photo, as it must (v6.test.ts covers that).
  assert.deepEqual(await f.db.listExternalIds(crowd), []);

  // Now put a vector for it in the engine anyway: the state this test exists for. Same
  // colour as the official photo, so in the fake it is literally the same person.
  const crowdBytes = new Uint8Array(await solidPng(...RED, 40));
  const forced = await f.faces.indexPhoto({
    eventId: f.eventId,
    photoId: crowd,
    imageBytes: crowdBytes,
    contentType: "image/png",
    albumId: f.crowdAlbumId,
  });
  assert.equal(forced.length, 1, "the engine really holds a vector for the crowd photo");

  await runMatch(f, RED);
  const items = await galleryPhotoIds(f);
  assert.deepEqual(items, [official], "the official photo matched, the crowd photo did not");
  assert.equal(items.includes(crowd), false, "a crowd album is never searchable");
});

test("the personal match gallery of the official album is unaffected", async () => {
  const f = await fixture();
  const first = await ingest(f, f.officialAlbumId, RED);
  const second = await ingest(f, f.officialAlbumId, RED);
  // A different person (different colour) in the same album is not matched.
  const stranger = await ingest(f, f.officialAlbumId, [20, 30, 200]);
  await runMatch(f, RED);
  assert.deepEqual(await galleryPhotoIds(f), [first, second].sort());
  assert.equal((await galleryPhotoIds(f)).includes(stranger), false);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery, "the personal gallery row exists");
  assert.notEqual(gallery.matchedAt, null);
});
