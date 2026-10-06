import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { createApp } from "@rephoto/api";
import { sha256Hex } from "@rephoto/api/crypto";
import type { Mailer, MailMessage } from "@rephoto/api/mailer";
import type { CompletedPart, ObjectStore, StoredObject } from "@rephoto/api/object-store";
import { createQueue } from "@rephoto/api/queue";
import {
  envSchema,
  errorBodySchema,
  galleryResponseSchema,
  objectKeys,
  retentionResponseSchema,
  selfieResponseSchema,
  SESSION_COOKIE_NAME,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase, seedDemo, type Database } from "@rephoto/db";
import type { FaceEngine, IndexPhotoInput, SearchInput } from "../../../packages/face-engine/src/types.ts";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { pollOnce } from "../src/run.js";

const env: Env = envSchema.parse({
  DATABASE_URL: "postgres://rephoto:rephoto@localhost:5432/rephoto",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "rephoto",
  S3_ACCESS_KEY: "rephoto",
  S3_SECRET_KEY: "rephoto-secret",
  S3_REGION: "eu-central-1",
  S3_FORCE_PATH_STYLE: "true",
  SESSION_SECRET: "test-session-secret-value",
  FACE_ENGINE: "fake",
  AWS_REGION: "eu-central-1",
  REKOGNITION_COLLECTION_PREFIX: "rephoto-",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_FROM: "noreply@rephoto.local",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:8787",
});

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { bytes: stored.body.byteLength, contentType: stored.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignPut(key: string, contentType: string): Promise<string> {
    return `http://localhost:9000/${key}?put=1&type=${encodeURIComponent(contentType)}`;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    void key;
    void contentType;
    return `mp-${randomUUID()}`;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `http://localhost:9000/${key}?upload=${uploadId}&part=${partNumber}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    void key;
    void uploadId;
    void parts;
  }

  async presignGet(key: string): Promise<string> {
    return `http://localhost:9000/${key}`;
  }
}

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

function trackingEngine(inner: FaceEngine): FaceEngine & {
  indexedPhotoIds: string[];
  indexedBytes: Uint8Array[];
  searchBytes: Uint8Array[];
  deletedFaceIds: string[][];
  deletedCollections: string[];
} {
  const indexedPhotoIds: string[] = [];
  const indexedBytes: Uint8Array[] = [];
  const searchBytes: Uint8Array[] = [];
  const deletedFaceIds: string[][] = [];
  const deletedCollections: string[] = [];
  return {
    indexedPhotoIds,
    indexedBytes,
    searchBytes,
    deletedFaceIds,
    deletedCollections,
    indexPhoto(input: IndexPhotoInput) {
      indexedPhotoIds.push(input.photoId);
      indexedBytes.push(input.imageBytes);
      return inner.indexPhoto(input);
    },
    search(input: SearchInput) {
      searchBytes.push(input.imageBytes);
      return inner.search(input);
    },
    deleteFaces(eventId, externalFaceIds) {
      deletedFaceIds.push([...externalFaceIds]);
      return inner.deleteFaces(eventId, externalFaceIds);
    },
    deleteCollection(eventId) {
      deletedCollections.push(eventId);
      return inner.deleteCollection(eventId);
    },
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function solidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function drain(deps: WorkerDeps): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const worked = await pollOnce(deps);
    if (!worked) return;
  }
  throw new Error("jobs did not drain");
}

async function sessionCookie(
  db: MemoryDatabase,
  userId: string,
): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

