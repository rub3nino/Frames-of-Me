/**
 * v6 G (agent G): the retention scheduler and what the `retention` job covers in v6.
 *
 * - the scheduler enqueues one `retention` job per event per window, and nothing on a second
 *   tick inside the same window, even when several workers tick at once;
 * - a failed enqueue is recorded and raises the alarm on the next tick, as does a window
 *   that went by with nothing claimed (`skipped`) and a job that ended in `error`;
 * - the job honours `albums.retention_days` per album, shorter *and* longer than the event's;
 * - a crowd album is covered like any other (its photos and objects go) and needs no engine
 *   call, because it never held a vector;
 * - a `match` job whose consent was withdrawn while it sat in the queue does nothing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { objectKeys, type Env } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { runRetentionScheduler } from "../src/retention-scheduler.js";
import {
  MemoryObjectStore,
  RecordingMailer,
  drain,
  env,
  quiet,
  solidPng,
  storePhoto,
  trackingEngine,
  type TrackingEngine,
} from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  participantId: string;
  officialAlbumId: string;
  crowdAlbumId: string;
  objects: MemoryObjectStore;
  faces: TrackingEngine;
  queue: JobQueue;
  deps: WorkerDeps;
};

async function fixture(overrides: Partial<Env> = {}): Promise<Fixture> {
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
  const faces = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env: { ...env, ...overrides },
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

/** Uploads a photo into an album, runs the pipeline, and backdates it by `ageDays`. */
async function ingest(
  f: Fixture,
  albumId: string,
  ageDays: number,
  rgb: [number, number, number] = [200, 10, 30],
): Promise<string> {
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
  if (ageDays > 0) f.db.setPhotoCreatedAt(photoId, new Date(Date.now() - ageDays * DAY_MS));
  return photoId;
}

function retentionJobIds(f: Fixture): string[] {
  return f.db.jobIdsByType("retention");
}

test("the scheduler enqueues one retention job per event per window, and audits it", async () => {
  const f = await fixture();
  const first = await runRetentionScheduler(f.deps);
  assert.deepEqual(first.claimed, [f.eventId]);
  assert.equal(first.enqueued, 1);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.alarms, []);
  assert.equal(retentionJobIds(f).length, 1);

  const state = f.db.retentionScheduleOf(f.eventId);
  assert.ok(state);
  assert.equal(state.runs, 1);
  assert.equal(state.lastOutcome, "enqueued");
  assert.equal(state.windowSeconds, 24 * 3600);
  assert.ok(state.lastJobId, "the job id is recorded for the status screen");

  // A second tick inside the same window: nothing at all.
  const second = await runRetentionScheduler(f.deps);
  assert.deepEqual(second.claimed, []);
  assert.equal(second.enqueued, 0);
  assert.equal(retentionJobIds(f).length, 1);
  assert.equal(f.db.retentionScheduleOf(f.eventId)?.runs, 1);

  // The next window: one more run.
  const nextWindow = new Date(Date.now() + DAY_MS);
  const third = await runRetentionScheduler(f.deps, nextWindow);
  assert.deepEqual(third.claimed, [f.eventId]);
  assert.equal(f.db.retentionScheduleOf(f.eventId)?.runs, 2);
});

test("concurrent ticks claim the window once; the queue dedupe is the second guard", async () => {
  const f = await fixture();
  const runs = await Promise.all([
    runRetentionScheduler(f.deps),
    runRetentionScheduler(f.deps),
    runRetentionScheduler(f.deps),
  ]);
  assert.equal(
    runs.reduce((total, run) => total + run.claimed.length, 0),
    1,
    "exactly one of the three ticks claimed the window",
  );
  assert.equal(retentionJobIds(f).length, 1);
});

test("RETENTION_SCHEDULER=false makes the tick a no-op", async () => {
  const f = await fixture({ RETENTION_SCHEDULER: false });
  const run = await runRetentionScheduler(f.deps);
  assert.equal(run.windowStart, null);
  assert.deepEqual(run.claimed, []);
  assert.equal(retentionJobIds(f).length, 0);
  assert.equal(f.db.retentionScheduleOf(f.eventId), undefined);
});

test("a failed enqueue is recorded as failed and raises the alarm on the next tick", async () => {
  const f = await fixture();
  const broken: WorkerDeps = {
    ...f.deps,
    queue: {
      ...f.queue,
      async enqueue() {
        throw new Error("coda non disponibile");
      },
    },
  };
  const run = await runRetentionScheduler(broken);
  assert.deepEqual(run.claimed, [f.eventId]);
  assert.equal(run.enqueued, 0);
  assert.equal(run.failed, 1);
  const state = f.db.retentionScheduleOf(f.eventId);
  assert.equal(state?.lastOutcome, "failed");
  assert.equal(state?.lastError, "coda non disponibile");

  // Next window, working queue: the alarm of the failed run is reported before the new claim.
  const next = await runRetentionScheduler(f.deps, new Date(Date.now() + DAY_MS));
  assert.deepEqual(
    next.alarms.map((alarm) => alarm.alarm),
    ["failed"],
  );
  assert.equal(next.enqueued, 1, "and the new window still runs");
});

