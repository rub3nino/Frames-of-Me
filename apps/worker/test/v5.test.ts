import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createQueue, type JobQueue } from "@rephoto/api/queue";
import { JOB_PRIORITY, objectKeys, type Env, type LivenessAction } from "@rephoto/contracts";
import { MemoryDatabase, type Database } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
  fakeEmbedding,
} from "../../../packages/face-engine/src/fake.ts";
import type {
  EmbedSelfieResult,
  FaceEngine,
  SelfieFace,
  VectorHit,
} from "../../../packages/face-engine/src/types.ts";
import { FaceServiceBreaker } from "../src/breaker.js";
import {
  applyFinalFailure,
  selfieRejectReason,
  type JobLogEntry,
  type WorkerDeps,
} from "../src/handlers.js";
import { pollOnce, processJob } from "../src/run.js";
import {
  MemoryObjectStore,
  RecordingMailer,
  drain,
  env,
  sameBytes,
  sha256,
  solidPng,
  storePhoto,
  stubEngine,
  trackingEngine,
} from "./helpers.ts";

type Fixture = {
  db: MemoryDatabase;
  eventId: string;
  photographerId: string;
  participantId: string;
  objects: MemoryObjectStore;
  mailer: RecordingMailer;
  faces: ReturnType<typeof trackingEngine>;
  queue: JobQueue;
  logs: JobLogEntry[];
  deps: WorkerDeps;
};

async function fixture(
  envOverrides: Partial<Env> = {},
  engine?: FaceEngine,
): Promise<Fixture> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({ email: "shooter@example.com", role: "photographer" });
  const participant = await db.createUser({ email: "guest@example.com", role: "participant" });
  const objects = new MemoryObjectStore();
  const mailer = new RecordingMailer();
  const faces = trackingEngine(engine ?? new FakeFaceEngine(new MemoryFaceIndexStore()));
  const queue = createQueue(db);
  const logs: JobLogEntry[] = [];
  const deps: WorkerDeps = {
    env: { ...env, ...envOverrides },
    db,
    objects,
    mailer,
    queue,
    faces,
    log: (entry) => logs.push(entry),
  };
  return {
    db,
    eventId: event.id,
    photographerId: photographer.id,
    participantId: participant.id,
    objects,
    mailer,
    faces,
    queue,
    logs,
    deps,
  };
}

let photoSize = 8;

/** Uploads a solid photo and runs derive → index → attach (distinct sizes keep sha256s apart). */
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

/** Stores a selfie and runs match (→ email); returns the selfie key. */
async function selfie(f: Fixture, rgb: [number, number, number]): Promise<string> {
  const selfieKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(selfieKey, new Uint8Array(await solidPng(...rgb)), "image/png");
  await f.queue.enqueue("match", { userId: f.participantId, eventId: f.eventId, selfieKey });
  await drain(f.deps);
  return selfieKey;
}

function selfieFace(overrides: Partial<SelfieFace> = {}): SelfieFace {
  return {
    bbox: { left: 0.25, top: 0.2, width: 0.5, height: 0.6 },
    score: 0.99,
    quality: 0.9,
    embedding: fakeEmbedding(255, 0, 0),
    ...overrides,
  };
}

/** An engine whose `embedSelfie` and `searchByVector` are scripted. */
function scriptedEngine(embedded: EmbedSelfieResult, hits: VectorHit[] = []): FaceEngine {
  return stubEngine({
    async embedSelfie() {
      return embedded;
    },
    async searchByVector() {
      return hits;
    },
  });
}

// ---- A1: selfie gate ------------------------------------------------------------------------

test("selfieRejectReason: no face, too small, low quality, two people, in that order", () => {
  const gate = { SELFIE_MIN_FACE_PX: 120, SELFIE_MIN_QUALITY: 0.6 };
  assert.equal(selfieRejectReason({ faces: [], width: 1000, height: 1000 }, gate), "no_face");
  assert.equal(
    selfieRejectReason(
      { faces: [selfieFace({ bbox: { left: 0, top: 0, width: 0.1, height: 0.1 } })], width: 1000, height: 1000 },
      gate,
    ),
    "face_too_small",
  );
  // 0.1 × 1200 = 120 px on the long edge: just enough.
  assert.equal(
    selfieRejectReason(
      { faces: [selfieFace({ bbox: { left: 0, top: 0, width: 0.1, height: 0.05 } })], width: 1200, height: 800 },
      gate,
    ),
    null,
  );
  // Unknown size (0×0): the size gate is skipped, the quality gate still applies.
  assert.equal(selfieRejectReason({ faces: [selfieFace({ quality: 0.59 })], width: 0, height: 0 }, gate), "low_quality");
  assert.equal(
    selfieRejectReason(
      {
        faces: [
          selfieFace(),
          selfieFace({ bbox: { left: 0.6, top: 0.2, width: 0.36, height: 0.42 } }), // 0.1512 ≥ 0.5 × 0.3
        ],
        width: 1000,
        height: 1000,
      },
      gate,
    ),
    "multiple_faces",
  );
  assert.equal(
    selfieRejectReason(
      {
        faces: [selfieFace(), selfieFace({ bbox: { left: 0.8, top: 0.8, width: 0.2, height: 0.2 } })], // 0.04 < 0.15
        width: 1000,
        height: 1000,
      },
      gate,
    ),
    null,
  );
});

