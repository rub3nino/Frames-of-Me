import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { JOB_MAX_ATTEMPTS } from "@rephoto/contracts";
import { MemoryDatabase } from "./memory.ts";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";

async function seeded(): Promise<MemoryDatabase> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  return db;
}

async function addPhoto(
  db: MemoryDatabase,
  options: { derivatives?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insertPhoto({
    id,
    eventId: EVENT_ID,
    photographerId: PHOTOGRAPHER_ID,
    sha256: id.replace(/-/g, "").padEnd(64, "0"),
    originalKey: `originals/${EVENT_ID}/${id}`,
    contentType: "image/jpeg",
    bytes: 10,
  });
  if (options.derivatives !== false) {
    await db.upsertDerivative({ photoId: id, kind: "thumb", s3Key: `thumbs/${id}.jpg` });
    await db.upsertDerivative({ photoId: id, kind: "web", s3Key: `web/${id}.jpg` });
  }
  return id;
}

describe("MemoryDatabase jobs", () => {
  it("dedupes active jobs by key and allows a new one after completion", async () => {
    const db = await seeded();
    const photoId = randomUUID();
    const first = await db.enqueueJob("derive", { photoId }, { dedupeKey: `derive:${photoId}` });
    const again = await db.enqueueJob("derive", { photoId }, { dedupeKey: `derive:${photoId}` });
    assert.equal(again, first);
    assert.equal((await db.metrics()).jobsQueued, 1);

    const claimed = await db.claimJob();
    assert.equal(claimed?.id, first);
    const whileRunning = await db.enqueueJob("derive", { photoId }, { dedupeKey: `derive:${photoId}` });
    assert.equal(whileRunning, first);

    await db.completeJob(first);
    const fresh = await db.enqueueJob("derive", { photoId }, { dedupeKey: `derive:${photoId}` });
    assert.notEqual(fresh, first);
    const noKey = await db.enqueueJob("match", { photoId });
    assert.notEqual(noKey, fresh);
  });

  it("claims by priority, then run_after, then created_at", async () => {
    const db = await seeded();
    const indexJob = await db.enqueueJob("index", { photoId: randomUUID() });
    const retention = await db.enqueueJob("retention", { eventId: EVENT_ID, actorId: randomUUID() });
    const matchJob = await db.enqueueJob("match", { userId: randomUUID(), eventId: EVENT_ID });
    const laterIndex = await db.enqueueJob("index", { photoId: randomUUID() });
    const customEarly = await db.enqueueJob(
      "index",
      { photoId: randomUUID() },
      { priority: 5, runAfter: new Date(Date.now() - 1000) },
    );
    db.setJobCreatedAt(laterIndex, new Date(Date.now() + 1));
    assert.equal(db.jobView(matchJob)?.priority, 0);
    assert.equal(db.jobView(indexJob)?.priority, 40);
    assert.equal(db.jobView(retention)?.priority, 90);

    const order: string[] = [];
    for (;;) {
      const job = await db.claimJob();
      if (!job) break;
      order.push(job.id);
      await db.completeJob(job.id);
    }
    assert.deepEqual(order, [matchJob, customEarly, indexJob, laterIndex, retention]);
  });

  it("fails terminally and prunes done jobs", async () => {
    const db = await seeded();
    const job = await db.enqueueJob("derive", { photoId: randomUUID() });
    await db.claimJob();
    await db.failJobTerminal(job, "sha256 mismatch");
    const view = db.jobView(job);
    assert.equal(view?.status, "error");
    assert.equal(view?.attempts, JOB_MAX_ATTEMPTS);
    assert.equal(view?.lastError, "sha256 mismatch");

    const done = await db.enqueueJob("index", { photoId: randomUUID() });
    await db.claimJob();
    await db.completeJob(done);
    db.setJobCreatedAt(done, new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const recent = await db.enqueueJob("index", { photoId: randomUUID() });
    await db.claimJob();
    await db.completeJob(recent);
    const pruned = await db.pruneJobs({
      doneOlderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    assert.equal(pruned, 1);
    assert.equal(db.jobView(done), null);
    assert.equal(db.jobView(recent)?.status, "done");
    assert.equal((await db.metrics()).jobsError, 1);
  });
});

describe("MemoryDatabase galleries", () => {
  it("pages the gallery by score desc, photo id asc and skips items without derivatives", async () => {
    const db = await seeded();
    const user = await db.createUser({ email: "p@example.com", role: "participant" });
    const photos: Array<{ photoId: string; score: number }> = [];
    for (let index = 0; index < 5; index += 1) {
      photos.push({ photoId: await addPhoto(db), score: index < 2 ? 0.95 : 0.85 });
    }
    const missing = await addPhoto(db, { derivatives: false });
    const faceId = randomUUID();
    await db.replaceGallery(
      user.id,
      EVENT_ID,
      [...photos, { photoId: missing, score: 0.99 }].map((item) => ({ ...item, faceId })),
      ["anchor-1"],
    );

    const expected = [...photos].sort(
      (a, b) => b.score - a.score || (a.photoId < b.photoId ? -1 : 1),
    );
    const first = await db.listGalleryPage(user.id, EVENT_ID, { limit: 2 });
    assert.equal(first.total, 5);
    assert.deepEqual(
      first.items.map((item) => item.photoId),
      expected.slice(0, 2).map((item) => item.photoId),
    );
    assert.equal(first.items[0]?.source, "match");
    assert.equal(first.items[0]?.thumbKey, `thumbs/${expected[0]?.photoId}.jpg`);
    assert.equal(first.items[0]?.webKey, `web/${expected[0]?.photoId}.jpg`);
    assert.ok(first.items[0]?.createdAt instanceof Date);

    const last = first.items[1];
    assert.ok(last);
    const second = await db.listGalleryPage(user.id, EVENT_ID, {
      limit: 2,
      cursor: { score: last.score, photoId: last.photoId },
    });
    assert.deepEqual(
      second.items.map((item) => item.photoId),
      expected.slice(2, 4).map((item) => item.photoId),
    );
    const third = await db.listGalleryPage(user.id, EVENT_ID, {
      limit: 2,
      cursor: { score: second.items[1]!.score, photoId: second.items[1]!.photoId },
    });
    assert.deepEqual(
      third.items.map((item) => item.photoId),
      expected.slice(4).map((item) => item.photoId),
    );
    assert.deepEqual(
      (await db.listGalleryPage(user.id, EVENT_ID, { limit: 10 })).items.map((i) => i.photoId),
      expected.map((item) => item.photoId),
    );
    assert.deepEqual(await db.listGalleryPage(randomUUID(), EVENT_ID, { limit: 10 }), {
      total: 0,
      items: [],
    });
  });

  it("counts only new rows in addGalleryItems and keeps the greatest score", async () => {
    const db = await seeded();
    const user = await db.createUser({ email: "p@example.com", role: "participant" });
    const a = await addPhoto(db);
    const b = await addPhoto(db);
    const c = await addPhoto(db);
    const faceId = randomUUID();
    await db.replaceGallery(user.id, EVENT_ID, [{ photoId: a, faceId, score: 0.9 }], ["anchor-a"]);
    const gallery = await db.findGalleryByUser(user.id, EVENT_ID);
    assert.ok(gallery);
    assert.deepEqual(gallery.anchorFaceIds, ["anchor-a"]);
    assert.ok(gallery.matchedAt instanceof Date);

    const inserted = await db.addGalleryItems(gallery.id, [
      { photoId: a, faceId, score: 0.95, source: "attach" },
      { photoId: b, faceId, score: 0.85, source: "attach" },
      { photoId: c, faceId, score: 0.8, source: "attach" },
    ]);
    assert.equal(inserted, 2);
    const again = await db.addGalleryItems(gallery.id, [
      { photoId: b, faceId, score: 0.5, source: "attach" },
    ]);
    assert.equal(again, 0);

    const page = await db.listGalleryPage(user.id, EVENT_ID, { limit: 10 });
    const byId = new Map(page.items.map((item) => [item.photoId, item]));
    assert.equal(byId.get(a)?.score, 0.95);
    assert.equal(byId.get(a)?.source, "match");
    assert.equal(byId.get(b)?.score, 0.85);
    assert.equal(byId.get(b)?.source, "attach");
    assert.equal(page.total, 3);

    const owned = await db.listOwnedPhotos(user.id, EVENT_ID, [a, c, randomUUID()]);
    assert.deepEqual(owned.map((row) => row.id).sort(), [a, c].sort());
  });

  it("finds galleries by overlapping anchors and removes anchors", async () => {
    const db = await seeded();
    const one = await db.createUser({ email: "one@example.com", role: "participant" });
    const two = await db.createUser({ email: "two@example.com", role: "participant" });
    const three = await db.createUser({ email: "three@example.com", role: "participant" });
    await db.replaceGallery(one.id, EVENT_ID, [], ["f1", "f2"]);
    await db.replaceGallery(two.id, EVENT_ID, [], ["f3"]);
    await db.replaceGallery(three.id, EVENT_ID, [], []);

    assert.equal(await db.countAnchoredGalleries(EVENT_ID), 2);
    assert.equal(await db.countAnchoredGalleries(randomUUID()), 0);

    const hits = await db.findGalleriesByAnchors(EVENT_ID, ["f2", "f3", "f9"]);
    assert.deepEqual(hits.map((row) => row.userId).sort(), [one.id, two.id].sort());
    assert.ok(hits.every((row) => row.notifiedAt instanceof Date));
    assert.deepEqual(await db.findGalleriesByAnchors(EVENT_ID, ["f9"]), []);
    assert.deepEqual(await db.findGalleriesByAnchors(EVENT_ID, []), []);
    assert.deepEqual(await db.findGalleriesByAnchors(randomUUID(), ["f1"]), []);

    const [first] = hits;
    assert.ok(first);
    const earlier = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db.markGalleryNotified(first.id, earlier);
    const after = await db.findGalleriesByAnchors(EVENT_ID, first.anchorFaceIds);
    assert.equal(after.find((row) => row.id === first.id)?.notifiedAt?.getTime(), earlier.getTime());

    await db.removeAnchors(EVENT_ID, ["f2", "f3"]);
    assert.deepEqual(await db.findGalleriesByAnchors(EVENT_ID, ["f2", "f3"]), []);
    const remaining = await db.findGalleryByUser(one.id, EVENT_ID);
    assert.deepEqual(remaining?.anchorFaceIds, ["f1"]);
    assert.equal(await db.countAnchoredGalleries(EVENT_ID), 1);
  });
});

describe("MemoryDatabase v2 rows", () => {
  it("seeds the demo photographer as an event photographer", async () => {
    const db = await seeded();
    await db.seedDemo();
    assert.equal(await db.isEventPhotographer(EVENT_ID, PHOTOGRAPHER_ID), true);
    assert.equal(await db.isEventPhotographer(EVENT_ID, randomUUID()), false);
    const event = await db.findEventBySlug("demo");
    assert.equal(event?.access, "open");
  });

  it("updates event access, imports participants and consumes invites once", async () => {
    const db = await seeded();
    const updated = await db.updateEvent(EVENT_ID, { access: "list", retentionDays: 30 });
    assert.equal(updated?.access, "list");
    assert.equal(updated?.retentionDays, 30);
    assert.equal(await db.updateEvent(randomUUID(), { access: "open" }), null);

    assert.equal(await db.upsertEventParticipants(EVENT_ID, ["a@x.it", "b@x.it", "a@x.it"]), 2);
    assert.equal(await db.upsertEventParticipants(EVENT_ID, ["a@x.it", "c@x.it"]), 1);
    assert.equal(await db.isEventParticipant(EVENT_ID, "c@x.it"), true);
    assert.equal(await db.isEventParticipant(EVENT_ID, "d@x.it"), false);

    const inviteId = await db.insertInvite({
      email: "new@x.it",
      eventId: EVENT_ID,
      tokenHash: "hash-1",
      role: "photographer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(inviteId);
    assert.deepEqual(await db.consumeInvite("hash-1"), {
      email: "new@x.it",
      role: "photographer",
      eventId: EVENT_ID,
    });
    assert.equal(await db.consumeInvite("hash-1"), null);
    assert.equal(await db.consumeInvite("missing"), null);
  });

  it("counts magic links by email and ip within the window", async () => {
    const db = await seeded();
    const since = new Date(Date.now() - 60_000);
    for (let index = 0; index < 3; index += 1) {
      await db.insertMagicLink({
        email: "a@x.it",
        role: "participant",
        tokenHash: `t${index}`,
        expiresAt: new Date(Date.now() + 60_000),
        ip: index === 0 ? "10.0.0.1" : "10.0.0.2",
      });
    }
    assert.equal(await db.countMagicLinksSince({ email: "a@x.it", since }), 3);
    assert.equal(await db.countMagicLinksSince({ ip: "10.0.0.2", since }), 2);
    assert.equal(await db.countMagicLinksSince({ email: "a@x.it", ip: "10.0.0.1", since }), 1);
    assert.equal(await db.countMagicLinksSince({ since }), 0);
    assert.equal(
      await db.countMagicLinksSince({ email: "a@x.it", since: new Date(Date.now() + 1000) }),
      0,
    );
  });

  it("tracks photo indexing, errors and the upload summary", async () => {
    const db = await seeded();
    const indexed = await addPhoto(db);
    const failed = await addPhoto(db);
    await db.setPhotoIndexed(indexed);
    await db.setPhotoError(failed, "sha256 mismatch");
    const row = await db.findPhoto(indexed);
    assert.equal(row?.status, "indexed");
    assert.ok(row?.indexedAt instanceof Date);
    assert.equal((await db.findPhoto(failed))?.error, "sha256 mismatch");

    const sessionIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = randomUUID();
      sessionIds.push(id);
      await db.insertUploadSession({
        id,
        eventId: EVENT_ID,
        photographerId: PHOTOGRAPHER_ID,
        s3UploadId: index === 0 ? "mp-1" : null,
        objectKey: `originals/${EVENT_ID}/${id}`,
        sha256: "a".repeat(64),
        contentType: "image/jpeg",
        bytes: 123,
      });
      db.setUploadCreatedAt(id, new Date(Date.now() - (3 - index) * 1000));
    }
    await db.markUploadSession(sessionIds[1]!, "completed");
    const summary = await db.uploadSummary(PHOTOGRAPHER_ID, EVENT_ID);
    assert.deepEqual(summary, {
      sessions: { open: 2, completed: 1, aborted: 0 },
      photos: { uploaded: 0, processing: 0, indexed: 1, error: 1, originalsPending: 0 },
    });
    assert.equal((await db.findUploadSession(sessionIds[0]!))?.bytes, 123);

    const page = await db.listUploadSessionsPage(PHOTOGRAPHER_ID, EVENT_ID, { limit: 2 });
    assert.deepEqual(
      page.items.map((item) => item.id),
      [sessionIds[2], sessionIds[1]],
    );
    assert.ok(page.nextCursor);
    const rest = await db.listUploadSessionsPage(PHOTOGRAPHER_ID, EVENT_ID, {
      limit: 2,
      cursor: page.nextCursor,
    });
    assert.deepEqual(rest.items.map((item) => item.id), [sessionIds[0]]);
    assert.equal(rest.nextCursor, null);

    const stale = await db.abortStaleUploads({ olderThan: new Date(Date.now() - 2500) });
    assert.deepEqual(stale, [
      { id: sessionIds[0], objectKey: `originals/${EVENT_ID}/${sessionIds[0]}`, s3UploadId: "mp-1" },
    ]);
    assert.equal((await db.findUploadSession(sessionIds[0]!))?.status, "aborted");
    assert.equal((await db.uploadSummary(PHOTOGRAPHER_ID, EVENT_ID)).sessions.open, 1);

    const metrics = await db.metrics();
    assert.deepEqual(metrics.photosByStatus, { uploaded: 0, processing: 0, indexed: 1, error: 1 });
    assert.equal(metrics.galleries, 0);
    await db.ping();
  });
});
