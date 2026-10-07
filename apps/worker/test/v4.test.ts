import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createQueue } from "@rephoto/api/queue";
import { objectKeys } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import type {
  FaceEngine,
  LivenessInput,
  LivenessResult,
} from "../../../packages/face-engine/src/types.ts";
import { isNonRetryable, type JobLogEntry, type WorkerDeps } from "../src/handlers.js";
import { pollOnce } from "../src/run.js";
import {
  MemoryObjectStore,
  RecordingMailer,
  drain,
  env,
  sha256,
  solidPng,
  trackingEngine,
} from "./helpers.ts";

type LivenessEngine = ReturnType<typeof trackingEngine> & { livenessCalls: LivenessInput[] };

/** The tracking fake engine plus a scripted `checkLiveness`. */
function livenessEngine(verdict: LivenessResult | Error): LivenessEngine {
  const inner = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
  const livenessCalls: LivenessInput[] = [];
  return {
    ...inner,
    livenessCalls,
    async checkLiveness(input: LivenessInput) {
      livenessCalls.push(input);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  participantId: string;
  objects: MemoryObjectStore;
  mailer: RecordingMailer;
  logs: JobLogEntry[];
  deps: WorkerDeps;
  redId: string;
};

/** A demo event with one indexed red photo and a participant with no gallery yet. */
async function fixture(faces: FaceEngine, livenessCheck: boolean): Promise<Fixture> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const mailer = new RecordingMailer();
  const logs: JobLogEntry[] = [];
  const deps: WorkerDeps = {
    env: { ...env, LIVENESS_CHECK: livenessCheck },
    db,
    objects,
    mailer,
    queue: createQueue(db),
    faces,
    log: (entry) => logs.push(entry),
  };
  const redBytes = new Uint8Array(await solidPng(255, 0, 0));
  const redId = randomUUID();
  await db.insertPhoto({
    id: redId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(redBytes),
    originalKey: objectKeys.original(event.id, redId),
    contentType: "image/png",
    bytes: redBytes.byteLength,
  });
  await objects.put(objectKeys.original(event.id, redId), redBytes, "image/png");
  await deps.queue.enqueue("derive", { photoId: redId });
  await drain(deps);
  assert.equal((await db.findPhoto(redId))?.status, "indexed");
  logs.length = 0;
  return { db, eventId: event.id, participantId: participant.id, objects, mailer, logs, deps, redId };
}

async function submitRedSelfie(f: Fixture): Promise<string> {
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  await f.deps.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey,
  });
  await drain(f.deps);
  return selfieKey;
}

test("match rejects a selfie the engine judges not live: empty gallery, selfie deleted, ready mail", async () => {
  const faces = livenessEngine({ live: false, score: 0.05, method: "silent-face" });
  const f = await fixture(faces, true);
  const selfieKey = await submitRedSelfie(f);

  assert.equal(faces.livenessCalls.length, 1);
  assert.equal(faces.livenessCalls[0]?.contentType, "image/jpeg");
  // The engine saw the shrunk JPEG, not the uploaded PNG.
  assert.deepEqual([...(faces.livenessCalls[0]?.imageBytes.slice(0, 2) ?? [])], [0xff, 0xd8]);
  assert.equal(faces.searchBytes.length, 0, "no search after a rejected liveness check");

  assert.deepEqual(await f.db.listGallery(f.participantId, f.eventId), []);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery);
  assert.deepEqual(gallery.anchorFaceIds, []);
  assert.ok(gallery.matchedAt);
  assert.equal(f.objects.objects.has(selfieKey), false);
  assert.equal(f.mailer.sent.length, 1);
  assert.equal(f.mailer.sent[0]?.subject, "Le tue foto sono pronte");

  const matchLog = f.logs.find((entry) => entry.type === "match");
  assert.equal(matchLog?.outcome, "done");
  assert.equal(matchLog?.liveness, "rejected");
  assert.equal(f.logs.find((entry) => entry.type === "email")?.liveness, undefined);
});

test("match proceeds when the selfie is live", async () => {
  const faces = livenessEngine({ live: true, score: 0.97, method: "silent-face" });
  const f = await fixture(faces, true);
  const selfieKey = await submitRedSelfie(f);

  assert.equal(faces.livenessCalls.length, 1);
  assert.equal(faces.searchBytes.length, 1);
  assert.deepEqual(
    (await f.db.listGallery(f.participantId, f.eventId)).map((item) => item.photoId),
    [f.redId],
  );
  assert.equal(f.objects.objects.has(selfieKey), false);
  assert.equal(f.mailer.sent.length, 1);
  assert.equal(f.logs.find((entry) => entry.type === "match")?.liveness, undefined);
});

test("match skips the liveness check when LIVENESS_CHECK is false or the engine has none", async () => {
  const off = livenessEngine({ live: false, score: 0, method: "silent-face" });
  const f = await fixture(off, false);
  await submitRedSelfie(f);
  assert.equal(off.livenessCalls.length, 0);
  assert.deepEqual(
    (await f.db.listGallery(f.participantId, f.eventId)).map((item) => item.photoId),
    [f.redId],
  );

  const plain = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
  assert.equal(plain.checkLiveness, undefined);
  const g = await fixture(plain, true);
  await submitRedSelfie(g);
  assert.deepEqual(
    (await g.db.listGallery(g.participantId, g.eventId)).map((item) => item.photoId),
    [g.redId],
  );
  assert.equal(g.logs.find((entry) => entry.type === "match")?.outcome, "done");
});

test("a liveness service failure retries the match job and keeps the selfie", async () => {
  const error = new Error("Face service answered 503");
  error.name = "FaceServiceUnavailable";
  const faces = livenessEngine(error);
  const f = await fixture(faces, true);
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  const jobId = await f.deps.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey,
  });
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.logs[0]?.outcome, "retry");
  assert.equal(f.db.jobView(jobId)?.status, "queued");
  assert.equal(f.objects.objects.has(selfieKey), true);
  assert.equal(f.mailer.sent.length, 0);
});

test("a definitive face service answer (4xx) fails the match job at once and drops the selfie", async () => {
  const error = new Error("Face service answered 413") as Error & { status: number };
  error.name = "FaceServiceError";
  error.status = 413;
  const faces = livenessEngine(error);
  const f = await fixture(faces, true);
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  const jobId = await f.deps.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey,
  });
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.logs[0]?.outcome, "error");
  assert.equal(f.db.jobView(jobId)?.status, "error");
  assert.equal(f.objects.objects.has(selfieKey), false);
  assert.equal(f.mailer.sent.length, 0);
});

test("isNonRetryable: FaceServiceError 400/413/422 only; other statuses and FaceServiceUnavailable retry", () => {
  const withStatus = (name: string, status?: number) => {
    const error = new Error(name) as Error & { status?: number };
    error.name = name;
    if (status !== undefined) error.status = status;
    return error;
  };
  for (const status of [400, 413, 422]) {
    assert.equal(isNonRetryable(withStatus("FaceServiceError", status)), true, String(status));
  }
  assert.equal(isNonRetryable(withStatus("FaceServiceError", 429)), false);
  assert.equal(isNonRetryable(withStatus("FaceServiceError")), false);
  assert.equal(isNonRetryable(withStatus("FaceServiceUnavailable", 503)), false);
});