test("match rejects a bad selfie: empty gallery with the reason, selfie deleted, no mail, no search", async () => {
  const cases: Array<{ embedded: EmbedSelfieResult; reason: string }> = [
    { embedded: { faces: [], width: 800, height: 600 }, reason: "no_face" },
    {
      embedded: { faces: [selfieFace({ bbox: { left: 0, top: 0, width: 0.1, height: 0.1 } })], width: 800, height: 600 },
      reason: "face_too_small",
    },
    { embedded: { faces: [selfieFace({ quality: 0.2 })], width: 800, height: 600 }, reason: "low_quality" },
    {
      embedded: { faces: [selfieFace(), selfieFace({ bbox: { left: 0.5, top: 0.2, width: 0.5, height: 0.6 } })], width: 800, height: 600 },
      reason: "multiple_faces",
    },
  ];
  for (const { embedded, reason } of cases) {
    const f = await fixture({}, scriptedEngine(embedded, [{ externalFaceId: "x", photoId: "p", similarity: 100, cosine: 0.9 }]));
    const selfieKey = await selfie(f, [255, 0, 0]);
    assert.deepEqual(await f.db.listGallery(f.participantId, f.eventId), [], reason);
    const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
    assert.ok(gallery, reason);
    assert.equal(gallery.reason, reason);
    assert.deepEqual(gallery.anchorFaceIds, []);
    assert.equal(gallery.hasQueryVector, false, "no vector stored for a rejected selfie");
    assert.equal(f.objects.objects.has(selfieKey), false, "selfie deleted");
    assert.equal(f.mailer.sent.length, 0, "no ready mail");
    assert.equal(f.faces.vectorSearches.length, 0, "no search after a rejection");
    const log = f.logs.find((entry) => entry.type === "match");
    assert.equal(log?.outcome, "done");
    assert.equal(log?.match, "rejected");
    assert.equal(log?.reason, reason);
  }
});

test("match keeps every hit ≥ MIN but anchors only those ≥ ANCHOR_MIN (default SURE), best first, max five", async () => {
  const f = await fixture({}, scriptedEngine({ faces: [selfieFace()], width: 800, height: 600 }));
  // Seven indexed photos, one face each; the engine answers with scripted cosines.
  const photoIds: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const photoId = await storePhoto(f.deps, {
      eventId: f.eventId,
      photographerId: f.photographerId,
      bytes: new Uint8Array(await solidPng(10 * index, 20, 30, 8 + 8 * index)),
    });
    await f.db.replaceFaces(photoId, f.eventId, [
      { externalId: `ext-${index}`, bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
    ]);
    await f.db.setPhotoIndexed(photoId);
    photoIds.push(photoId);
  }
  const cosines = [0.95, 0.9, 0.85, 0.8, 0.75, 0.72, 0.6];
  const hits: VectorHit[] = cosines.map((cosine, index) => ({
    externalFaceId: `ext-${index}`,
    photoId: photoIds[index] as string,
    similarity: 80 + 20 * Math.min(1, (cosine - 0.5) / 0.2),
    cosine,
  }));
  // Below MIN: must never enter the gallery even when the engine returns it (MATCH_LOG asks for 0.25).
  hits.push({ externalFaceId: "ext-0", photoId: photoIds[0] as string, similarity: 0, cosine: 0.3 });
  (f.faces as FaceEngine).searchByVector = async () => hits;

  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery);
  assert.equal(gallery.reason, null);
  assert.equal(gallery.hasQueryVector, true);
  assert.deepEqual(gallery.anchorFaceIds, ["ext-0", "ext-1", "ext-2", "ext-3", "ext-4"], "six are ≥ 0.7, five kept");
  const items = await f.db.listGallery(f.participantId, f.eventId);
  assert.equal(items.length, 7, "all seven are ≥ MIN 0.5");
  assert.equal(f.mailer.sent.length, 1);

  // With a higher anchor floor only the sure ones anchor.
  const g = await fixture({ INSIGHTFACE_ANCHOR_MIN_COSINE: 0.9 }, scriptedEngine({ faces: [selfieFace()], width: 800, height: 600 }, []));
  for (const [index, photoId] of photoIds.entries()) {
    await g.db.insertPhoto({
      id: photoId,
      eventId: g.eventId,
      photographerId: g.photographerId,
      sha256: `sha-${index}`,
      originalKey: objectKeys.original(g.eventId, photoId),
      contentType: "image/png",
      bytes: 10,
    });
    await g.db.replaceFaces(photoId, g.eventId, [
      { externalId: `ext-${index}`, bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
    ]);
    await g.db.setPhotoIndexed(photoId);
  }
  (g.faces as FaceEngine).searchByVector = async () => hits;
  await selfie(g, [255, 0, 0]);
  assert.deepEqual((await g.db.findGalleryByUser(g.participantId, g.eventId))?.anchorFaceIds, ["ext-0", "ext-1"]);
});

