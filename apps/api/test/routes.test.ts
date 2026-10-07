import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  API_BODY_MAX_BYTES,
  CONSENT_TEXT_VERSION,
  envSchema,
  galleryResponseSchema,
  objectKeys,
  SESSION_COOKIE_NAME,
  UPLOAD_MAX_BYTES,
  uploadCompleteResponseSchema,
  uploadLookupResponseSchema,
  uploadSummaryResponseSchema,
  WEB_STAGE_MAX_BYTES,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase, type Database } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/crypto.ts";
import type { AppDeps } from "../src/deps.ts";
import { MESSAGES } from "../src/errors.ts";
import type { Mailer, MailMessage } from "../src/mailer.ts";
import type {
  CompletedPart,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
  StreamedObject,
} from "../src/object-store.ts";
import { createS3ObjectStore, signingWindowStart } from "../src/objects.ts";
import { createQueue } from "../src/queue.ts";

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
  readonly objects = new Map<string, StoredObject & { cacheControl?: string }>();
  readonly abortedUploads: Array<{ key: string; uploadId: string }> = [];

  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    options?: PutObjectOptions,
  ): Promise<void> {
    this.objects.set(key, {
      body,
      contentType,
      ...(options?.cacheControl ? { cacheControl: options.cacheControl } : {}),
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const stored = this.objects.get(key);
    return stored ? { body: stored.body, contentType: stored.contentType } : null;
  }

  async stream(key: string): Promise<StreamedObject | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: Readable.from([Buffer.from(stored.body)]),
      contentType: stored.contentType,
      bytes: stored.body.byteLength,
    };
  }

  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { bytes: stored.body.byteLength, contentType: stored.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignPut(key: string, contentType: string, bytes?: number): Promise<string> {
    const length = bytes === undefined ? "" : `&length=${bytes}`;
    return `http://localhost:9000/${key}?put=1&type=${encodeURIComponent(contentType)}${length}`;
  }

  async createMultipartUpload(): Promise<string> {
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

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.abortedUploads.push({ key, uploadId });
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

type Harness = {
  app: ReturnType<typeof createApp>;
  db: MemoryDatabase;
  objects: MemoryObjectStore;
  mailer: RecordingMailer;
  event: { id: string; slug: string };
};

async function harness(overrides: Partial<AppDeps> = {}): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const objects = new MemoryObjectStore();
  const mailer = new RecordingMailer();
  const app = createApp({
    env,
    db,
    objects,
    mailer,
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
    ...overrides,
  });
  return { app, db, objects, mailer, event: { id: event.id, slug: event.slug } };
}

async function sessionCookie(db: Database, userId: string): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function json(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://api.local${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tokenFromMail(text: string): string {
  const url = new URL(text.trim());
  const token = url.searchParams.get("token");
  assert.ok(token);
  return token;
}

/** Seeds `count` indexed photos with derivatives, in the participant's gallery, scores descending. */
async function seedGallery(
  h: Harness,
  participantId: string,
  count: number,
): Promise<Array<{ photoId: string; score: number }>> {
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  const items: Array<{ photoId: string; faceId: string; score: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const photoId = randomUUID();
    const bytes = Buffer.from(`original-${index}-${"x".repeat(100)}`);
    const originalKey = objectKeys.original(h.event.id, photoId);
    await h.db.insertPhoto({
      id: photoId,
      eventId: h.event.id,
      photographerId: photographer.id,
      sha256: sha256(bytes),
      originalKey,
      contentType: "image/jpeg",
      bytes: bytes.byteLength,
    });
    await h.objects.put(originalKey, bytes, "image/jpeg");
    await h.objects.put(objectKeys.thumb(photoId), Buffer.from(`thumb-${index}`), "image/jpeg");
    await h.objects.put(objectKeys.web(photoId), Buffer.from(`web-${index}`), "image/jpeg");
    await h.db.upsertDerivative({ photoId, kind: "thumb", s3Key: objectKeys.thumb(photoId) });
    await h.db.upsertDerivative({ photoId, kind: "web", s3Key: objectKeys.web(photoId) });
    items.push({ photoId, faceId: randomUUID(), score: 0.99 - index * 0.05 });
  }
  await h.db.replaceGallery(participantId, h.event.id, items, ["anchor-1"]);
  return items.map(({ photoId, score }) => ({ photoId, score }));
}

function countZipEntries(zip: Uint8Array): { signature: boolean; entries: number } {
  const signature =
    zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04;
  let entries = 0;
  for (let index = 0; index + 3 < zip.byteLength; index += 1) {
    if (
      zip[index] === 0x50 &&
      zip[index + 1] === 0x4b &&
      zip[index + 2] === 0x01 &&
      zip[index + 3] === 0x02
    ) {
      entries += 1;
    }
  }
  return { signature, entries };
}

test("request-link is rate limited per email and per ip", async () => {
  const h = await harness();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await h.app.request(
      json("POST", "/v1/auth/request-link", { email: "a@example.com", role: "participant" }),
    );
    assert.equal(res.status, 202);
  }
  const fourth = await h.app.request(
    json("POST", "/v1/auth/request-link", { email: "a@example.com", role: "participant" }),
  );
  assert.equal(fourth.status, 429);
  assert.equal(h.mailer.sent.length, 3);
  const link = h.mailer.sent[0];
  assert.ok(link && link.text.startsWith("http://localhost:3000/verifica?token="));

  const ip = { "x-forwarded-for": "198.51.100.7" };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await h.app.request(
      json(
        "POST",
        "/v1/auth/request-link",
        { email: `ip-${attempt}@example.com`, role: "participant" },
        ip,
      ),
    );
    assert.equal(res.status, 202);
  }
  const blocked = await h.app.request(
    json("POST", "/v1/auth/request-link", { email: "ip-new@example.com", role: "participant" }, ip),
  );
  assert.equal(blocked.status, 429);
  const otherIp = await h.app.request(
    json(
      "POST",
      "/v1/auth/request-link",
      { email: "ip-new@example.com", role: "participant" },
      { "x-forwarded-for": "198.51.100.8" },
    ),
  );
  assert.equal(otherIp.status, 202);
});