test("red selfie matches only the red photo and the selfie object is deleted", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const participant = await db.createUser({
    email: "guest@example.com",
    role: "participant",
  });
  const objects = new MemoryObjectStore();
  const mailer = new RecordingMailer();
  const faces = trackingEngine(new FakeFaceEngine(new MemoryFaceIndexStore()));
  const queue = createQueue(db);
  const deps: WorkerDeps = { env, db, objects, mailer, queue, faces };
  const app = createApp(deps);

  const redBytes = new Uint8Array(await solidPng(255, 0, 0));
  const blueBytes = new Uint8Array(await solidPng(0, 0, 255));
  const redId = randomUUID();
  const blueId = randomUUID();
  await db.insertPhoto({
    id: redId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(redBytes),
    originalKey: objectKeys.original(event.id, redId),
    contentType: "image/png",
    bytes: redBytes.byteLength,
  });
  await db.insertPhoto({
    id: blueId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(blueBytes),
    originalKey: objectKeys.original(event.id, blueId),
    contentType: "image/png",
    bytes: blueBytes.byteLength,
  });
  await objects.put(objectKeys.original(event.id, redId), redBytes, "image/png");
  await objects.put(objectKeys.original(event.id, blueId), blueBytes, "image/png");
  await queue.enqueue("derive", { photoId: redId });
  await queue.enqueue("derive", { photoId: blueId });
  await drain(deps);

  assert.equal((await db.findPhoto(redId))?.status, "indexed");
  assert.equal((await db.findPhoto(blueId))?.status, "indexed");
  assert.deepEqual(faces.indexedPhotoIds.sort(), [redId, blueId].sort());

  const cookie = await sessionCookie(db, participant.id);
  const consent = await app.request("/v1/events/demo/consent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ textVersion: "2026-01", accepted: true }),
  });
  assert.equal(consent.status, 201);

  const form = new FormData();
  form.set("selfie", new File([redBytes], "selfie.png", { type: "image/png" }));
  const selfie = await app.request("/v1/events/demo/selfie", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  assert.equal(selfie.status, 202);
  selfieResponseSchema.parse(await selfie.json());
  const selfieKeys = [...objects.objects.keys()].filter((key) => key.startsWith("selfies/"));
  assert.equal(selfieKeys.length, 1);

  await drain(deps);

  assert.equal(objects.objects.has(selfieKeys[0] ?? ""), false);
  assert.equal([...objects.objects.keys()].some((key) => key.startsWith("selfies/")), false);
  assert.deepEqual(faces.indexedPhotoIds.sort(), [redId, blueId].sort());

  const gallery = await app.request("/v1/events/demo/gallery", { headers: { cookie } });
  assert.equal(gallery.status, 200);
  assert.equal(gallery.headers.get("x-content-type-options"), "nosniff");
  const body = galleryResponseSchema.parse(await gallery.json());
  assert.equal(body.status, "ready");
  assert.deepEqual(
    body.items.map((item) => item.photoId),
    [redId],
  );
  assert.equal(body.items[0]?.score, 0.99);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]?.to, participant.email);
  assert.match(mailer.sent[0]?.text ?? "", /http:\/\/localhost:3000\/e\/demo/);

  const searched = faces.searchBytes[0];
  assert.ok(searched);
  assert.equal(searched[0], 0xff);
  assert.equal(searched[1], 0xd8);
  assert.ok(searched.byteLength < 5 * 1024 * 1024);
  assert.equal(sameBytes(searched, redBytes), false);
});

test("consent accepted false is rejected", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const participant = await db.createUser({
    email: "guest@example.com",
    role: "participant",
  });
  const app = createApp({
    env,
    db,
    objects: new MemoryObjectStore(),
    mailer: new RecordingMailer(),
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
  });
  const cookie = await sessionCookie(db, participant.id);
  const response = await app.request("/v1/events/demo/consent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ textVersion: "2026-01", accepted: false }),
  });
  assert.equal(response.status, 400);
  errorBodySchema.parse(await response.json());
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  assert.equal(await db.hasActiveConsent(participant.id, event.id), false);
});

test("a photographer cannot read the gallery", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const app = createApp({
    env,
    db,
    objects: new MemoryObjectStore(),
    mailer: new RecordingMailer(),
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
  });
  const cookie = await sessionCookie(db, photographer.id);
  const response = await app.request("/v1/events/demo/gallery", { headers: { cookie } });
  assert.equal(response.status, 403);
  errorBodySchema.parse(await response.json());
});

