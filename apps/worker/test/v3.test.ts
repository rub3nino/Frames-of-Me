import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { objectKeys } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { pollOnce } from "../src/run.js";
import {
  drain,
  env,
  MemoryObjectStore,
  quiet,
  RecordingMailer,
  sameBytes,
  sha256,
  solidPng,
  trackingEngine,
} from "./helpers.ts";

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  objects: MemoryObjectStore;
  faces: ReturnType<typeof trackingEngine>;
  queue: JobQueue;
  deps: WorkerDeps;
};

async function fixture(): Promise<Fixture> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const objects = new MemoryObjectStore();
  const faces = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
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
  return { db, eventId: event.id, photographerId: photographer.id, objects, faces, queue, deps };
}

/**
 * What the api leaves behind after a web-stage complete: a pending photo declaring the
 * original's sha256/bytes, the browser-rendered web JPEG, and its derivative row.
 */
async function webFirstPhoto(
  f: Fixture,
  rgb: [number, number, number],
): Promise<{ photoId: string; original: Uint8Array; web: Uint8Array }> {
  const original = new Uint8Array(await solidPng(...rgb, 64));
  const web = new Uint8Array(await sharp(Buffer.from(original)).jpeg({ quality: 80 }).toBuffer());
  const photoId = randomUUID();
  await f.db.insertPhoto({
    id: photoId,
    eventId: f.eventId,
    photographerId: f.photographerId,
    sha256: sha256(original),
    originalKey: objectKeys.original(f.eventId, photoId),
    contentType: "image/png",
    bytes: original.byteLength,
    originalStatus: "pending",
  });
  await f.objects.put(objectKeys.web(photoId), web, "image/jpeg");
  await f.db.upsertDerivative({ photoId, kind: "web", s3Key: objectKeys.web(photoId) });
  return { photoId, original, web };
}

test("derive of a pending original builds only the thumb from the web derivative and indexes", async () => {
  const f = await fixture();
  const { photoId, web } = await webFirstPhoto(f, [200, 30, 30]);
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);

  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.status, "indexed");
  assert.equal(photo?.originalStatus, "pending");
  assert.equal(photo?.error, null);
  assert.equal(f.objects.objects.has(objectKeys.original(f.eventId, photoId)), false);
  const thumb = await f.objects.get(objectKeys.thumb(photoId));
  assert.ok(thumb);
  const meta = await sharp(Buffer.from(thumb.body)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok((meta.width ?? 0) <= 480);
  const storedWeb = await f.objects.get(objectKeys.web(photoId));
  assert.ok(storedWeb && sameBytes(storedWeb.body, web));
  assert.deepEqual(
    (await f.db.listDerivatives(photoId)).map((row) => row.kind).sort(),
    ["thumb", "web"],
  );
  assert.deepEqual(f.faces.indexedPhotoIds, [photoId]);
});

test("derive of a pending original fails (retryable) when the web derivative is missing", async () => {
  const f = await fixture();
  const { photoId } = await webFirstPhoto(f, [30, 200, 30]);
  await f.objects.delete(objectKeys.web(photoId));
  const jobId = await f.queue.enqueue("derive", { photoId });
  assert.equal(await pollOnce(f.deps), true);
  const job = f.db.jobView(jobId);
  assert.equal(job?.status, "queued");
  assert.equal(job?.attempts, 1);
  assert.equal(job?.lastError, "Web derivative missing");
  assert.equal((await f.db.findPhoto(photoId))?.status, "processing");
  assert.equal(f.faces.indexedPhotoIds.length, 0);
});

test("derive of a pending original fails terminally and drops a web object that is not an image", async () => {
  const f = await fixture();
  const { photoId } = await webFirstPhoto(f, [200, 30, 30]);
  await f.objects.put(objectKeys.web(photoId), new TextEncoder().encode("<html>not a jpeg</html>"), "image/jpeg");
  const jobId = await f.queue.enqueue("derive", { photoId });
  assert.equal(await pollOnce(f.deps), true);
  const job = f.db.jobView(jobId);
  assert.equal(job?.status, "error");
  assert.equal(job?.lastError, "unsupported image");
  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.status, "error");
  assert.equal(photo?.error, "unsupported image");
  assert.equal(photo?.originalStatus, "pending");
  assert.equal(await f.objects.get(objectKeys.web(photoId)), null);
  assert.equal(await f.objects.get(objectKeys.thumb(photoId)), null);
  assert.equal(f.faces.indexedPhotoIds.length, 0);
});