test("accept-invite creates the photographer, the membership and a session cookie", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const invite = await h.app.request(
    json(
      "POST",
      "/v1/admin/photographers/invite",
      { email: "New.Shooter@example.com", eventId: h.event.id },
      { cookie: await sessionCookie(h.db, admin.id) },
    ),
  );
  assert.equal(invite.status, 201);
  const mail = h.mailer.sent[0];
  assert.ok(mail);
  assert.equal(mail.to, "new.shooter@example.com");
  assert.ok(mail.text.startsWith("http://localhost:3000/invito?token="));
  const token = tokenFromMail(mail.text);

  const accepted = await h.app.request(json("POST", "/v1/auth/accept-invite", { token }));
  assert.equal(accepted.status, 200);
  const body = (await accepted.json()) as { user: { id: string; email: string; role: string } };
  assert.equal(body.user.email, "new.shooter@example.com");
  assert.equal(body.user.role, "photographer");
  const cookie = accepted.headers.get("set-cookie") ?? "";
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cookie.includes("HttpOnly"));
  assert.equal(await h.db.isEventPhotographer(h.event.id, body.user.id), true);

  const again = await h.app.request(json("POST", "/v1/auth/accept-invite", { token }));
  assert.equal(again.status, 400);
});

test("inviting an existing photographer adds the membership immediately", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const existing = await h.db.createUser({ email: "old@example.com", role: "photographer" });
  assert.equal(await h.db.isEventPhotographer(h.event.id, existing.id), false);
  const res = await h.app.request(
    json(
      "POST",
      "/v1/admin/photographers/invite",
      { email: "old@example.com", eventId: h.event.id },
      { cookie: await sessionCookie(h.db, admin.id) },
    ),
  );
  assert.equal(res.status, 201);
  assert.equal(await h.db.isEventPhotographer(h.event.id, existing.id), true);
});

test("upload init needs membership, rejects oversize files, and binds the byte count", async () => {
  const h = await harness();
  const outsider = await h.db.createUser({ email: "outsider@example.com", role: "photographer" });
  const cookie = await sessionCookie(h.db, outsider.id);
  const payload = {
    eventId: h.event.id,
    filename: "a.jpg",
    contentType: "image/jpeg",
    sha256: "a".repeat(64),
    bytes: 1234,
  };
  const forbidden = await h.app.request(json("POST", "/v1/uploads/init", payload, { cookie }));
  assert.equal(forbidden.status, 403);

  await h.db.addEventPhotographer(h.event.id, outsider.id);
  const tooBig = await h.app.request(
    json("POST", "/v1/uploads/init", { ...payload, bytes: UPLOAD_MAX_BYTES + 1 }, { cookie }),
  );
  assert.equal(tooBig.status, 400);

  const ok = await h.app.request(json("POST", "/v1/uploads/init", payload, { cookie }));
  assert.equal(ok.status, 201);
  const body = (await ok.json()) as { id: string; mode: string; url: string };
  assert.equal(body.mode, "single");
  assert.ok(body.url.includes("length=1234"));
  const session = await h.db.findUploadSession(body.id);
  assert.equal(session?.bytes, 1234);
});

test("upload complete rejects a byte mismatch and aborts the session", async () => {
  const h = await harness();
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  const cookie = await sessionCookie(h.db, photographer.id);
  const bytes = Buffer.from("hello world");
  const init = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      {
        eventId: h.event.id,
        filename: "a.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength + 5,
      },
      { cookie },
    ),
  );
  assert.equal(init.status, 201);
  const session = (await init.json()) as { id: string; objectKey: string };
  await h.objects.put(session.objectKey, bytes, "image/jpeg");
  const complete = await h.app.request(
    json("POST", `/v1/uploads/${session.id}/complete`, { parts: [] }, { cookie }),
  );
  assert.equal(complete.status, 400);
  assert.deepEqual(await complete.json(), { error: MESSAGES.sizeMismatch });
  assert.equal((await h.db.findUploadSession(session.id))?.status, "aborted");

  const summary = await h.app.request(
    new Request(`http://api.local/v1/uploads/summary?eventId=${h.event.id}`, {
      headers: { cookie },
    }),
  );
  assert.equal(summary.status, 200);
  assert.deepEqual(await summary.json(), {
    sessions: { open: 0, completed: 0, aborted: 1 },
    photos: { uploaded: 0, processing: 0, indexed: 0, error: 0, originalsPending: 0 },
  });
});