test("index sends the web derivative bytes, not the original", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
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
  };
  const original = new Uint8Array(await solidPng(255, 0, 0));
  const photoId = randomUUID();
  const originalKey = objectKeys.original(event.id, photoId);
  await db.insertPhoto({
    id: photoId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(original),
    originalKey,
    contentType: "image/png",
    bytes: original.byteLength,
  });
  await objects.put(originalKey, original, "image/png");
  await queue.enqueue("derive", { photoId });
  await drain(deps);

  const web = await objects.get(objectKeys.web(photoId));
  const storedOriginal = await objects.get(originalKey);
  assert.ok(web);
  assert.ok(storedOriginal);
  assert.equal(faces.indexedBytes.length, 1);
  const indexed = faces.indexedBytes[0];
  assert.ok(indexed);
  assert.equal(sameBytes(indexed, web.body), true);
  assert.equal(sameBytes(indexed, storedOriginal.body), false);
  assert.equal(indexed[0], 0xff);
  assert.equal(indexed[1], 0xd8);
  assert.ok(indexed.byteLength < 5 * 1024 * 1024);
  assert.equal((await db.findPhoto(photoId))?.status, "indexed");
});

test("reindex deletes previous external ids and a completed index is not repeated", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const objects = new MemoryObjectStore();
  const order: string[] = [];
  const inner = new FakeFaceEngine(new MemoryFaceIndexStore());
  const faces: FaceEngine = {
    async indexPhoto(input) {
      order.push("index");
      return inner.indexPhoto(input);
    },
    search(input) {
      return inner.search(input);
    },
    async deleteFaces(eventId, externalFaceIds) {
      order.push(`delete:${externalFaceIds.join(",")}`);
      return inner.deleteFaces(eventId, externalFaceIds);
    },
    deleteCollection(eventId) {
      return inner.deleteCollection(eventId);
    },
  };
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
  };
  const original = new Uint8Array(await solidPng(0, 0, 255));
  const photoId = randomUUID();
  await db.insertPhoto({
    id: photoId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(original),
    originalKey: objectKeys.original(event.id, photoId),
    contentType: "image/png",
    bytes: original.byteLength,
  });
  await objects.put(objectKeys.original(event.id, photoId), original, "image/png");
  await queue.enqueue("derive", { photoId });
  await drain(deps);
  assert.deepEqual(order, ["index"]);
  const previous = await db.listExternalIds(photoId);
  assert.deepEqual(previous, [`fake-${photoId}`]);

  await queue.enqueue("index", { photoId });
  await drain(deps);
  assert.deepEqual(order, ["index"]);

  await db.setPhotoStatus(photoId, "processing");
  await queue.enqueue("index", { photoId });
  await drain(deps);
  assert.deepEqual(order, ["index", `delete:${previous.join(",")}`, "index"]);
  const web = await objects.get(objectKeys.web(photoId));
  assert.ok(web);
  const hits = await faces.search({
    eventId: event.id,
    imageBytes: web.body,
    contentType: "image/jpeg",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.externalFaceId, `fake-${photoId}`);
});

test("throttle requeues without burning attempts", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const objects = new MemoryObjectStore();
  let calls = 0;
  const faces: FaceEngine = {
    async indexPhoto() {
      calls += 1;
      const error = new Error("throughput");
      error.name = "RekognitionThrottleError";
      throw error;
    },
    async search() {
      return [];
    },
    async deleteFaces() {
      return undefined;
    },
    async deleteCollection() {
      return undefined;
    },
  };
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
  };
  const photoId = randomUUID();
  const jpeg = new Uint8Array(
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer(),
  );
  await db.insertPhoto({
    id: photoId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(jpeg),
    originalKey: objectKeys.original(event.id, photoId),
    contentType: "image/jpeg",
    bytes: jpeg.byteLength,
  });
  await objects.put(objectKeys.web(photoId), jpeg, "image/jpeg");
  const jobId = await queue.enqueue("index", { photoId });
  for (let step = 0; step < 6; step += 1) {
    db.makeJobDue(jobId);
    assert.equal(await pollOnce(deps), true);
  }
  const view = db.jobView(jobId);
  assert.equal(view?.attempts, 0);
  assert.equal(view?.status, "queued");
  assert.equal(calls, 6);
  assert.notEqual((await db.findPhoto(photoId))?.status, "error");
});