test("verify drops a mismatching original and reopens the original stage", async () => {
  const f = await fixture();
  const { photoId, original } = await webFirstPhoto(f, [30, 30, 200]);
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);
  const indexedBefore = f.faces.indexedPhotoIds.length;

  // The api already flipped the status; the bytes that arrived are not the declared ones.
  const originalKey = objectKeys.original(f.eventId, photoId);
  const tampered = new Uint8Array(original);
  tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1]! + 1) & 0xff;
  await f.objects.put(originalKey, tampered, "image/png");
  await f.db.setOriginalStatus(photoId, "present");
  const jobId = await f.queue.enqueue("verify", { photoId });
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.db.jobView(jobId)?.status, "done");

  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.originalStatus, "pending");
  assert.equal(photo?.error, "sha256 mismatch");
  assert.equal(photo?.status, "indexed");
  assert.equal(f.objects.objects.has(originalKey), false);
  assert.equal(f.objects.objects.has(objectKeys.web(photoId)), true);
  // No re-derive and no re-index were queued.
  assert.equal(await pollOnce(f.deps), false);
  assert.equal(f.faces.indexedPhotoIds.length, indexedBefore);

  // A wrong size is also a mismatch, even when the hash would be recomputed later.
  await f.objects.put(originalKey, original.subarray(0, original.byteLength - 1), "image/png");
  await f.db.setOriginalStatus(photoId, "present");
  await f.queue.enqueue("verify", { photoId });
  await drain(f.deps);
  assert.equal((await f.db.findPhoto(photoId))?.originalStatus, "pending");
  assert.equal(f.objects.objects.has(originalKey), false);
});

test("verify keeps a matching original and clears an earlier mismatch note", async () => {
  const f = await fixture();
  const { photoId, original } = await webFirstPhoto(f, [120, 120, 120]);
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);
  const originalKey = objectKeys.original(f.eventId, photoId);
  await f.db.setPhotoErrorText(photoId, "sha256 mismatch");
  await f.objects.put(originalKey, original, "image/png");
  await f.db.setOriginalStatus(photoId, "present");
  await f.queue.enqueue("verify", { photoId });
  await drain(f.deps);

  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.originalStatus, "present");
  assert.equal(photo?.error, null);
  assert.equal(photo?.status, "indexed");
  assert.ok(f.objects.objects.has(originalKey));
  assert.deepEqual(f.faces.indexedPhotoIds, [photoId]);

  // A verify for a photo whose original went back to pending is a no-op.
  await f.db.setOriginalStatus(photoId, "pending");
  await f.objects.delete(originalKey);
  const noop = await f.queue.enqueue("verify", { photoId });
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.db.jobView(noop)?.status, "done");
});

test("verify reopens the original stage when the original object is missing", async () => {
  const f = await fixture();
  const { photoId, original } = await webFirstPhoto(f, [10, 90, 160]);
  await f.db.setOriginalStatus(photoId, "present");
  const jobId = await f.queue.enqueue("verify", { photoId });
  assert.equal(await pollOnce(f.deps), true);
  // Terminal: the job is done at the first attempt, nothing is retried.
  assert.equal(f.db.jobView(jobId)?.status, "done");
  let photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.status, "uploaded");
  assert.equal(photo?.originalStatus, "pending");
  assert.equal(photo?.error, "original missing");
  assert.equal(await pollOnce(f.deps), false);

  // The client sends the original again: the api flips the status, verify clears the note.
  const originalKey = objectKeys.original(f.eventId, photoId);
  await f.objects.put(originalKey, original, "image/png");
  await f.db.setOriginalStatus(photoId, "present");
  await f.queue.enqueue("verify", { photoId });
  await drain(f.deps);
  photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.originalStatus, "present");
  assert.equal(photo?.error, null);
});