test("a selfie before any photo stores its vector (no_photos_yet) and a later photo attaches through it", async () => {
  const f = await fixture();
  await selfie(f, [255, 0, 0]);
  let gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(gallery);
  assert.equal(gallery.reason, "no_photos_yet");
  assert.deepEqual(gallery.anchorFaceIds, []);
  assert.equal(gallery.hasQueryVector, true);
  assert.deepEqual(f.db.galleryQueryVector(f.participantId, f.eventId), fakeEmbedding(255, 0, 0));
  assert.equal(await f.db.countAnchoredGalleries(f.eventId), 1, "a vector counts as anchored");
  assert.equal(f.mailer.sent.length, 1, "the ready mail still goes out");

  const red = await ingest(f, [255, 0, 0]);
  const blue = await ingest(f, [0, 0, 255]);
  const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.deepEqual(
    page.items.map((item) => [item.photoId, item.source, item.score]),
    [[red, "attach", 1]],
  );
  assert.equal(page.items.some((item) => item.photoId === blue), false);
  // A later successful match clears the reason and sets anchors as usual.
  await selfie(f, [255, 0, 0]);
  gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, null);
  assert.deepEqual(gallery?.anchorFaceIds, [`fake-${red}`]);
});

test("attach skips the selfie-vector search while no gallery of the event stores a vector", async () => {
  const f = await fixture();
  const inner = f.faces as FaceEngine;
  let embeddingReads = 0;
  const faceEmbedding = inner.faceEmbedding?.bind(inner);
  assert.ok(faceEmbedding);
  inner.faceEmbedding = (input) => {
    embeddingReads += 1;
    return faceEmbedding(input);
  };
  const red = await ingest(f, [255, 0, 0]);
  // Anchors only, no vector: the second photo attaches through the anchor, no embedding read.
  await f.db.replaceGallery(f.participantId, f.eventId, [], [`fake-${red}`]);
  assert.equal(await f.db.countGalleriesWithQueryVector(f.eventId), 0);
  const later = await ingest(f, [255, 0, 0]);
  assert.equal(embeddingReads, 0);
  assert.equal(
    (await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 })).items.some((item) => item.photoId === later),
    true,
  );
  // A stored vector turns the path on.
  await f.db.updateGalleryMatch(f.participantId, f.eventId, { queryEmbedding: fakeEmbedding(255, 0, 0) });
  assert.equal(await f.db.countGalleriesWithQueryVector(f.eventId), 1);
  await ingest(f, [255, 0, 0]);
  assert.equal(embeddingReads, 1);
});

test("attach: with three or more anchors a single agreeing anchor is not enough, two are", async () => {
  const f = await fixture();
  const participant = f.participantId;
  const red = await ingest(f, [255, 0, 0]);
  await f.db.replaceGallery(participant, f.eventId, [], [`fake-${red}`, "ghost-1", "ghost-2"]);
  // Only `fake-red` agrees (1 of 3): the new red photo must not attach through anchors alone.
  const later = await ingest(f, [255, 0, 0]);
  assert.equal(
    (await f.db.listGalleryPage(participant, f.eventId, { limit: 10 })).items.some((item) => item.photoId === later),
    false,
  );
  // Two agreeing anchors: attach.
  await f.db.replaceGallery(participant, f.eventId, [], [`fake-${red}`, `fake-${later}`, "ghost-1"]);
  const third = await ingest(f, [255, 0, 0]);
  assert.equal(
    (await f.db.listGalleryPage(participant, f.eventId, { limit: 10 })).items.some((item) => item.photoId === third),
    true,
  );
});

// ---- MATCH_LOG / KEEP_SELFIES ---------------------------------------------------------------

test("MATCH_LOG writes one run per match with every hit, the engine asked down to 0.25", async () => {
  const f = await fixture({ MATCH_LOG: true });
  const red = await ingest(f, [255, 0, 0]);
  await ingest(f, [0, 0, 255]);
  const selfieKey = await selfie(f, [255, 0, 0]);
  assert.equal(f.faces.vectorSearches[0]?.minCosine, 0.25);
  const runs = f.db.matchLogOf(f.eventId);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.ok(run);
  assert.equal(run.userId, f.participantId);
  assert.equal(run.reason, null);
  assert.equal(run.liveness, null);
  assert.equal(run.selfieFaces, 1);
  assert.equal(run.hits, 1);
  assert.ok((run.engineMs ?? -1) >= 0);
  assert.equal(run.selfieSha256?.length, 64);
  assert.deepEqual(
    run.hitRows.map((hit) => [hit.photoId, hit.externalFaceId, hit.cosine, hit.kept]),
    [[red, `fake-${red}`, 1, true]],
  );
  assert.equal(f.objects.objects.has(selfieKey), false);

  // A rejected selfie is logged too, with its reason and zero hits.
  const g = await fixture({ MATCH_LOG: true }, scriptedEngine({ faces: [], width: 10, height: 10 }));
  await selfie(g, [255, 0, 0]);
  const rejected = g.db.matchLogOf(g.eventId)[0];
  assert.equal(rejected?.reason, "no_face");
  assert.equal(rejected?.selfieFaces, 0);
  assert.equal(rejected?.hits, 0);

  // Off by default: nothing written.
  const h = await fixture();
  await selfie(h, [255, 0, 0]);
  assert.equal(h.db.matchLogOf(h.eventId).length, 0);
  assert.equal(h.faces.vectorSearches[0]?.minCosine, 0.5);
});

