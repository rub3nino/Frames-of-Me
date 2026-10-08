import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { JOB_MAX_ATTEMPTS } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { runHousekeeping, runWorkerLoop } from "../src/loop.js";
import { pollOnce } from "../src/run.js";
import {
  drain,
  env,
  MemoryObjectStore,
  quiet,
  RecordingMailer,
  sha256,
  solidPng,
  storePhoto,
  trackingEngine,
} from "./helpers.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  participantId: string;
  objects: MemoryObjectStore;
  mailer: RecordingMailer;
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
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const mailer = new RecordingMailer();
  const faces = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
  const queue = createQueue(db);
  const deps: WorkerDeps = { env, db, objects, mailer, queue, faces, log: quiet };
  return {
    db,
    eventId: event.id,
    photographerId: photographer.id,
    participantId: participant.id,
    objects,
    mailer,
    faces,
    queue,
    deps,
  };
}

let photoSize = 8;

/**
 * Uploads a solid photo and runs derive → index → attach. Each call uses a new
 * size (a multiple of 8, so the JPEG average colour stays exact) to keep sha256s distinct.
 */
async function ingest(f: Fixture, rgb: [number, number, number]): Promise<string> {
  photoSize += 8;
  const bytes = new Uint8Array(await solidPng(...rgb, photoSize));
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
  });
  await f.queue.enqueue("derive", { photoId });
  await drain(f.deps);
  assert.equal((await f.db.findPhoto(photoId))?.status, "indexed");
  return photoId;
}

/** Stores a selfie and runs match → email. */
async function selfie(f: Fixture, rgb: [number, number, number]): Promise<void> {
  const selfieKey = `selfies/${f.eventId}/${randomUUID()}.png`;
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(...rgb)), "image/png");
  await f.queue.enqueue("match", { userId: f.participantId, eventId: f.eventId, selfieKey });
  await drain(f.deps);
  assert.equal(f.objects.objects.has(selfieKey), false);
}

test("derive fails terminally on a sha256 mismatch and marks the photo", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(await solidPng(10, 20, 30));
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
    sha256: "0".repeat(64),
  });
  const jobId = await f.queue.enqueue("derive", { photoId });
  assert.equal(await pollOnce(f.deps), true);

  const job = f.db.jobView(jobId);
  assert.equal(job?.status, "error");
  assert.equal(job?.attempts, JOB_MAX_ATTEMPTS);
  assert.equal(job?.lastError, "sha256 mismatch");
  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.status, "error");
  assert.equal(photo?.error, "sha256 mismatch");
  assert.equal(await pollOnce(f.deps), false);
  assert.equal(f.faces.indexedPhotoIds.length, 0);
});

test("derive fails terminally when the bytes are not an image", async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode("definitely not a png");
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
    sha256: sha256(bytes),
  });
  const jobId = await f.queue.enqueue("derive", { photoId });
  assert.equal(await pollOnce(f.deps), true);

  const job = f.db.jobView(jobId);
  assert.equal(job?.status, "error");
  assert.equal(job?.attempts, JOB_MAX_ATTEMPTS);
  assert.equal(job?.lastError, "unsupported image");
  const photo = await f.db.findPhoto(photoId);
  assert.equal(photo?.status, "error");
  assert.equal(photo?.error, "unsupported image");
  assert.equal(await pollOnce(f.deps), false);
});

test("match stores the anchors of the best five distinct photos", async () => {
  const f = await fixture();
  const redIds: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    redIds.push(await ingest(f, [255, 0, 0]));
  }
  await ingest(f, [0, 0, 255]);
  await selfie(f, [255, 0, 0]);

  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery);
  assert.ok(gallery.matchedAt);
  assert.equal(gallery.anchorFaceIds.length, 5);
  assert.equal(new Set(gallery.anchorFaceIds).size, 5);
  const redFaceIds = new Set(redIds.map((id) => `fake-${id}`));
  for (const anchor of gallery.anchorFaceIds) assert.ok(redFaceIds.has(anchor));
  const items = await f.db.listGallery(f.participantId, f.eventId);
  assert.deepEqual(items.map((item) => item.photoId).sort(), [...redIds].sort());
  assert.equal(f.mailer.sent.length, 1);
  assert.equal(f.mailer.sent[0]?.subject, "Le tue foto sono pronte");
});