test("upload complete of a duplicate sha answers 409 and drops the orphan object", async () => {
  const h = await harness();
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  const cookie = await sessionCookie(h.db, photographer.id);
  const bytes = Buffer.from("same bytes twice");
  const init = async () => {
    const response = await h.app.request(
      json(
        "POST",
        "/v1/uploads/init",
        {
          eventId: h.event.id,
          filename: "a.jpg",
          contentType: "image/jpeg",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
        },
        { cookie },
      ),
    );
    assert.equal(response.status, 201);
    return (await response.json()) as { id: string; objectKey: string };
  };
  // Both sessions open before either completes, so init cannot see the duplicate yet.
  const first = await init();
  const second = await init();
  await h.objects.put(first.objectKey, bytes, "image/jpeg");
  await h.objects.put(second.objectKey, bytes, "image/jpeg");

  const complete = (id: string) =>
    h.app.request(json("POST", `/v1/uploads/${id}/complete`, { parts: [] }, { cookie }));
  assert.equal((await complete(first.id)).status, 201);
  const duplicate = await complete(second.id);
  assert.equal(duplicate.status, 409);
  assert.equal((await h.db.findUploadSession(second.id))?.status, "aborted");
  assert.equal(h.objects.objects.has(second.objectKey), false);
  assert.equal(h.objects.objects.has(first.objectKey), true);
  // Completing the first session again is a conflict on its status, not a deletion.
  assert.equal((await complete(first.id)).status, 409);
  assert.equal(h.objects.objects.has(first.objectKey), true);
});

test("bodies above the api limit are refused with 413", async () => {
  const h = await harness();
  const response = await h.app.request(
    new Request("http://api.local/v1/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", role: "participant", pad: "x".repeat(API_BODY_MAX_BYTES) }),
    }),
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: MESSAGES.validation });
});

test("upload list is paged with an opaque cursor", async () => {
  const h = await harness();
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  const cookie = await sessionCookie(h.db, photographer.id);
  for (let index = 0; index < 3; index += 1) {
    await h.db.insertUploadSession({
      id: randomUUID(),
      eventId: h.event.id,
      photographerId: photographer.id,
      s3UploadId: null,
      objectKey: objectKeys.original(h.event.id, randomUUID()),
      sha256: String(index).repeat(64),
      contentType: "image/jpeg",
      bytes: 10,
    });
  }
  const first = await h.app.request(
    new Request(`http://api.local/v1/uploads?eventId=${h.event.id}&limit=2`, {
      headers: { cookie },
    }),
  );
  assert.equal(first.status, 200);
  const page1 = (await first.json()) as { uploads: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(page1.uploads.length, 2);
  assert.ok(page1.nextCursor);
  const second = await h.app.request(
    new Request(
      `http://api.local/v1/uploads?eventId=${h.event.id}&limit=2&cursor=${page1.nextCursor}`,
      { headers: { cookie } },
    ),
  );
  const page2 = (await second.json()) as { uploads: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(page2.uploads.length, 1);
  assert.equal(page2.nextCursor, null);
  const ids = new Set([...page1.uploads, ...page2.uploads].map((row) => row.id));
  assert.equal(ids.size, 3);
});

test("gallery is paged by score cursor and reports ready once a gallery exists", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "guest@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);

  const empty = galleryResponseSchema.parse(
    await (
      await h.app.request(
        new Request(`http://api.local/v1/events/${h.event.slug}/gallery`, { headers: { cookie } }),
      )
    ).json(),
  );
  assert.equal(empty.status, "empty");
  assert.equal(empty.total, 0);
  assert.equal(empty.nextCursor, null);

  const seeded = await seedGallery(h, participant.id, 3);
  const first = await h.app.request(
    new Request(`http://api.local/v1/events/${h.event.slug}/gallery?limit=2`, {
      headers: { cookie },
    }),
  );
  assert.equal(first.status, 200);
  const page1 = galleryResponseSchema.parse(await first.json());
  assert.equal(page1.status, "ready");
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);
  assert.deepEqual(
    page1.items.map((item) => item.photoId),
    seeded.slice(0, 2).map((item) => item.photoId),
  );
  assert.equal(page1.items[0]?.source, "match");
  assert.ok(page1.items[0]?.thumbUrl.includes(objectKeys.thumb(seeded[0]!.photoId)));
  assert.ok(page1.nextCursor);

  const second = await h.app.request(
    new Request(
      `http://api.local/v1/events/${h.event.slug}/gallery?limit=2&cursor=${page1.nextCursor}`,
      { headers: { cookie } },
    ),
  );
  const page2 = galleryResponseSchema.parse(await second.json());
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0]?.photoId, seeded[2]?.photoId);
  assert.equal(page2.nextCursor, null);

  const bad = await h.app.request(
    new Request(`http://api.local/v1/events/${h.event.slug}/gallery?cursor=not-a-cursor`, {
      headers: { cookie },
    }),
  );
  assert.equal(bad.status, 400);
});