test("KEEP_SELFIES keeps the selfie object and records its key on the gallery, also on a rejection", async () => {
  const f = await fixture({ KEEP_SELFIES: true });
  await ingest(f, [255, 0, 0]);
  const selfieKey = await selfie(f, [255, 0, 0]);
  assert.equal(f.objects.objects.has(selfieKey), true);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.selfieKey, selfieKey);

  const g = await fixture({ KEEP_SELFIES: true }, scriptedEngine({ faces: [], width: 10, height: 10 }));
  const rejectedKey = await selfie(g, [255, 0, 0]);
  assert.equal(g.objects.objects.has(rejectedKey), true);
  assert.equal((await g.db.findGalleryByUser(g.participantId, g.eventId))?.selfieKey, rejectedKey);

  const h = await fixture();
  const gone = await selfie(h, [255, 0, 0]);
  assert.equal(h.objects.objects.has(gone), false);
  assert.equal((await h.db.findGalleryByUser(h.participantId, h.eventId))?.selfieKey, null);
});

test("KEEP_SELFIES: a new selfie replaces the kept object; a rematch with the stored key keeps it", async () => {
  const f = await fixture({ KEEP_SELFIES: true });
  await ingest(f, [255, 0, 0]);
  const first = await selfie(f, [255, 0, 0]);
  const second = await selfie(f, [255, 0, 0]);
  assert.notEqual(first, second);
  assert.equal(f.objects.objects.has(first), false, "the previously kept selfie is gone");
  assert.equal(f.objects.objects.has(second), true);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.selfieKey, second);

  // Admin rematch: the job carries the stored key itself, which must survive.
  await f.queue.enqueue("match", { userId: f.participantId, eventId: f.eventId, selfieKey: second });
  await drain(f.deps);
  assert.equal(f.objects.objects.has(second), true);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.selfieKey, second);

  // Same on a rejection: the rejected selfie is the one kept, the earlier one goes.
  const g = await fixture({ KEEP_SELFIES: true });
  await ingest(g, [255, 0, 0]);
  const accepted = await selfie(g, [255, 0, 0]);
  g.deps.faces = { ...g.faces, ...scriptedEngine({ faces: [], width: 10, height: 10 }) };
  const rejected = await selfie(g, [255, 0, 0]);
  assert.equal(g.objects.objects.has(accepted), false);
  assert.equal(g.objects.objects.has(rejected), true);
  assert.equal((await g.db.findGalleryByUser(g.participantId, g.eventId))?.selfieKey, rejected);
});