test("a window with no run at all is reported as skipped", async () => {
  const f = await fixture();
  await runRetentionScheduler(f.deps);
  // Two windows went by with the worker down.
  f.db.setRetentionClaimedAt(f.eventId, new Date(Date.now() - 3 * DAY_MS));
  const run = await runRetentionScheduler(f.deps, new Date(Date.now() + DAY_MS));
  assert.deepEqual(
    run.alarms.map((alarm) => alarm.alarm),
    ["skipped"],
  );
});

test("a retention job that ended in error raises the alarm", async () => {
  const f = await fixture();
  await runRetentionScheduler(f.deps);
  const jobId = retentionJobIds(f)[0];
  assert.ok(jobId);
  f.db.setJobStatus(jobId, "error");
  const run = await runRetentionScheduler(f.deps, new Date(Date.now() + DAY_MS));
  assert.deepEqual(
    run.alarms.map((alarm) => alarm.alarm),
    ["job_error"],
  );
});

test("retention honours albums.retention_days, shorter and longer than the event's", async () => {
  const f = await fixture();
  // The event keeps photos 90 days; the crowd album only 7, a second official album 365.
  await f.db.updateAlbum(f.crowdAlbumId, { retentionDays: 7 });
  const archive = await f.db.createAlbum({
    eventId: f.eventId,
    slug: "archivio",
    name: "Archivio",
    kind: "official",
    recognition: true,
    retentionDays: 365,
  });

  const freshOfficial = await ingest(f, f.officialAlbumId, 10);
  const oldOfficial = await ingest(f, f.officialAlbumId, 100);
  const freshCrowd = await ingest(f, f.crowdAlbumId, 3);
  const oldCrowd = await ingest(f, f.crowdAlbumId, 10);
  const archived = await ingest(f, archive.id, 100);

  await f.queue.enqueue("retention", { eventId: f.eventId, actorId: null });
  await drain(f.deps);

  assert.ok(await f.db.findPhoto(freshOfficial), "10 days old, event retention 90: stays");
  assert.equal(await f.db.findPhoto(oldOfficial), null, "100 days old: gone");
  assert.ok(await f.db.findPhoto(freshCrowd), "3 days old, album retention 7: stays");
  assert.equal(await f.db.findPhoto(oldCrowd), null, "10 days old in a 7-day album: gone");
  assert.ok(
    await f.db.findPhoto(archived),
    "100 days old in a 365-day album: the album's longer retention wins over the event's",
  );
});

test("retention deletes a crowd upload with its objects and without touching the engine", async () => {
  const f = await fixture();
  await f.db.updateAlbum(f.crowdAlbumId, { retentionDays: 7 });
  const photoId = await ingest(f, f.crowdAlbumId, 30);
  const photo = await f.db.findPhoto(photoId);
  assert.ok(photo);
  const derivatives = (await f.db.listDerivatives(photoId)).map((row) => row.s3Key);
  assert.ok(derivatives.length > 0, "a crowd photo still gets its thumb and web");
  assert.deepEqual(await f.db.listExternalIds(photoId), [], "and never a vector");
  f.faces.deletedFaceIds.length = 0;

  await f.queue.enqueue("retention", { eventId: f.eventId, actorId: null });
  await drain(f.deps);

  assert.equal(await f.db.findPhoto(photoId), null);
  assert.equal(f.objects.objects.has(photo.originalKey), false, "the original is deleted");
  for (const key of derivatives) {
    assert.equal(f.objects.objects.has(key), false, "and so are the derivatives");
  }
  assert.deepEqual(
    f.faces.deletedFaceIds.filter((ids) => ids.length > 0),
    [],
    "no face to delete from the engine: a crowd album is not biometric",
  );
});

test("a match job stops when the consent was withdrawn while it waited in the queue", async () => {
  const f = await fixture();
  await ingest(f, f.officialAlbumId, 0);
  await f.db.insertConsent({
    userId: f.participantId,
    eventId: f.eventId,
    textVersion: "2026-10-08",
    ip: "203.0.113.7",
    userAgent: "test",
  });
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(200, 10, 30)), "image/png");
  await f.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey,
  });
  // The participant withdraws before the worker gets to the job.
  await f.db.withdrawConsent({ userId: f.participantId, eventId: f.eventId });
  f.faces.searchBytes.length = 0;

  await drain(f.deps);

  assert.equal(await f.db.findGalleryByUser(f.participantId, f.eventId), null, "no gallery rebuilt");
  assert.equal(f.objects.objects.has(selfieKey), false, "the selfie object is deleted");
  assert.deepEqual(f.faces.searchBytes, [], "the engine never saw the selfie");

  // After a new consent the same pipeline works again.
  await f.db.insertConsent({
    userId: f.participantId,
    eventId: f.eventId,
    textVersion: "2026-10-08",
    ip: "203.0.113.7",
    userAgent: "test",
  });
  const again = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(again, new Uint8Array(await solidPng(200, 10, 30)), "image/png");
  await f.queue.enqueue("match", { userId: f.participantId, eventId: f.eventId, selfieKey: again });
  await drain(f.deps);
  assert.ok(
    await f.db.findGalleryByUser(f.participantId, f.eventId),
    "re-consent restores the search",
  );
});
