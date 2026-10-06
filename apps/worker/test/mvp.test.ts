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
  selfieResponseSchema,
  SESSION_COOKIE_NAME,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import type { FaceEngine, IndexPhotoInput } from "../../../packages/face-engine/src/types.ts";
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

function trackingEngine(inner: FaceEngine): FaceEngine & { indexedPhotoIds: string[] } {
  const indexedPhotoIds: string[] = [];
  return {
    indexedPhotoIds,
    indexPhoto(input: IndexPhotoInput) {
      indexedPhotoIds.push(input.photoId);
      return inner.indexPhoto(input);
    },
    search(input) {
      return inner.search(input);
    },
    deleteFaces(eventId, externalFaceIds) {
      return inner.deleteFaces(eventId, externalFaceIds);
    },
  };
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