test("KEEP_SELFIES: a match that fails for good keeps its selfie and records it on the gallery", async () => {
  const f = await fixture({ KEEP_SELFIES: true });
  await ingest(f, [255, 0, 0]);
  const earlier = await selfie(f, [255, 0, 0]);
  const failedKey = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(failedKey, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  await applyFinalFailure(
    { type: "match", userId: f.participantId, eventId: f.eventId, selfieKey: failedKey },
    f.deps,
    "Face service answered 413",
  );
  assert.equal(f.objects.objects.has(failedKey), true, "kept for inspection");
  assert.equal(f.objects.objects.has(earlier), false, "the previously kept selfie is gone");
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.selfieKey, failedKey);

  // Without KEEP_SELFIES the failed job's selfie is deleted and nothing is recorded.
  const g = await fixture();
  const dropped = objectKeys.selfie(g.eventId, g.participantId, randomUUID());
  await g.objects.put(dropped, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  await applyFinalFailure(
    { type: "match", userId: g.participantId, eventId: g.eventId, selfieKey: dropped },
    g.deps,
    "Face service answered 413",
  );
  assert.equal(g.objects.objects.has(dropped), false);
  assert.equal(await g.db.findGalleryByUser(g.participantId, g.eventId), null);
});

test("reset deletes the selfies kept with KEEP_SELFIES", async () => {
  const f = await fixture({ KEEP_SELFIES: true });
  await ingest(f, [255, 0, 0]);
  const selfieKey = await selfie(f, [255, 0, 0]);
  assert.equal(f.objects.objects.has(selfieKey), true);
  const admin = await f.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  await f.queue.enqueue("reset", { eventId: f.eventId, actorId: admin.id });
  await drain(f.deps);
  assert.equal(f.objects.objects.has(selfieKey), false);
  assert.equal(f.objects.objects.size, 0, "originals, derivatives and kept selfie all gone");
  assert.equal(await f.db.findGalleryByUser(f.participantId, f.eventId), null);
});

test("retention clears the selfie vector, anchors and kept selfie of galleries matched before the cutoff", async () => {
  const f = await fixture({ KEEP_SELFIES: true });
  await ingest(f, [255, 0, 0]);
  const oldKey = await selfie(f, [255, 0, 0]);
  const recent = await f.db.createUser({ email: "recent@example.com", role: "participant" });
  const recentKey = objectKeys.selfie(f.eventId, recent.id, randomUUID());
  await f.objects.put(recentKey, new Uint8Array(await solidPng(255, 0, 0)), "image/png");
  await f.queue.enqueue("match", { userId: recent.id, eventId: f.eventId, selfieKey: recentKey });
  await drain(f.deps);
  const before = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(before?.hasQueryVector, true);
  assert.equal(before?.anchorFaceIds.length, 1);
  assert.equal(before?.selfieKey, oldKey);
  f.db.setGalleryMatchedAt(f.participantId, f.eventId, new Date(0));

  const admin = await f.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  await f.queue.enqueue("retention", { eventId: f.eventId, actorId: admin.id });
  await drain(f.deps);
  const expired = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.ok(expired, "the gallery row stays");
  assert.equal(expired.hasQueryVector, false);
  assert.deepEqual(expired.anchorFaceIds, []);
  assert.equal(expired.selfieKey, null);
  assert.equal(f.objects.objects.has(oldKey), false, "the kept selfie object is deleted");
  // A gallery matched today keeps everything (and so does the photo: it is younger than the cutoff).
  const kept = await f.db.findGalleryByUser(recent.id, f.eventId);
  assert.equal(kept?.hasQueryVector, true);
  assert.equal(kept?.anchorFaceIds.length, 1);
  assert.equal(kept?.selfieKey, recentKey);
  assert.equal(f.objects.objects.has(recentKey), true);
  assert.equal(await f.db.countPhotos(f.eventId), 1);
  // Memory parity with the SQL: nothing to expire returns no keys.
  assert.deepEqual(await f.db.expireGalleryMatches(f.eventId, new Date(0)), []);
});

// ---- A2 / A3: re-index and detection source -------------------------------------------------

test("re-index drops the old anchors before replacing the faces", async () => {
  const f = await fixture();
  const red = await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  assert.deepEqual((await f.db.findGalleryByUser(f.participantId, f.eventId))?.anchorFaceIds, [`fake-${red}`]);
  await f.db.setPhotoStatus(red, "processing");
  await f.queue.enqueue("index", { photoId: red });
  await drain(f.deps);
  assert.deepEqual(f.faces.deletedFaceIds, [[`fake-${red}`]]);
  // The fake re-issues the same external id, so the anchor is gone but the gallery stays.
  assert.deepEqual((await f.db.findGalleryByUser(f.participantId, f.eventId))?.anchorFaceIds, []);
  assert.equal((await f.db.findPhoto(red))?.status, "indexed");
});

test("FACE_INDEX_SOURCE=original sends a detection JPEG rendered from the original, web otherwise", async () => {
  const original = new Uint8Array(await solidPng(200, 40, 40, 64));
  const run = async (overrides: Partial<Env>) => {
    const f = await fixture(overrides);
    const photoId = await storePhoto(f.deps, { eventId: f.eventId, photographerId: f.photographerId, bytes: original });
    await f.queue.enqueue("derive", { photoId });
    await drain(f.deps);
    const web = await f.objects.get(objectKeys.web(photoId));
    assert.ok(web);
    const sent = f.faces.indexedBytes[0];
    assert.ok(sent);
    return { sent, web: web.body, f };
  };
  const byWeb = await run({ FACE_INDEX_SOURCE: "web" });
  assert.ok(sameBytes(byWeb.sent, byWeb.web), "web source: the stored derivative bytes");

  const byOriginal = await run({ FACE_INDEX_SOURCE: "original", FACE_DETECT_LONG_EDGE: 2560 });
  assert.equal(sameBytes(byOriginal.sent, byOriginal.web), false, "original source: a fresh render");
  assert.deepEqual([...byOriginal.sent.slice(0, 2)], [0xff, 0xd8], "a JPEG");
  const meta = await sharp(Buffer.from(byOriginal.sent)).metadata();
  assert.equal(meta.width, 64, "no enlargement past the original");
  assert.equal(byOriginal.f.objects.objects.size, 3, "nothing cached: original, thumb, web only");

  // The env default follows the engine: fake → web, insightface → original.
  assert.equal(env.FACE_INDEX_SOURCE, "web");
});

// ---- B: robustness --------------------------------------------------------------------------

function unavailable(): Error {
  const error = new Error("Face service answered 503");
  error.name = "FaceServiceUnavailable";
  return error;
}

async function indexableJpeg(f: Fixture): Promise<string> {
  const photoId = randomUUID();
  const jpeg = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer());
  await f.db.insertPhoto({
    id: photoId,
    eventId: f.eventId,
    photographerId: f.photographerId,
    sha256: `${sha256(jpeg)}-${photoId}`,
    originalKey: objectKeys.original(f.eventId, photoId),
    contentType: "image/jpeg",
    bytes: jpeg.byteLength,
  });
  await f.objects.put(objectKeys.web(photoId), jpeg, "image/jpeg");
  return photoId;
}