test("presigned GET URLs are stable inside a signing window", async () => {
  const store = createS3ObjectStore(env);
  let first = await store.presignGet("thumbs/example.jpg");
  let second = await store.presignGet("thumbs/example.jpg");
  if (first !== second) {
    // The window rolled over between the two calls; sign again inside the new window.
    first = await store.presignGet("thumbs/example.jpg");
    second = await store.presignGet("thumbs/example.jpg");
  }
  assert.equal(first, second);
  const url = new URL(first);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "1800");
  const stamp = signingWindowStart()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  assert.equal(url.searchParams.get("X-Amz-Date"), stamp);
  assert.equal(signingWindowStart(new Date("2026-10-07T10:17:45Z")).toISOString(), "2026-10-07T10:10:00.000Z");
});

test("download signs the web derivative when asked, and rejects photos outside the gallery", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "guest@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  const seeded = await seedGallery(h, participant.id, 2);
  const res = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/download`,
      { photoIds: [seeded[1]!.photoId], variant: "web" },
      { cookie },
    ),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { urls: Array<{ photoId: string; url: string }> };
  assert.deepEqual(body.urls, [
    { photoId: seeded[1]!.photoId, url: `http://localhost:9000/${objectKeys.web(seeded[1]!.photoId)}` },
  ]);

  const original = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/download`,
      { photoIds: [seeded[0]!.photoId] },
      { cookie },
    ),
  );
  const originalBody = (await original.json()) as { urls: Array<{ url: string }> };
  assert.ok(originalBody.urls[0]?.url.includes(objectKeys.original(h.event.id, seeded[0]!.photoId)));

  const foreign = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/download`,
      { photoIds: [seeded[0]!.photoId, randomUUID()] },
      { cookie },
    ),
  );
  assert.equal(foreign.status, 403);
});

test("zip streams a store-mode archive of the owned photos", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "guest@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  const seeded = await seedGallery(h, participant.id, 3);
  const form = new URLSearchParams({
    ids: seeded.map((item) => item.photoId).join(","),
    variant: "original",
  });
  const res = await h.app.request(
    new Request(`http://api.local/v1/events/${h.event.slug}/gallery/zip`, {
      method: "POST",
      headers: { cookie, origin: "http://localhost:3000" },
      body: form,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="rephoto-demo.zip"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  const zip = new Uint8Array(await res.arrayBuffer());
  const parsed = countZipEntries(zip);
  assert.equal(parsed.signature, true);
  assert.equal(parsed.entries, 3);
  const text = Buffer.from(zip).toString("latin1");
  assert.ok(text.includes("demo-0001.jpg"));
  assert.ok(text.includes("demo-0003.jpg"));
  assert.ok(text.includes("original-2-"));

  const jsonRes = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [seeded[0]!.photoId], variant: "web" },
      { cookie },
    ),
  );
  assert.equal(jsonRes.status, 200);
  const jsonZip = new Uint8Array(await jsonRes.arrayBuffer());
  assert.equal(countZipEntries(jsonZip).entries, 1);
  assert.ok(Buffer.from(jsonZip).toString("latin1").includes("web-0"));

  const badOrigin = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [seeded[0]!.photoId] },
      { cookie, origin: "http://evil.example" },
    ),
  );
  assert.equal(badOrigin.status, 403);

  // Navigation POSTs carry `Origin: null` under a referrer-hiding policy; accept only same-origin.
  const nullOriginSameSite = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [seeded[0]!.photoId] },
      { cookie, origin: "null", "sec-fetch-site": "same-origin" },
    ),
  );
  assert.equal(nullOriginSameSite.status, 200);
  const nullOriginCrossSite = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [seeded[0]!.photoId] },
      { cookie, origin: "null", "sec-fetch-site": "cross-site" },
    ),
  );
  assert.equal(nullOriginCrossSite.status, 403);

  const notOwned = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [randomUUID()] },
      { cookie },
    ),
  );
  assert.equal(notOwned.status, 403);
});