test("a non-throttle index error still consumes attempts", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const objects = new MemoryObjectStore();
  const faces: FaceEngine = {
    async indexPhoto() {
      const error = new Error("rejected");
      error.name = "ServiceException";
      throw error;
    },
    async search() {
      return [];
    },
    async deleteFaces() {
      return undefined;
    },
    async deleteCollection() {
      return undefined;
    },
  };
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
  };
  const photoId = randomUUID();
  const jpeg = new Uint8Array(
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer(),
  );
  await db.insertPhoto({
    id: photoId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: sha256(jpeg),
    originalKey: objectKeys.original(event.id, photoId),
    contentType: "image/jpeg",
    bytes: jpeg.byteLength,
  });
  await objects.put(objectKeys.web(photoId), jpeg, "image/jpeg");
  const jobId = await queue.enqueue("index", { photoId });
  for (let step = 0; step < 5; step += 1) {
    db.makeJobDue(jobId);
    assert.equal(await pollOnce(deps), true);
  }
  assert.equal(db.jobView(jobId)?.status, "error");
  assert.equal(db.jobView(jobId)?.attempts, 5);
  assert.equal((await db.findPhoto(photoId))?.status, "error");
});

test("a job running longer than ten minutes returns to the queue", async () => {
  const db = new MemoryDatabase();
  const jobId = await db.enqueueJob("index", { photoId: randomUUID() });
  db.forceRunning(jobId, new Date(Date.now() - 11 * 60 * 1000));
  const claimed = await db.claimJob();
  assert.equal(claimed?.id, jobId);
  assert.equal(claimed?.attempts, 0);
  assert.equal(db.jobView(jobId)?.status, "running");

  const freshId = await db.enqueueJob("index", { photoId: randomUUID() });
  db.forceRunning(freshId, new Date());
  assert.equal(await db.claimJob(), null);
  assert.equal(db.jobView(freshId)?.status, "running");
});

test("retention run enqueues a job instead of deleting inline", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const admin = await db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const photographer = await db.createUser({
    email: "shooter@example.com",
    role: "photographer",
  });
  const objects = new MemoryObjectStore();
  const deletedFaces: string[][] = [];
  let collections = 0;
  const faces: FaceEngine = {
    async indexPhoto() {
      return [];
    },
    async search() {
      return [];
    },
    async deleteFaces(_eventId, externalFaceIds) {
      deletedFaces.push([...externalFaceIds]);
    },
    async deleteCollection() {
      collections += 1;
    },
  };
  const queue = createQueue(db);
  const deps: WorkerDeps = {
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue,
    faces,
  };
  const app = createApp(deps);
  const oldId = randomUUID();
  const recentId = randomUUID();
  const oldKey = objectKeys.original(event.id, oldId);
  const recentKey = objectKeys.original(event.id, recentId);
  await db.insertPhoto({
    id: oldId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: "a".repeat(64),
    originalKey: oldKey,
    contentType: "image/jpeg",
    bytes: 10,
  });
  await db.insertPhoto({
    id: recentId,
    eventId: event.id,
    photographerId: photographer.id,
    sha256: "b".repeat(64),
    originalKey: recentKey,
    contentType: "image/jpeg",
    bytes: 10,
  });
  db.setPhotoCreatedAt(oldId, new Date(0));
  await objects.put(oldKey, new Uint8Array([1]), "image/jpeg");
  await objects.put(recentKey, new Uint8Array([2]), "image/jpeg");
  await objects.put(objectKeys.web(oldId), new Uint8Array([3]), "image/jpeg");
  await db.upsertDerivative({ photoId: oldId, kind: "web", s3Key: objectKeys.web(oldId) });
  const box = { x: 0, y: 0, width: 1, height: 1 };
  await db.replaceFaces(oldId, event.id, [{ externalId: "ext-old", bbox: box, confidence: 1 }]);
  await db.replaceFaces(recentId, event.id, [{ externalId: "ext-new", bbox: box, confidence: 1 }]);

  const cookie = await sessionCookie(db, admin.id);
  const response = await app.request("/v1/admin/retention/run", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ eventId: event.id }),
  });
  assert.equal(response.status, 202);
  const body = retentionResponseSchema.parse(await response.json());
  assert.equal(db.jobView(body.jobId)?.status, "queued");
  assert.ok(await db.findPhoto(oldId));
  assert.ok(await db.findPhoto(recentId));
  assert.equal(deletedFaces.length, 0);
  assert.equal(objects.objects.has(oldKey), true);

  await drain(deps);
  assert.equal(await db.findPhoto(oldId), null);
  assert.ok(await db.findPhoto(recentId));
  assert.equal(objects.objects.has(oldKey), false);
  assert.equal(objects.objects.has(objectKeys.web(oldId)), false);
  assert.equal(objects.objects.has(recentKey), true);
  assert.deepEqual(deletedFaces, [["ext-old"]]);
  assert.equal(collections, 0);

  await db.deletePhoto(recentId);
  await objects.delete(recentKey);
  await queue.enqueue("retention", { eventId: event.id, actorId: admin.id });
  await drain(deps);
  assert.equal(collections, 1);
});