test("FaceServiceUnavailable requeues without burning attempts; five in a row open the breaker for 30 s", async () => {
  let now = 1_000_000;
  const breaker = new FaceServiceBreaker({ now: () => now });
  const f = await fixture({}, stubEngine({
    async indexPhoto() {
      throw unavailable();
    },
  }));
  f.deps.breaker = breaker;
  const photoId = await indexableJpeg(f);
  const jobId = await f.queue.enqueue("index", { photoId });
  const emailId = await f.queue.enqueue("email", {
    userId: f.participantId,
    eventId: f.eventId,
    galleryPath: "/e/demo",
    kind: "ready",
  });
  // The email (priority 10) runs first and succeeds; it is not a face job so it never touches the breaker.
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.db.jobView(emailId)?.status, "done");
  for (let step = 0; step < 5; step += 1) {
    f.db.makeJobDue(jobId);
    assert.equal(await pollOnce(f.deps), true, `claim ${step}`);
    assert.equal(f.logs.at(-1)?.outcome, "requeued");
    assert.equal(f.db.jobView(jobId)?.attempts, 0);
    assert.equal(f.db.jobView(jobId)?.status, "queued");
  }
  assert.equal(breaker.isOpen(), true, "open after the fifth unavailable");
  f.db.makeJobDue(jobId);
  assert.equal(await pollOnce(f.deps), false, "face jobs are not claimed while open");
  assert.equal(f.db.jobView(jobId)?.status, "queued");
  // Other job types still flow.
  const otherEmail = await f.queue.enqueue("email", {
    userId: f.participantId,
    eventId: f.eventId,
    galleryPath: "/e/demo",
    kind: "new",
  });
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.db.jobView(otherEmail)?.status, "done");
  assert.equal(f.db.jobView(jobId)?.status, "queued");
  // 30 s later the breaker closes and the index job is claimed again.
  now += 30_001;
  assert.equal(breaker.isOpen(), false);
  assert.equal(await pollOnce(f.deps), true);
  assert.equal(f.logs.at(-1)?.type, "index");
  assert.equal(f.db.jobView(jobId)?.attempts, 0);
  assert.notEqual((await f.db.findPhoto(photoId))?.status, "error");
});

test("a successful face job resets the breaker's count", () => {
  const breaker = new FaceServiceBreaker({ threshold: 3, pauseMs: 100, now: () => 0 });
  assert.equal(breaker.recordUnavailable(), false);
  assert.equal(breaker.recordUnavailable(), false);
  breaker.recordSuccess();
  assert.equal(breaker.recordUnavailable(), false);
  assert.equal(breaker.recordUnavailable(), false);
  assert.equal(breaker.recordUnavailable(), true, "opens, reported once");
  assert.deepEqual(breaker.excludedTypes(), ["index", "attach", "match"]);
  assert.equal(breaker.remainingMs(), 100);
});

test("the heartbeat refreshes claimed_at while a job runs, and finished_at/duration_ms are written at the end", async () => {
  let claimedAtStart: Date | null = null;
  let claimedAtLater: Date | null = null;
  const f = await fixture();
  const engine = stubEngine({
    async indexPhoto() {
      claimedAtStart = f.db.jobView(jobId)?.claimedAt ?? null;
      await new Promise((resolve) => setTimeout(resolve, 60));
      claimedAtLater = f.db.jobView(jobId)?.claimedAt ?? null;
      return [];
    },
  });
  f.deps.faces = engine;
  f.deps.heartbeatMs = 10;
  const photoId = await indexableJpeg(f);
  const jobId = await f.queue.enqueue("index", { photoId });
  const before = Date.now();
  assert.equal(await pollOnce(f.deps), true);
  assert.ok(claimedAtStart && claimedAtLater);
  assert.ok((claimedAtLater as Date).getTime() > (claimedAtStart as Date).getTime(), "claimed_at moved forward");
  const view = f.db.jobView(jobId);
  assert.equal(view?.status, "done");
  assert.ok(view?.finishedAt && view.finishedAt.getTime() >= before);
  assert.ok((view?.durationMs ?? -1) >= 0 && (view?.durationMs ?? 0) < 60_000);

  // Failures record the end too.
  const failing = await fixture({}, stubEngine({
    async indexPhoto() {
      throw new Error("boom");
    },
  }));
  const failId = await failing.queue.enqueue("index", { photoId: await indexableJpeg(failing) });
  assert.equal(await pollOnce(failing.deps), true);
  assert.ok(failing.db.jobView(failId)?.finishedAt);
  assert.equal(typeof failing.db.jobView(failId)?.durationMs, "number");
});

test("index is claimed before derive; attach still first", async () => {
  assert.equal(JOB_PRIORITY.index, 40);
  assert.ok(JOB_PRIORITY.attach < JOB_PRIORITY.index && JOB_PRIORITY.index < JOB_PRIORITY.derive);
  const db = new MemoryDatabase();
  const derive = await db.enqueueJob("derive", { photoId: randomUUID() });
  const index = await db.enqueueJob("index", { photoId: randomUUID() });
  const attach = await db.enqueueJob("attach", { photoId: randomUUID() });
  assert.equal((await db.claimJob())?.id, attach);
  assert.equal((await db.claimJob())?.id, index);
  assert.equal((await db.claimJob())?.id, derive);
  // The breaker filter leaves face jobs queued and still serves the rest.
  const verify = await db.enqueueJob("verify", { photoId: randomUUID() });
  const index2 = await db.enqueueJob("index", { photoId: randomUUID() });
  assert.equal((await db.claimJob({ excludeTypes: ["index", "attach", "match"] }))?.id, verify);
  assert.equal(await db.claimJob({ excludeTypes: ["index", "attach", "match"] }), null);
  assert.equal((await db.claimJob())?.id, index2);
});