test("attach adds a later matching photo to the gallery and notifies at most once per window", async () => {
  const f = await fixture();
  const first = await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery);
  assert.deepEqual(gallery.anchorFaceIds, [`fake-${first}`]);
  assert.equal(f.mailer.sent.length, 1);

  // The match itself counts as a notification: a photo attached right after it is silent.
  const silent = await ingest(f, [255, 0, 0]);
  assert.ok(f.faces.searchedFaceIds.includes(`fake-${silent}`));
  assert.equal(f.mailer.sent.length, 1);
  assert.equal((await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 })).total, 2);

  // Once the window has passed, the next attached photo notifies.
  await f.db.markGalleryNotified(gallery.id, new Date(Date.now() - 7 * HOUR));
  const second = await ingest(f, [255, 0, 0]);
  assert.ok(f.faces.searchedFaceIds.includes(`fake-${second}`));
  let page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.equal(page.total, 3);
  const attached = page.items.find((item) => item.photoId === second);
  assert.ok(attached);
  assert.equal(attached.source, "attach");
  // v5: the stored score is the best of the anchor hit (0.99) and the selfie-vector match
  // (cosine 1 with the fake engine → 1).
  assert.equal(attached.score, 1);
  assert.equal(page.items.find((item) => item.photoId === first)?.source, "match");
  assert.equal(f.mailer.sent.length, 2);
  assert.equal(f.mailer.sent[1]?.subject, "Ci sono nuove foto per te");
  assert.match(f.mailer.sent[1]?.text ?? "", /^http:\/\/localhost:3000\/e\/demo$/);

  // Within the six-hour window another new photo is added silently.
  const third = await ingest(f, [255, 0, 0]);
  page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.equal(page.total, 4);
  assert.equal(page.items.find((item) => item.photoId === third)?.source, "attach");
  assert.equal(f.mailer.sent.length, 2);

  // A photo of someone else is not attached and does not notify.
  const blue = await ingest(f, [0, 0, 255]);
  page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.equal(page.total, 4);
  assert.equal(page.items.some((item) => item.photoId === blue), false);
  assert.equal(f.mailer.sent.length, 2);

  // After another window, the next attach notifies again.
  await f.db.markGalleryNotified(gallery.id, new Date(Date.now() - 7 * HOUR));
  await ingest(f, [255, 0, 0]);
  assert.equal(f.mailer.sent.length, 3);
  assert.equal(f.mailer.sent[2]?.subject, "Ci sono nuove foto per te");
});

test("attach skips the face searches while the event has no anchored gallery", async () => {
  const f = await fixture();
  const photoId = await ingest(f, [255, 0, 0]);
  assert.equal((await f.db.findFaceRowsByPhoto(photoId)).length, 1);
  assert.equal(f.faces.searchedFaceIds.length, 0);

  // The first selfie creates the anchors; from then on every new photo is searched.
  await selfie(f, [255, 0, 0]);
  const later = await ingest(f, [255, 0, 0]);
  assert.deepEqual(f.faces.searchedFaceIds, [`fake-${later}`]);
});

test("attach is a no-op for a photo without faces", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(await solidPng(0, 255, 0));
  const photoId = await storePhoto(f.deps, {
    eventId: f.eventId,
    photographerId: f.photographerId,
    bytes,
  });
  await f.queue.enqueue("attach", { photoId });
  await drain(f.deps);
  assert.equal(f.faces.searchedFaceIds.length, 0);
});