test("selfie is refused when the event is list-based and the email is not on it", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const adminCookie = await sessionCookie(h.db, admin.id);
  const patched = await h.app.request(
    json("PATCH", `/v1/admin/events/${h.event.id}`, { access: "list" }, { cookie: adminCookie }),
  );
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as { access: string }).access, "list");
  const shown = (await (await h.app.request(`http://api.local/v1/events/${h.event.slug}`)).json()) as {
    access: string;
  };
  assert.equal(shown.access, "list");

  const participant = await h.db.createUser({ email: "guest@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  await h.db.insertConsent({
    userId: participant.id,
    eventId: h.event.id,
    textVersion: CONSENT_TEXT_VERSION,
    ip: "127.0.0.1",
    userAgent: "test",
  });
  const selfie = () => {
    const form = new FormData();
    form.set("selfie", new File([Buffer.from("not really a jpeg")], "me.jpg", { type: "image/jpeg" }));
    return h.app.request(
      new Request(`http://api.local/v1/events/${h.event.slug}/selfie`, {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
  };
  const refused = await selfie();
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: MESSAGES.notOnList });

  const imported = await h.app.request(
    json(
      "POST",
      "/v1/admin/participants/import",
      { eventId: h.event.id, emails: ["Guest@Example.com", "other@example.com"] },
      { cookie: adminCookie },
    ),
  );
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { inserted: 2 });
  const allowed = await selfie();
  assert.equal(allowed.status, 202);
});

test("health reports 503 when the database does not answer", async () => {
  const h = await harness();
  const ok = await h.app.request("http://api.local/health");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const broken = new MemoryDatabase();
  broken.ping = async () => {
    throw new Error("connection refused");
  };
  const down = await harness({ db: broken });
  const res = await down.app.request("http://api.local/v1/health");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false });
});

test("admin metrics expose the extended shape", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const res = await h.app.request(
    new Request("http://api.local/v1/admin/metrics", {
      headers: { cookie: await sessionCookie(h.db, admin.id) },
    }),
  );
  assert.equal(res.status, 200);
  const metrics = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(metrics.photosByStatus, { uploaded: 0, processing: 0, indexed: 0, error: 0 });
  assert.equal(metrics.jobsRunning, 0);
  assert.equal(metrics.jobsError, 0);
  assert.equal(metrics.galleries, 0);
  assert.equal(metrics.originalsPending, 0);
});

async function photographerCookie(h: Harness): Promise<{ id: string; cookie: string }> {
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  return { id: photographer.id, cookie: await sessionCookie(h.db, photographer.id) };
}

/** Runs the web stage of a web-first upload to completion; returns the photo id. */
async function webStage(
  h: Harness,
  cookie: string,
  input: { original: Uint8Array; web: Uint8Array; originalContentType?: "image/jpeg" | "image/png" },
): Promise<{ photoId: string; objectKey: string }> {
  const init = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      {
        eventId: h.event.id,
        filename: "a.jpg",
        contentType: "image/jpeg",
        sha256: sha256(input.original),
        bytes: input.web.byteLength,
        stage: "web",
        originalContentType: input.originalContentType ?? "image/jpeg",
        originalBytes: input.original.byteLength,
      },
      { cookie },
    ),
  );
  assert.equal(init.status, 201);
  const session = (await init.json()) as { id: string; objectKey: string; mode: string; url: string };
  assert.equal(session.mode, "single");
  assert.ok(session.url.includes(`length=${input.web.byteLength}`));
  assert.match(session.objectKey, /^web\/[0-9a-f-]{36}\.jpg$/);
  await h.objects.put(session.objectKey, input.web, "image/jpeg");
  const complete = await h.app.request(
    json("POST", `/v1/uploads/${session.id}/complete`, { parts: [] }, { cookie }),
  );
  assert.equal(complete.status, 201);
  const body = uploadCompleteResponseSchema.parse(await complete.json());
  assert.equal(body.status, "uploaded");
  assert.equal(session.objectKey, objectKeys.web(body.photoId));
  return { photoId: body.photoId, objectKey: session.objectKey };
}

test("web stage creates a pending photo with its web derivative and queues derive", async () => {
  const h = await harness();
  const { id: photographerId, cookie } = await photographerCookie(h);
  const original = Buffer.from(`original-${"o".repeat(500)}`);
  const web = Buffer.from(`web-${"w".repeat(100)}`);

  const tooBig = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      {
        eventId: h.event.id,
        filename: "a.jpg",
        contentType: "image/jpeg",
        sha256: sha256(original),
        bytes: WEB_STAGE_MAX_BYTES + 1,
        stage: "web",
        originalContentType: "image/jpeg",
        originalBytes: original.byteLength,
      },
      { cookie },
    ),
  );
  assert.equal(tooBig.status, 400);

  const { photoId, objectKey } = await webStage(h, cookie, { original, web });
  const photo = await h.db.findPhoto(photoId);
  assert.ok(photo);
  assert.equal(photo.originalStatus, "pending");
  assert.equal(photo.status, "uploaded");
  assert.equal(photo.sha256, sha256(original));
  assert.equal(photo.bytes, original.byteLength);
  assert.equal(photo.contentType, "image/jpeg");
  assert.equal(photo.originalKey, objectKeys.original(h.event.id, photoId));
  assert.equal(photo.photographerId, photographerId);
  assert.deepEqual(await h.db.listDerivatives(photoId), [{ kind: "web", s3Key: objectKey }]);
  const job = await h.db.claimJob();
  assert.equal(job?.type, "derive");
  assert.deepEqual(job?.payload, { photoId });
  assert.equal(await h.db.claimJob(), null);

  // The same original again (any stage) is a conflict while the photo exists.
  const again = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      {
        eventId: h.event.id,
        filename: "a.jpg",
        contentType: "image/jpeg",
        sha256: sha256(original),
        bytes: original.byteLength,
      },
      { cookie },
    ),
  );
  assert.equal(again.status, 409);

  const summary = await h.app.request(
    new Request(`http://api.local/v1/uploads/summary?eventId=${h.event.id}`, {
      headers: { cookie },
    }),
  );
  assert.deepEqual(uploadSummaryResponseSchema.parse(await summary.json()), {
    sessions: { open: 0, completed: 1, aborted: 0 },
    photos: { uploaded: 1, processing: 0, indexed: 0, error: 0, originalsPending: 1 },
  });
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const metrics = (await (
    await h.app.request(
      new Request("http://api.local/v1/admin/metrics", {
        headers: { cookie: await sessionCookie(h.db, admin.id) },
      }),
    )
  ).json()) as { originalsPending: number; photosByStatus: { uploaded: number } };
  assert.equal(metrics.originalsPending, 1);
  assert.equal(metrics.photosByStatus.uploaded, 1);
});