test("LOG_IDS adds the payload ids to the job log lines", async () => {
  const f = await fixture({ LOG_IDS: true });
  const red = await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  const derive = f.logs.find((entry) => entry.type === "derive");
  assert.equal(derive?.photoId, red);
  assert.equal(derive?.userId, undefined);
  const match = f.logs.find((entry) => entry.type === "match");
  assert.equal(match?.userId, f.participantId);
  assert.equal(match?.eventId, f.eventId);
  assert.equal(match?.hits, 1);
  const quietFixture = await fixture();
  await ingest(quietFixture, [0, 255, 0]);
  assert.equal(quietFixture.logs.find((entry) => entry.type === "derive")?.photoId, undefined);
});

// ---- reset job ------------------------------------------------------------------------------

test("reset deletes every photo, the galleries, the match log and the collection, and audits", async () => {
  const f = await fixture({ MATCH_LOG: true });
  const audits: Array<{ action: string; target: string; meta: Record<string, unknown> }> = [];
  const db: Database = f.db;
  db.insertAudit = async (input) => {
    audits.push({ action: input.action, target: input.target, meta: input.meta });
  };
  const red = await ingest(f, [255, 0, 0]);
  const blue = await ingest(f, [0, 0, 255]);
  await selfie(f, [255, 0, 0]);
  assert.equal(f.db.matchLogOf(f.eventId).length, 1);
  const admin = await f.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const jobId = await f.queue.enqueue("reset", { eventId: f.eventId, actorId: admin.id }, { dedupeKey: `reset:${f.eventId}` });
  assert.equal(f.db.jobView(jobId)?.priority, 90);
  // Enqueued twice → one active job.
  assert.equal(await f.queue.enqueue("reset", { eventId: f.eventId, actorId: admin.id }, { dedupeKey: `reset:${f.eventId}` }), jobId);
  await drain(f.deps);
  assert.equal(f.db.jobView(jobId)?.status, "done");
  assert.equal(await f.db.countPhotos(f.eventId), 0);
  assert.equal(await f.db.findPhoto(red), null);
  assert.equal(await f.db.findPhoto(blue), null);
  assert.equal(await f.db.findGalleryByUser(f.participantId, f.eventId), null);
  assert.equal(f.db.matchLogOf(f.eventId).length, 0);
  assert.deepEqual(f.faces.deletedCollections, [f.eventId]);
  assert.equal(f.objects.objects.size, 0, "originals, derivatives and selfie all gone");
  assert.equal(f.faces.deletedFaceIds.flat().length, 2);
  assert.ok(await f.db.findUserById(f.participantId), "participants stay");
  const reset = audits.find((row) => row.action === "event.reset");
  assert.deepEqual(reset, { action: "event.reset", target: `event:${f.eventId}`, meta: { photos: 2, galleries: 1, matchRuns: 1 } });
  assert.equal(audits.filter((row) => row.action === "photo.deleted" && row.meta.reset === true).length, 2);
  // Idempotent on an empty event.
  const again = await f.queue.enqueue("reset", { eventId: f.eventId, actorId: admin.id });
  await drain(f.deps);
  assert.equal(f.db.jobView(again)?.status, "done");
});

test("a reset payload without an actor is invalid and fails terminally", async () => {
  const f = await fixture();
  const claimed = { id: randomUUID(), type: "reset" as const, payload: { eventId: f.eventId }, attempts: 0 };
  await f.db.enqueueJob("reset", claimed.payload);
  await processJob({ ...claimed, id: (await f.db.claimJob())?.id ?? claimed.id }, f.deps);
  assert.equal(f.logs.at(-1)?.outcome, "invalid");
});

test("liveness rejection records the `liveness` reason on the gallery", async () => {
  const f = await fixture({ LIVENESS_CHECK: true });
  f.deps.faces = {
    ...f.faces,
    async checkLiveness() {
      return { live: false, score: 0.1, method: "silent-face" };
    },
  };
  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, "liveness");
  assert.equal(gallery?.hasQueryVector, false);
  assert.equal(f.faces.selfieEmbeds, 0, "no embedding after a liveness rejection");
  assert.equal(f.mailer.sent.length, 1, "the ready mail still goes out on a liveness rejection");
});

test("LIVENESS_REQUIRED fails closed when the service cannot judge liveness (v4 F05)", async () => {
  // Engine without a checkLiveness capability (e.g. the model weights are absent):
  // required liveness must refuse the gallery rather than fall through to a match.
  const f = await fixture({ LIVENESS_REQUIRED: true });
  await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, "liveness");
  assert.equal(f.faces.selfieEmbeds, 0, "no search runs when liveness cannot be proven");
});

test("LIVENESS_REQUIRED rejects a `none` liveness verdict (v4 F05)", async () => {
  // A verdict with method "none" means no real anti-spoofing model ran; required
  // liveness treats that as not-live instead of silently serving the gallery.
  const f = await fixture({ LIVENESS_REQUIRED: true });
  f.deps.faces = {
    ...f.faces,
    async checkLiveness() {
      return { live: true, score: 0, method: "none" };
    },
  };
  await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, "liveness");
});