test("the loop runs jobs in parallel up to the concurrency limit", async () => {
  const f = await fixture();
  const pending: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  let finished = 0;
  f.deps.mailer = {
    async send() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => pending.push(resolve));
      running -= 1;
      finished += 1;
    },
  };
  const total = 5;
  for (let index = 0; index < total; index += 1) {
    const user = await f.db.createUser({ email: `p${index}@example.com`, role: "participant" });
    await f.queue.enqueue("email", {
      userId: user.id,
      eventId: f.eventId,
      galleryPath: "/e/demo",
      kind: "ready",
    });
  }

  const loop = runWorkerLoop(f.deps, {
    concurrency: 3,
    stop: () => finished === total,
    idleMs: 20,
    shutdownMs: 1000,
  });
  await waitFor(() => pending.length === 3);
  assert.equal(running, 3);
  assert.equal(peak, 3);
  for (const resolve of pending.splice(0)) resolve();
  await waitFor(() => pending.length === 2);
  for (const resolve of pending.splice(0)) resolve();
  const result = await loop;

  assert.equal(result.claimed, total);
  assert.equal(result.abandoned, 0);
  assert.equal(peak, 3);
  assert.equal(finished, total);
  assert.equal((await f.db.metrics()).jobsQueued, 0);
});

test("the loop claims a match before earlier derives", async () => {
  const f = await fixture();
  const claimedTypes: string[] = [];
  const inner = f.queue;
  f.deps.queue = {
    ...inner,
    async claim() {
      const job = await inner.claim();
      if (job) claimedTypes.push(job.type);
      return job;
    },
  };
  await inner.enqueue("derive", { photoId: randomUUID() });
  await inner.enqueue("derive", { photoId: randomUUID() });
  await inner.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey: "selfies/missing.png",
  });

  const result = await runWorkerLoop(f.deps, {
    concurrency: 1,
    stop: () => claimedTypes.length === 3,
    idleMs: 20,
    shutdownMs: 1000,
  });
  assert.deepEqual(claimedTypes, ["match", "derive", "derive"]);
  assert.equal(result.claimed, 3);
  assert.equal(result.abandoned, 0);
});

test("the loop survives a failing claim and keeps working afterwards", async () => {
  const f = await fixture();
  const inner = f.queue;
  let failures = 0;
  const claimed: string[] = [];
  f.deps.queue = {
    ...inner,
    async claim() {
      if (failures < 2) {
        failures += 1;
        throw new Error("connection reset");
      }
      const job = await inner.claim();
      if (job) claimed.push(job.id);
      return job;
    },
  };
  const silence = console.error;
  console.error = () => undefined;
  try {
    const jobId = await inner.enqueue("email", {
      userId: f.participantId,
      eventId: f.eventId,
      galleryPath: "/e/demo",
      kind: "ready",
    });
    const result = await runWorkerLoop(f.deps, {
      concurrency: 2,
      stop: () => f.mailer.sent.length === 1,
      idleMs: 5,
      shutdownMs: 1000,
    });
    assert.equal(failures, 2);
    assert.deepEqual(claimed, [jobId]);
    assert.equal(result.claimed, 1);
    assert.equal(result.abandoned, 0);
    assert.equal(f.db.jobView(jobId)?.status, "done");
  } finally {
    console.error = silence;
  }
});