test("web stage complete with a byte mismatch aborts the session and drops the object", async () => {
  const h = await harness();
  const { cookie } = await photographerCookie(h);
  const original = Buffer.from("original bytes here");
  const web = Buffer.from("web bytes");
  const init = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      {
        eventId: h.event.id,
        filename: "a.jpg",
        contentType: "image/jpeg",
        sha256: sha256(original),
        bytes: web.byteLength + 1,
        stage: "web",
        originalContentType: "image/png",
        originalBytes: original.byteLength,
      },
      { cookie },
    ),
  );
  assert.equal(init.status, 201);
  const session = (await init.json()) as { id: string; objectKey: string };
  await h.objects.put(session.objectKey, web, "image/jpeg");
  const complete = await h.app.request(
    json("POST", `/v1/uploads/${session.id}/complete`, { parts: [] }, { cookie }),
  );
  assert.equal(complete.status, 400);
  assert.deepEqual(await complete.json(), { error: MESSAGES.sizeMismatch });
  assert.equal((await h.db.findUploadSession(session.id))?.status, "aborted");
  assert.equal(h.objects.objects.has(session.objectKey), false);
  assert.equal(await h.db.findPhotoBySha(h.event.id, sha256(original)), null);
});

test("original stage of a web-first photo checks ownership and declaration, then queues verify", async () => {
  const h = await harness();
  const { cookie } = await photographerCookie(h);
  const original = Buffer.from(`original-${"o".repeat(300)}`);
  const web = Buffer.from("web-small");
  const { photoId } = await webStage(h, cookie, { original, web });
  await h.db.claimJob(); // the derive job; not run here

  const base = {
    eventId: h.event.id,
    filename: "a.jpg",
    contentType: "image/jpeg",
    sha256: sha256(original),
    bytes: original.byteLength,
    stage: "original",
    photoId,
  };
  const init = (body: unknown, who = cookie) =>
    h.app.request(json("POST", "/v1/uploads/init", body, { cookie: who }));

  assert.equal((await init({ ...base, sha256: "b".repeat(64) })).status, 400);
  assert.equal((await init({ ...base, bytes: original.byteLength + 1 })).status, 400);
  assert.equal((await init({ ...base, photoId: randomUUID() })).status, 404);
  const other = await h.db.createUser({ email: "other@example.com", role: "photographer" });
  await h.db.addEventPhotographer(h.event.id, other.id);
  assert.equal((await init(base, await sessionCookie(h.db, other.id))).status, 404);

  const ok = await init(base);
  assert.equal(ok.status, 201);
  const session = (await ok.json()) as { id: string; objectKey: string; mode: string; url: string };
  assert.equal(session.mode, "single");
  assert.equal(session.objectKey, objectKeys.original(h.event.id, photoId));
  assert.ok(session.url.includes(`length=${original.byteLength}`));
  const row = await h.db.findUploadSession(session.id);
  assert.equal(row?.stage, "original");
  assert.equal(row?.photoId, photoId);

  // Wrong size on complete: the session aborts, the object goes, the photo stays pending.
  await h.objects.put(session.objectKey, Buffer.from("short"), "image/jpeg");
  const short = await h.app.request(
    json("POST", `/v1/uploads/${session.id}/complete`, { parts: [] }, { cookie }),
  );
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: MESSAGES.sizeMismatch });
  assert.equal(h.objects.objects.has(session.objectKey), false);
  assert.equal((await h.db.findPhoto(photoId))?.originalStatus, "pending");
  assert.equal(await h.db.claimJob(), null);

  const retry = await init(base);
  assert.equal(retry.status, 201);
  const second = (await retry.json()) as { id: string; objectKey: string };
  await h.objects.put(second.objectKey, original, "image/jpeg");
  const complete = await h.app.request(
    json("POST", `/v1/uploads/${second.id}/complete`, { parts: [] }, { cookie }),
  );
  assert.equal(complete.status, 201);
  assert.deepEqual(uploadCompleteResponseSchema.parse(await complete.json()), {
    photoId,
    status: "original_received",
  });
  assert.equal((await h.db.findPhoto(photoId))?.originalStatus, "present");
  assert.equal((await h.db.findUploadSession(second.id))?.status, "completed");
  const verify = await h.db.claimJob();
  assert.equal(verify?.type, "verify");
  assert.deepEqual(verify?.payload, { photoId });
  assert.equal(await h.db.claimJob(), null);
  assert.deepEqual(await h.db.listDerivatives(photoId), [
    { kind: "web", s3Key: objectKeys.web(photoId) },
  ]);

  // Once present, re-opening the original stage is a conflict (the client marks the file as sent).
  assert.equal((await init(base)).status, 409);
});