test("health returns 200 and does not call the face engine", async () => {
  const db = new MemoryDatabase();
  const faces: FaceEngine = {
    async indexPhoto() {
      throw new Error("index");
    },
    async search() {
      throw new Error("search");
    },
    async deleteFaces() {
      throw new Error("delete");
    },
    async deleteCollection() {
      throw new Error("collection");
    },
  };
  const app = createApp({
    env,
    db,
    objects: new MemoryObjectStore(),
    mailer: new RecordingMailer(),
    queue: createQueue(db),
    faces,
  });
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const proxied = await app.request("/v1/health");
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { ok: true });
});

test("S3 keys are optional without an endpoint and required for MinIO", () => {
  const parsed = envSchema.parse({
    DATABASE_URL: "postgres://rephoto:rephoto@localhost:5432/rephoto",
    S3_BUCKET: "rephoto",
    S3_REGION: "eu-central-1",
    SESSION_SECRET: "test-session-secret-value",
    FACE_ENGINE: "rekognition",
    MAIL_TRANSPORT: "ses",
    SMTP_FROM: "noreply@rephoto.local",
    WEB_ORIGIN: "https://photos.example",
    API_ORIGIN: "https://api.photos.example",
  });
  assert.equal(parsed.S3_ENDPOINT, undefined);
  assert.equal(parsed.S3_ACCESS_KEY, undefined);
  assert.equal(parsed.S3_SECRET_KEY, undefined);
  assert.equal(parsed.S3_FORCE_PATH_STYLE, false);
  assert.equal(parsed.MAIL_TRANSPORT, "ses");
  assert.equal(parsed.REKOGNITION_SEARCH_MAX_FACES, 500);

  assert.throws(() =>
    envSchema.parse({
      DATABASE_URL: "postgres://rephoto:rephoto@localhost:5432/rephoto",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "rephoto",
      S3_REGION: "eu-central-1",
      S3_FORCE_PATH_STYLE: "true",
      SESSION_SECRET: "test-session-secret-value",
      FACE_ENGINE: "fake",
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_FROM: "noreply@rephoto.local",
      WEB_ORIGIN: "http://localhost:3000",
      API_ORIGIN: "http://localhost:8787",
    }),
  );
});

test("demo seed is skipped in production and when SEED_DEMO is false", async () => {
  let calls = 0;
  const db = {
    async seedDemo() {
      calls += 1;
    },
  };
  await seedDemo(db as unknown as Database, { NODE_ENV: "production", SEED_DEMO: "true" });
  await seedDemo(db as unknown as Database, { SEED_DEMO: "false" });
  assert.equal(calls, 0);
  await seedDemo(db as unknown as Database, {});
  assert.equal(calls, 1);
});