test("housekeeping prunes old done jobs and aborts stale uploads", async () => {
  const f = await fixture();
  const old = await f.queue.enqueue("email", {
    userId: f.participantId,
    eventId: f.eventId,
    galleryPath: "/e/demo",
    kind: "ready",
  });
  await f.db.completeJob(old);
  f.db.setJobCreatedAt(old, new Date(Date.now() - 8 * DAY));
  const recent = await f.queue.enqueue("email", {
    userId: f.participantId,
    eventId: f.eventId,
    galleryPath: "/e/demo",
    kind: "new",
  });
  await f.db.completeJob(recent);
  const oldQueued = await f.queue.enqueue("derive", { photoId: randomUUID() });
  f.db.setJobCreatedAt(oldQueued, new Date(Date.now() - 8 * DAY));

  const stale = randomUUID();
  const fresh = randomUUID();
  const base = {
    eventId: f.eventId,
    photographerId: f.photographerId,
    sha256: "c".repeat(64),
    contentType: "image/jpeg" as const,
    bytes: 10,
  };
  await f.db.insertUploadSession({
    ...base,
    id: stale,
    s3UploadId: "mp-stale",
    objectKey: `originals/${f.eventId}/${stale}.jpg`,
  });
  f.db.setUploadCreatedAt(stale, new Date(Date.now() - 25 * HOUR));
  await f.db.insertUploadSession({
    ...base,
    id: fresh,
    s3UploadId: "mp-fresh",
    objectKey: `originals/${f.eventId}/${fresh}.jpg`,
  });

  const result = await runHousekeeping(f.deps);
  assert.equal(result.prunedJobs, 1);
  assert.equal(result.abortedUploads, 1);
  assert.equal(f.db.jobView(old), null);
  assert.equal(f.db.jobView(recent)?.status, "done");
  assert.equal(f.db.jobView(oldQueued)?.status, "queued");
  assert.equal((await f.db.findUploadSession(stale))?.status, "aborted");
  assert.equal((await f.db.findUploadSession(fresh))?.status, "open");
  assert.deepEqual(f.objects.abortedUploads, [
    { key: `originals/${f.eventId}/${stale}.jpg`, uploadId: "mp-stale" },
  ]);

  // Idempotent: a second run finds nothing to do.
  const again = await runHousekeeping(f.deps);
  assert.deepEqual(again, { prunedJobs: 0, abortedUploads: 0 });
});

// Guards the single-part branch of `runHousekeeping`: an interrupted single PUT has no
// multipart upload to abort, so without an explicit `objects.delete` the bytes it already
// stored stay in the bucket forever with nothing to remove them. v6's crowd upload path is
// single-PUT-only, so every abandoned crowd upload leaks an object. If this test fails,
// stale object cleanup has regressed — do not relax it.
test("housekeeping deletes the orphaned object of a stale single-part upload", async () => {
  const f = await fixture();
  const stale = randomUUID();
  const fresh = randomUUID();
  const base = {
    eventId: f.eventId,
    photographerId: f.photographerId,
    sha256: "d".repeat(64),
    contentType: "image/jpeg" as const,
    bytes: 10,
    // No `s3UploadId`: a single presigned PUT, not a multipart upload.
    s3UploadId: null,
  };
  const staleKey = `originals/${f.eventId}/${stale}.jpg`;
  const freshKey = `originals/${f.eventId}/${fresh}.jpg`;
  await f.db.insertUploadSession({ ...base, id: stale, objectKey: staleKey });
  f.db.setUploadCreatedAt(stale, new Date(Date.now() - 25 * HOUR));
  await f.db.insertUploadSession({ ...base, id: fresh, objectKey: freshKey });

  // Both browsers stored their bytes; only the stale one never reached `/complete`.
  await f.objects.put(staleKey, new Uint8Array([1, 2, 3]), "image/jpeg");
  await f.objects.put(freshKey, new Uint8Array([4, 5, 6]), "image/jpeg");

  const result = await runHousekeeping(f.deps);
  assert.equal(result.abortedUploads, 1);
  assert.equal((await f.db.findUploadSession(stale))?.status, "aborted");
  assert.equal((await f.db.findUploadSession(fresh))?.status, "open");
  // The orphan is gone from the bucket...
  assert.equal(f.objects.objects.has(staleKey), false);
  // ...and the upload still in progress is untouched.
  assert.equal(f.objects.objects.has(freshKey), true);
  // Nothing was aborted as a multipart upload: there was no multipart upload.
  assert.deepEqual(f.objects.abortedUploads, []);

  // Idempotent: a second run has nothing left to delete and does not throw on the
  // already-removed key.
  const again = await runHousekeeping(f.deps);
  assert.equal(again.abortedUploads, 0);
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