test("original stage complete is idempotent and re-derives a photo that failed on its web object", async () => {
  const h = await harness();
  const { cookie } = await photographerCookie(h);
  const original = Buffer.from(`original-${"o".repeat(200)}`);
  const web = Buffer.from("web-not-an-image");
  const { photoId } = await webStage(h, cookie, { original, web });
  // The first derive failed terminally on the client-made web object (not an image).
  const firstDerive = await h.db.claimJob();
  assert.equal(firstDerive?.type, "derive");
  await h.db.failJobTerminal(firstDerive!.id, "Input buffer contains unsupported image format");
  await h.db.setPhotoError(photoId, "Input buffer contains unsupported image format");

  const base = {
    eventId: h.event.id,
    filename: "a.jpg",
    contentType: "image/jpeg",
    sha256: sha256(original),
    bytes: original.byteLength,
    stage: "original",
    photoId,
  };
  const init = async () => {
    const response = await h.app.request(json("POST", "/v1/uploads/init", base, { cookie }));
    assert.equal(response.status, 201);
    return (await response.json()) as { id: string; objectKey: string };
  };
  const complete = (id: string) =>
    h.app.request(json("POST", `/v1/uploads/${id}/complete`, { parts: [] }, { cookie }));

  // Two sessions opened while the original was still pending (a retry after a lost answer).
  const first = await init();
  const second = await init();
  await h.objects.put(first.objectKey, original, "image/jpeg");

  const done = await complete(first.id);
  assert.equal(done.status, 201);
  assert.deepEqual(await done.json(), { photoId, status: "original_received" });
  let photo = await h.db.findPhoto(photoId);
  assert.equal(photo?.originalStatus, "present");
  assert.equal(photo?.status, "error");
  assert.equal(photo?.error, null);
  const jobs = [await h.db.claimJob(), await h.db.claimJob()];
  assert.deepEqual(
    jobs.map((job) => job?.type).sort(),
    ["derive", "verify"],
  );
  for (const job of jobs) assert.deepEqual(job?.payload, { photoId });
  assert.equal(await h.db.claimJob(), null);

  // The second session completes on the same (already present) object: same answer, no new jobs.
  const again = await complete(second.id);
  assert.equal(again.status, 201);
  assert.deepEqual(await again.json(), { photoId, status: "original_received" });
  assert.equal((await h.db.findUploadSession(second.id))?.status, "completed");
  assert.equal(h.objects.objects.has(first.objectKey), true);
  assert.equal(await h.db.claimJob(), null);
  photo = await h.db.findPhoto(photoId);
  assert.equal(photo?.originalStatus, "present");

  // A completed session cannot be completed twice.
  assert.equal((await complete(first.id)).status, 409);
});

test("upload lookup answers only for the caller's own photos", async () => {
  const h = await harness();
  const { cookie } = await photographerCookie(h);
  const original = Buffer.from("lookup original");
  const { photoId } = await webStage(h, cookie, { original, web: Buffer.from("lookup web") });
  const lookup = (sha: string, who = cookie) =>
    h.app.request(
      new Request(`http://api.local/v1/uploads/lookup?eventId=${h.event.id}&sha256=${sha}`, {
        headers: { cookie: who },
      }),
    );
  const found = await lookup(sha256(original));
  assert.equal(found.status, 200);
  assert.deepEqual(uploadLookupResponseSchema.parse(await found.json()), {
    photoId,
    originalStatus: "pending",
    status: "uploaded",
  });
  assert.equal((await lookup("c".repeat(64))).status, 404);
  assert.equal((await lookup("not-a-sha")).status, 400);
  const other = await h.db.createUser({ email: "other@example.com", role: "photographer" });
  assert.equal((await lookup(sha256(original), await sessionCookie(h.db, other.id))).status, 404);

  await h.db.setOriginalStatus(photoId, "present");
  const present = uploadLookupResponseSchema.parse(await (await lookup(sha256(original))).json());
  assert.equal(present.originalStatus, "present");
});