test("LIVENESS_REQUIRED delivers the gallery on a genuine live verdict (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_REQUIRED: true });
  f.deps.faces = {
    ...f.faces,
    async checkLiveness() {
      return { live: true, score: 0.95, method: "silent-face" };
    },
  };
  const red = await ingest(f, [255, 0, 0]);
  await selfie(f, [255, 0, 0]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, null, "a real live verdict lets the match proceed");
  const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.deepEqual(page.items.map((item) => item.photoId), [red]);
});

/** A challenge frame: colour fixes the fake identity, PNG width encodes the yaw (fake.fakeYaw). */
function framePng(rgb: [number, number, number], yaw: number): Promise<Buffer> {
  return solidPng(rgb[0], rgb[1], rgb[2], 1100 + Math.round(yaw * 100));
}

/** Issues a challenge, stores the frames at selfie keys and runs the match job. */
async function challengeMatch(
  f: Fixture,
  actions: LivenessAction[],
  frames: Buffer[],
  expiresAt = new Date(Date.now() + 120_000),
): Promise<{ id: string; frameKeys: string[] }> {
  const { id } = await f.db.insertLivenessChallenge({
    userId: f.participantId,
    eventId: f.eventId,
    actions,
    expiresAt,
  });
  const frameKeys: string[] = [];
  for (const frame of frames) {
    const key = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
    await f.objects.put(key, new Uint8Array(frame), "image/png");
    frameKeys.push(key);
  }
  await f.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey: frameKeys[frameKeys.length - 1]!,
    challengeId: id,
    frameKeys,
  });
  await drain(f.deps);
  return { id, frameKeys };
}

test("challenge-response delivers the gallery on a valid live sequence (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_CHALLENGE: true });
  const red = await ingest(f, [255, 0, 0]);
  const { id, frameKeys } = await challengeMatch(f, ["left", "right", "front"], [
    await framePng([255, 0, 0], 0.5),
    await framePng([255, 0, 0], -0.5),
    await framePng([255, 0, 0], 0),
  ]);
  const gallery = await f.db.findGalleryByUser(f.participantId, f.eventId);
  assert.equal(gallery?.reason, null, "a valid challenge lets the match proceed");
  const page = await f.db.listGalleryPage(f.participantId, f.eventId, { limit: 10 });
  assert.deepEqual(page.items.map((item) => item.photoId), [red]);
  // The non-frontal frames are cleaned up; the challenge was consumed by the worker.
  assert.equal(await f.objects.get(frameKeys[0]!), null, "turn frame deleted");
  assert.equal(await f.objects.get(frameKeys[1]!), null, "turn frame deleted");
  assert.equal(await f.db.consumeLivenessChallenge(id), false, "challenge already consumed");
});

test("challenge-response rejects a wrong head-turn sequence (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_CHALLENGE: true });
  await ingest(f, [255, 0, 0]);
  // Server dictated left, right, front but the first frame does not turn.
  await challengeMatch(f, ["left", "right", "front"], [
    await framePng([255, 0, 0], 0),
    await framePng([255, 0, 0], -0.5),
    await framePng([255, 0, 0], 0),
  ]);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.reason, "liveness");
});

test("challenge-response rejects frames that are not the same person (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_CHALLENGE: true });
  await ingest(f, [255, 0, 0]);
  // Correct motion, but the frontal frame is a different identity spliced in (the attack).
  await challengeMatch(f, ["left", "front"], [
    await framePng([255, 0, 0], 0.5),
    await framePng([0, 0, 255], 0),
  ]);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.reason, "liveness");
});

test("challenge-response rejects a replayed (already consumed) challenge (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_CHALLENGE: true });
  await ingest(f, [255, 0, 0]);
  const { id } = await f.db.insertLivenessChallenge({
    userId: f.participantId,
    eventId: f.eventId,
    actions: ["left", "front"],
    expiresAt: new Date(Date.now() + 120_000),
  });
  assert.equal(await f.db.consumeLivenessChallenge(id), true); // consumed elsewhere first
  const k0 = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  const k1 = objectKeys.selfie(f.eventId, f.participantId, randomUUID());
  await f.objects.put(k0, new Uint8Array(await framePng([255, 0, 0], 0.5)), "image/png");
  await f.objects.put(k1, new Uint8Array(await framePng([255, 0, 0], 0)), "image/png");
  await f.queue.enqueue("match", {
    userId: f.participantId,
    eventId: f.eventId,
    selfieKey: k1,
    challengeId: id,
    frameKeys: [k0, k1],
  });
  await drain(f.deps);
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.reason, "liveness");
});

test("challenge-response rejects an expired challenge (v4 F05)", async () => {
  const f = await fixture({ LIVENESS_CHALLENGE: true });
  await ingest(f, [255, 0, 0]);
  await challengeMatch(
    f,
    ["left", "front"],
    [await framePng([255, 0, 0], 0.5), await framePng([255, 0, 0], 0)],
    new Date(Date.now() - 1000),
  );
  assert.equal((await f.db.findGalleryByUser(f.participantId, f.eventId))?.reason, "liveness");
});