test("gallery, download and zip fall back to the web derivative while the original is pending", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "guest@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  const seeded = await seedGallery(h, participant.id, 2);
  const pending = seeded[0]!.photoId;
  const ready = seeded[1]!.photoId;
  // Make the first photo a web-first PNG whose original has not arrived.
  await h.db.setOriginalStatus(pending, "pending");
  const pendingRow = await h.db.findPhoto(pending);
  assert.ok(pendingRow);
  pendingRow.contentType = "image/png";
  h.objects.objects.delete(pendingRow.originalKey);

  const gallery = galleryResponseSchema.parse(
    await (
      await h.app.request(
        new Request(`http://api.local/v1/events/${h.event.slug}/gallery`, { headers: { cookie } }),
      )
    ).json(),
  );
  assert.deepEqual(
    gallery.items.map((item) => [item.photoId, item.originalReady]),
    [
      [pending, false],
      [ready, true],
    ],
  );

  const download = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/download`,
      { photoIds: [pending, ready], variant: "original" },
      { cookie },
    ),
  );
  assert.equal(download.status, 200);
  assert.deepEqual(await download.json(), {
    urls: [
      { photoId: pending, url: `http://localhost:9000/${objectKeys.web(pending)}` },
      { photoId: ready, url: `http://localhost:9000/${objectKeys.original(h.event.id, ready)}` },
    ],
  });

  const zip = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/gallery/zip`,
      { photoIds: [pending, ready], variant: "original" },
      { cookie },
    ),
  );
  assert.equal(zip.status, 200);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(countZipEntries(bytes).entries, 2);
  const text = Buffer.from(bytes).toString("latin1");
  // The pending PNG is served as its web JPEG, so its entry is .jpg; the web bytes are inside.
  assert.ok(text.includes("demo-0001.jpg"));
  assert.ok(!text.includes("demo-0001.png"));
  assert.ok(text.includes("web-0"));
  assert.ok(text.includes("original-1-"));
});

test("presigned URLs use S3_PUBLIC_ENDPOINT when set, S3_ENDPOINT otherwise", async () => {
  const internal = createS3ObjectStore(env);
  assert.equal(new URL(await internal.presignGet("thumbs/x.jpg")).origin, "http://localhost:9000");
  assert.equal(
    new URL(await internal.presignPut("web/x.jpg", "image/jpeg", 10)).origin,
    "http://localhost:9000",
  );

  const publicEnv: Env = envSchema.parse({
    DATABASE_URL: env.DATABASE_URL,
    S3_ENDPOINT: "http://minio:9000",
    S3_PUBLIC_ENDPOINT: "https://media.example.com",
    S3_BUCKET: "rephoto",
    S3_ACCESS_KEY: "rephoto",
    S3_SECRET_KEY: "rephoto-secret",
    S3_REGION: "eu-central-1",
    SESSION_SECRET: "test-session-secret-value",
    FACE_ENGINE: "fake",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1025",
    SMTP_FROM: "noreply@rephoto.local",
    WEB_ORIGIN: "https://example.com",
    API_ORIGIN: "https://example.com",
  });
  const store = createS3ObjectStore(publicEnv);
  const get = new URL(await store.presignGet("thumbs/x.jpg"));
  assert.equal(get.origin, "https://media.example.com");
  // Path style: the bucket stays in the path, so no `rephoto.media.example.com` DNS record is needed.
  assert.equal(get.pathname, "/rephoto/thumbs/x.jpg");
  assert.equal(get.searchParams.get("X-Amz-Expires"), "1800");
  const put = new URL(await store.presignPut("web/x.jpg", "image/jpeg", 10));
  assert.equal(put.origin, "https://media.example.com");
  assert.equal(put.pathname, "/rephoto/web/x.jpg");
  const part = new URL(await store.presignUploadPart("originals/x.jpg", "upload-1", 2));
  assert.equal(part.origin, "https://media.example.com");
  assert.equal(part.searchParams.get("partNumber"), "2");
  assert.equal(part.searchParams.get("uploadId"), "upload-1");
});

test("selfie records the liveness field in the audit log and defaults it to file", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "live@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  await h.db.insertConsent({
    userId: participant.id,
    eventId: h.event.id,
    textVersion: CONSENT_TEXT_VERSION,
    ip: "127.0.0.1",
    userAgent: "test",
  });
  const audits: Array<{ actorId: string | null; action: string; target: string; meta: Record<string, unknown> }> = [];
  const db: Database = h.db;
  db.insertAudit = async (input) => {
    audits.push(input);
  };
  const post = (liveness?: string) => {
    const form = new FormData();
    form.set("selfie", new File([Buffer.from("not really a jpeg")], "me.jpg", { type: "image/jpeg" }));
    if (liveness !== undefined) form.set("liveness", liveness);
    return h.app.request(
      new Request(`http://api.local/v1/events/${h.event.slug}/selfie`, {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
  };

  assert.equal((await post("challenge")).status, 202);
  assert.equal((await post()).status, 202);
  const bogus = await post("bogus");
  assert.equal(bogus.status, 400);
  assert.deepEqual(await bogus.json(), { error: MESSAGES.validation });

  const target = `event:${h.event.id}`;
  assert.deepEqual(
    audits.map((row) => [row.actorId, row.action, row.target, row.meta]),
    [
      [participant.id, "selfie.submitted", target, { liveness: "challenge" }],
      [participant.id, "selfie.submitted", target, { liveness: "file" }],
    ],
  );
});
