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
  PUBLIC_UPLOAD_RATE_LIMIT,
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
import { hashPassword, sha256Hex } from "../src/crypto.ts";
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

test("staff password login issues a session; wrong password and participant role are refused", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  await h.db.setUserPassword(admin.id, hashPassword("s3cret-pass"));

  const ok = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "admin@rephoto.local",
      password: "s3cret-pass",
      role: "admin",
    }),
  );
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie") ?? "";
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(cookie.includes("HttpOnly"));

  const wrong = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "admin@rephoto.local",
      password: "nope",
      role: "admin",
    }),
  );
  assert.equal(wrong.status, 401);

  // No password set on the seeded photographer → refused.
  const unset = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "photographer@rephoto.local",
      password: "anything",
      role: "photographer",
    }),
  );
  assert.equal(unset.status, 401);

  // Participants are magic-link only — the schema rejects the role.
  const participant = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "p@example.com",
      password: "whatever",
      role: "participant",
    }),
  );
  assert.equal(participant.status, 400);
});

test("admin creates staff credentials that then work for login", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);

  const created = await h.app.request(
    json(
      "POST",
      "/v1/admin/staff",
      { email: "Shooter@Studio.it", role: "photographer", password: "photo-pass-123", eventId: h.event.id },
      { cookie: await sessionCookie(h.db, admin.id) },
    ),
  );
  assert.equal(created.status, 200);
  const body = (await created.json()) as { user: { id: string; email: string; role: string } };
  assert.equal(body.user.email, "shooter@studio.it");
  assert.equal(body.user.role, "photographer");
  assert.equal(await h.db.isEventPhotographer(h.event.id, body.user.id), true);

  const login = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "shooter@studio.it",
      password: "photo-pass-123",
      role: "photographer",
    }),
  );
  assert.equal(login.status, 200);

  // Short password is rejected by the schema.
  const short = await h.app.request(
    json(
      "POST",
      "/v1/admin/staff",
      { email: "x@studio.it", role: "photographer", password: "short" },
      { cookie: await sessionCookie(h.db, admin.id) },
    ),
  );
  assert.equal(short.status, 400);

  // Without an admin session the endpoint is unauthorized.
  const anon = await h.app.request(
    json("POST", "/v1/admin/staff", { email: "y@studio.it", role: "admin", password: "longenough1" }),
  );
  assert.equal(anon.status, 401);
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

// ---- v5 (agent A): gallery reason, admin requeue --------------------------------------------

test("gallery reports the last match reason and null after a successful match", async () => {
  const h = await harness();
  const participant = await h.db.createUser({ email: "reason@example.com", role: "participant" });
  const cookie = await sessionCookie(h.db, participant.id);
  const read = async () =>
    galleryResponseSchema.parse(
      await (
        await h.app.request(
          new Request(`http://api.local/v1/events/${h.event.slug}/gallery`, { headers: { cookie } }),
        )
      ).json(),
    );
  assert.equal((await read()).reason, null, "no gallery yet");

  await h.db.replaceGallery(participant.id, h.event.id, [], []);
  await h.db.updateGalleryMatch(participant.id, h.event.id, { lastMatchReason: "face_too_small" });
  let body = await read();
  assert.equal(body.status, "ready");
  assert.equal(body.total, 0);
  assert.equal(body.reason, "face_too_small");

  await h.db.updateGalleryMatch(participant.id, h.event.id, { lastMatchReason: "no_photos_yet", queryEmbedding: [1, 0] });
  assert.equal((await read()).reason, "no_photos_yet");

  await seedGallery(h, participant.id, 1);
  await h.db.updateGalleryMatch(participant.id, h.event.id, { lastMatchReason: null });
  body = await read();
  assert.equal(body.total, 1);
  assert.equal(body.reason, null);

  // An unknown value in the column never leaks: it is reported as null.
  await h.db.updateGalleryMatch(participant.id, h.event.id, { lastMatchReason: "something_else" });
  assert.equal((await read()).reason, null);
});

test("admin requeue resets error photos and enqueues derive or index depending on the web derivative", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const cookie = await sessionCookie(h.db, admin.id);
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  h.db.insertAudit = async (input) => {
    audits.push({ action: input.action, meta: input.meta });
  };
  const photo = async (status: "error" | "indexed", error: string | null, withWeb: boolean) => {
    const id = randomUUID();
    await h.db.insertPhoto({
      id,
      eventId: h.event.id,
      photographerId: photographer.id,
      sha256: `sha-${id}`,
      originalKey: objectKeys.original(h.event.id, id),
      contentType: "image/jpeg",
      bytes: 10,
    });
    if (status === "error") await h.db.setPhotoError(id, error ?? "");
    else await h.db.setPhotoIndexed(id);
    if (withWeb) {
      await h.db.upsertDerivative({ photoId: id, kind: "web", s3Key: objectKeys.web(id) });
      await h.db.upsertDerivative({ photoId: id, kind: "thumb", s3Key: objectKeys.thumb(id) });
    }
    return id;
  };
  const noWeb = await photo("error", "Face service answered 503", false);
  const withWeb = await photo("error", "Face service at http://face unreachable", true);
  const other = await photo("error", "sha256 mismatch", true);
  const fine = await photo("indexed", null, true);

  // Only photos whose error matches `errorLike`.
  const filtered = await h.app.request(
    json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id, errorLike: "face service" }, { cookie }),
  );
  assert.equal(filtered.status, 200);
  assert.deepEqual(await filtered.json(), { requeued: 2 });
  assert.equal((await h.db.findPhoto(noWeb))?.status, "uploaded");
  assert.equal((await h.db.findPhoto(noWeb))?.error, null);
  assert.equal((await h.db.findPhoto(withWeb))?.status, "processing");
  assert.equal((await h.db.findPhoto(other))?.status, "error", "not matched by errorLike");
  assert.equal((await h.db.findPhoto(fine))?.status, "indexed");
  const claimedTypes: string[] = [];
  for (;;) {
    const claimed = await h.db.claimJob();
    if (!claimed) break;
    claimedTypes.push(`${claimed.type}:${(claimed.payload as { photoId: string }).photoId}`);
    await h.db.completeJob(claimed.id);
  }
  assert.deepEqual(claimedTypes.sort(), [`derive:${noWeb}`, `index:${withWeb}`].sort());
  assert.deepEqual(audits, [
    { action: "photos.requeued", meta: { status: "error", errorLike: "face service", requeued: 2 } },
  ]);

  // Without a filter every remaining error photo goes back.
  const all = await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id }, { cookie }));
  assert.deepEqual(await all.json(), { requeued: 1 });
  assert.equal((await h.db.findPhoto(other))?.status, "processing");

  // Validation and authorization.
  assert.equal((await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: "nope" }, { cookie }))).status, 400);
  assert.equal(
    (await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id, errorLike: "" }, { cookie }))).status,
    400,
  );
  assert.equal(
    (await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id, errorLike: "x".repeat(201) }, { cookie }))).status,
    400,
  );
  assert.equal((await h.app.request(json("POST", "/v1/admin/photos/requeue", "nope", { cookie }))).status, 400);
  assert.deepEqual(adminRequeueBodySchema.parse({ eventId: h.event.id }), { eventId: h.event.id, status: "error" });
  assert.equal(
    (await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id, status: "indexed" }, { cookie }))).status,
    400,
  );
  assert.equal(
    (await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id, extra: 1 }, { cookie }))).status,
    400,
  );
  assert.equal(
    (await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: randomUUID() }, { cookie }))).status,
    404,
  );
  const participant = await h.db.createUser({ email: "p@example.com", role: "participant" });
  const forbidden = await h.app.request(
    json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id }, { cookie: await sessionCookie(h.db, participant.id) }),
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await h.app.request(json("POST", "/v1/admin/photos/requeue", { eventId: h.event.id }))).status, 401);
});

test("deleting a photo drops it from the anchors of every gallery", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const participant = await h.db.createUser({ email: "anchored@example.com", role: "participant" });
  const seeded = await seedGallery(h, participant.id, 1);
  const photoId = seeded[0]!.photoId;
  await h.db.replaceFaces(photoId, h.event.id, [
    { externalId: "ext-anchor", bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 },
  ]);
  await h.db.replaceGallery(participant.id, h.event.id, [], ["ext-anchor", "ext-other"]);
  const res = await h.app.request(
    new Request(`http://api.local/v1/admin/photos/${photoId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(h.db, admin.id) },
    }),
  );
  assert.equal(res.status, 204);
  assert.deepEqual((await h.db.findGalleryByUser(participant.id, h.event.id))?.anchorFaceIds, ["ext-other"]);
});

// ---- admin and participant tooling v5 (agent D) ------------------------------------------

import {
  adminEventsResponseSchema,
  adminRequeueBodySchema,
  adminGalleriesListResponseSchema,
  adminGalleryByEmailResponseSchema,
  adminMagicLinkResponseSchema,
  adminMatchRunsResponseSchema,
  adminMetricsResponseSchema,
  adminNeighboursResponseSchema,
  adminPhotoDetailResponseSchema,
  adminPhotosResponseSchema,
  eventResponseSchema,
} from "@rephoto/contracts";
import type { FaceEngine } from "@rephoto/face-engine/types";
import { bootstrapAdmins } from "../src/bootstrap.ts";
import { ipMatches, parseIpList } from "../src/net.ts";

async function adminCookie(h: Harness): Promise<string> {
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  return sessionCookie(h.db, admin.id);
}

async function participantCookie(h: Harness, email: string): Promise<{ id: string; cookie: string }> {
  const user = await h.db.createUser({ email, role: "participant" });
  return { id: user.id, cookie: await sessionCookie(h.db, user.id) };
}

function get(path: string, cookie?: string): Request {
  return new Request(`http://api.local${path}`, { headers: cookie ? { cookie } : {} });
}

/** Every admin route answers 401 without a session and 403 to a participant. */
test("v5 admin routes require an admin session", async () => {
  const h = await harness();
  const { cookie } = await participantCookie(h, "p@example.com");
  const id = randomUUID();
  const calls: Array<[string, string, unknown?]> = [
    ["POST", "/v1/admin/events", { slug: "x", name: "X" }],
    ["GET", "/v1/admin/events"],
    ["POST", "/v1/admin/magic-links", { email: "a@example.com", role: "participant" }],
    ["GET", `/v1/admin/galleries?eventId=${h.event.id}`],
    ["GET", `/v1/admin/photos?eventId=${h.event.id}`],
    ["GET", `/v1/admin/photos/${id}`],
    ["GET", `/v1/admin/faces/f/neighbours?eventId=${h.event.id}`],
    ["POST", `/v1/admin/galleries/${id}/${h.event.id}/rematch`, {}],
    ["DELETE", `/v1/admin/galleries/${id}/${h.event.id}`],
    ["POST", `/v1/admin/events/${h.event.id}/reset`, { confirm: "demo" }],
    ["GET", `/v1/admin/export/galleries.csv?eventId=${h.event.id}`],
    ["GET", `/v1/admin/export/match-hits.csv?eventId=${h.event.id}`],
    ["GET", `/v1/admin/export/feedback.csv?eventId=${h.event.id}`],
    ["GET", `/v1/admin/match-runs?eventId=${h.event.id}`],
  ];
  for (const [method, path, body] of calls) {
    const make = (headers: Record<string, string>) =>
      body === undefined
        ? new Request(`http://api.local${path}`, { method, headers })
        : json(method, path, body, headers);
    assert.equal((await h.app.request(make({}))).status, 401, `${method} ${path} anon`);
    assert.equal((await h.app.request(make({ cookie }))).status, 403, `${method} ${path} participant`);
  }
});

test("admin creates and lists events with counts", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const created = await h.app.request(
    json("POST", "/v1/admin/events", { slug: "gara-2026", name: "Gara 2026", retentionDays: 30, access: "list" }, { cookie }),
  );
  assert.equal(created.status, 201);
  const event = eventResponseSchema.parse(await created.json());
  assert.equal(event.slug, "gara-2026");
  assert.equal(event.access, "list");
  assert.equal(event.retentionDays, 30);
  const duplicate = await h.app.request(
    json("POST", "/v1/admin/events", { slug: "gara-2026", name: "Again" }, { cookie }),
  );
  assert.equal(duplicate.status, 409);
  const badSlug = await h.app.request(json("POST", "/v1/admin/events", { slug: "Bad Slug", name: "x" }, { cookie }));
  assert.equal(badSlug.status, 400);

  const { id: participantId } = await participantCookie(h, "p@example.com");
  await seedGallery(h, participantId, 2);
  const list = await h.app.request(get("/v1/admin/events", cookie));
  assert.equal(list.status, 200);
  const body = adminEventsResponseSchema.parse(await list.json());
  const demo = body.events.find((row) => row.slug === "demo");
  assert.ok(demo);
  assert.equal(demo.photos, 2);
  assert.equal(demo.galleries, 1);
  assert.equal(demo.photographers, 1);
  assert.ok(body.events.some((row) => row.slug === "gara-2026"));
});

test("admin issues raw magic links, creating staff users and memberships", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const audits: string[] = [];
  const db: Database = h.db;
  db.insertAudit = async (input) => {
    audits.push(input.action);
  };
  const res = await h.app.request(
    json("POST", "/v1/admin/magic-links", { email: "Shooter@example.com", role: "photographer", eventId: h.event.id }, { cookie }),
  );
  assert.equal(res.status, 200);
  const { url } = adminMagicLinkResponseSchema.parse(await res.json());
  assert.ok(url.startsWith("http://localhost:3000/verifica?token="));
  assert.equal(h.mailer.sent.length, 0);
  const shooter = await h.db.findUserByEmailRole("shooter@example.com", "photographer");
  assert.ok(shooter);
  assert.equal(await h.db.isEventPhotographer(h.event.id, shooter.id), true);
  assert.deepEqual(audits, ["magic_link.issued"]);

  // The link works like a mailed one.
  const verified = await h.app.request(json("POST", "/v1/auth/verify", { token: tokenFromMail(url) }));
  assert.equal(verified.status, 200);

  // Participants are not pre-created; they appear at verify.
  const participant = await h.app.request(
    json("POST", "/v1/admin/magic-links", { email: "guest@example.com", role: "participant" }, { cookie }),
  );
  assert.equal(participant.status, 200);
  assert.equal(await h.db.findUserByEmailRole("guest@example.com", "participant"), null);

  const unknownEvent = await h.app.request(
    json("POST", "/v1/admin/magic-links", { email: "x@example.com", role: "photographer", eventId: randomUUID() }, { cookie }),
  );
  assert.equal(unknownEvent.status, 404);
});

test("admin reads a gallery by email and the paged list of galleries", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const { id: participantId, cookie: pCookie } = await participantCookie(h, "p@example.com");
  const photos = await seedGallery(h, participantId, 3);
  const first = photos[0];
  assert.ok(first);
  await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "not_me" }, { cookie: pCookie }),
  );

  const byEmail = await h.app.request(get(`/v1/admin/galleries?eventId=${h.event.id}&email=P@example.com`, cookie));
  assert.equal(byEmail.status, 200);
  const body = adminGalleryByEmailResponseSchema.parse(await byEmail.json());
  assert.equal(body.user.id, participantId);
  assert.ok(body.gallery);
  assert.equal(body.gallery.total, 3);
  assert.deepEqual(body.gallery.anchorFaceIds, ["anchor-1"]);
  assert.equal(body.items.length, 3);
  assert.equal(body.items[0]?.photoId, first.photoId);
  assert.equal(body.items[0]?.feedback, "not_me");
  assert.equal(body.items[1]?.feedback, null);
  assert.equal(body.items[0]?.photo.sha256.length, 64);

  const missing = await h.app.request(get(`/v1/admin/galleries?eventId=${h.event.id}&email=nobody@example.com`, cookie));
  assert.equal(missing.status, 404);

  const other = await participantCookie(h, "q@example.com");
  await h.db.replaceGallery(other.id, h.event.id, [], []);
  const page1 = await h.app.request(get(`/v1/admin/galleries?eventId=${h.event.id}&limit=1`, cookie));
  assert.equal(page1.status, 200);
  const list1 = adminGalleriesListResponseSchema.parse(await page1.json());
  assert.equal(list1.galleries.length, 1);
  assert.ok(list1.nextCursor);
  const page2 = await h.app.request(
    get(`/v1/admin/galleries?eventId=${h.event.id}&limit=1&cursor=${encodeURIComponent(list1.nextCursor)}`, cookie),
  );
  const list2 = adminGalleriesListResponseSchema.parse(await page2.json());
  assert.equal(list2.galleries.length, 1);
  assert.equal(list2.nextCursor, null);
  const emails = new Set([...list1.galleries, ...list2.galleries].map((row) => row.email));
  assert.deepEqual([...emails].sort(), ["p@example.com", "q@example.com"]);
  const p = [...list1.galleries, ...list2.galleries].find((row) => row.email === "p@example.com");
  assert.equal(p?.total, 3);
});

test("admin photo detail shows faces, galleries and neighbours with a cosine", async () => {
  const h = await harness({
    faces: {
      async indexPhoto() {
        return [];
      },
      async search() {
        return [];
      },
      async searchFaces(input) {
        return [
          { externalFaceId: `${input.externalFaceId}-b`, photoId: randomUUID(), similarity: 90 },
          { externalFaceId: `${input.externalFaceId}-c`, photoId: randomUUID(), similarity: 100, cosine: 0.91 } as never,
        ];
      },
      async deleteFaces() {},
      async deleteCollection() {},
    } satisfies FaceEngine,
  });
  const cookie = await adminCookie(h);
  const { id: participantId } = await participantCookie(h, "p@example.com");
  const [seeded] = await seedGallery(h, participantId, 1);
  assert.ok(seeded);
  await h.db.replaceFaces(seeded.photoId, h.event.id, [
    { externalId: "face-a", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.98 },
  ]);
  const faceRows = await h.db.findFaceRowsByPhoto(seeded.photoId);
  const face = faceRows[0];
  assert.ok(face);
  await h.db.replaceGallery(participantId, h.event.id, [{ photoId: seeded.photoId, faceId: face.id, score: 0.95 }], ["face-a"]);

  const detail = await h.app.request(get(`/v1/admin/photos/${seeded.photoId}`, cookie));
  assert.equal(detail.status, 200);
  const body = adminPhotoDetailResponseSchema.parse(await detail.json());
  assert.equal(body.photo.id, seeded.photoId);
  assert.deepEqual(body.faces.map((row) => row.externalId), ["face-a"]);
  assert.deepEqual(body.faces[0]?.bbox, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  assert.equal(body.galleries.length, 1);
  assert.equal(body.galleries[0]?.email, "p@example.com");
  assert.equal(body.galleries[0]?.score, 0.95);
  assert.ok(body.webUrl?.includes(objectKeys.web(seeded.photoId)));
  assert.equal((await h.app.request(get(`/v1/admin/photos/${randomUUID()}`, cookie))).status, 404);
  assert.equal((await h.app.request(get("/v1/admin/photos/not-a-uuid", cookie))).status, 400);

  const neighbours = await h.app.request(get(`/v1/admin/faces/face-a/neighbours?eventId=${h.event.id}&limit=5`, cookie));
  assert.equal(neighbours.status, 200);
  const hits = adminNeighboursResponseSchema.parse(await neighbours.json());
  assert.equal(hits.length, 2);
  // The engine's cosine wins; otherwise the inverse of the similarity mapping (80 → MIN, 100 → SURE).
  assert.equal(hits[0]?.cosine, 0.91);
  assert.equal(hits[1]?.cosine, Number((env.INSIGHTFACE_MIN_COSINE + 0.5 * (env.INSIGHTFACE_SURE_COSINE - env.INSIGHTFACE_MIN_COSINE)).toFixed(4)));
  assert.equal((await h.app.request(get(`/v1/admin/faces/unknown/neighbours?eventId=${h.event.id}`, cookie))).status, 404);
});

test("uploads/init stores filename and tags; admin photo search filters on them", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const pCookie = await sessionCookie(h.db, photographer.id);
  const upload = async (filename: string, tags?: string[]) => {
    const bytes = Buffer.from(`bytes-of-${filename}-${"x".repeat(40)}`);
    const init = await h.app.request(
      json(
        "POST",
        "/v1/uploads/init",
        {
          eventId: h.event.id,
          filename,
          contentType: "image/jpeg",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
          ...(tags ? { tags } : {}),
        },
        { cookie: pCookie },
      ),
    );
    assert.equal(init.status, 201);
    const session = (await init.json()) as { id: string; objectKey: string };
    await h.objects.put(session.objectKey, bytes, "image/jpeg");
    const complete = await h.app.request(json("POST", `/v1/uploads/${session.id}/complete`, { parts: [] }, { cookie: pCookie }));
    assert.equal(complete.status, 201);
    return ((await complete.json()) as { photoId: string }).photoId;
  };
  const a = await upload("IMG_0001.jpg", ["synth", "round-1"]);
  const b = await upload("IMG_0002.jpg");
  const c = await upload("DSC_0003.jpg", ["round-1"]);

  const detail = adminPhotoDetailResponseSchema.parse(await (await h.app.request(get(`/v1/admin/photos/${a}`, cookie))).json());
  assert.equal(detail.photo.filename, "IMG_0001.jpg");
  assert.deepEqual(detail.photo.tags, ["synth", "round-1"]);

  const byName = adminPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/admin/photos?eventId=${h.event.id}&filename=IMG_`, cookie))).json(),
  );
  assert.deepEqual(byName.photos.map((row) => row.id).sort(), [a, b].sort());
  const byTag = adminPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/admin/photos?eventId=${h.event.id}&tag=synth`, cookie))).json(),
  );
  assert.deepEqual(byTag.photos.map((row) => row.id), [a]);
  const photoB = await h.db.findPhoto(b);
  assert.ok(photoB);
  const bySha = adminPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/admin/photos?eventId=${h.event.id}&sha256=${photoB.sha256.slice(0, 10)}`, cookie))).json(),
  );
  assert.deepEqual(bySha.photos.map((row) => row.id), [b]);
  const byStatus = adminPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/admin/photos?eventId=${h.event.id}&status=uploaded&limit=2`, cookie))).json(),
  );
  assert.equal(byStatus.photos.length, 2);
  assert.ok(byStatus.nextCursor);
  const rest = adminPhotosResponseSchema.parse(
    await (
      await h.app.request(get(`/v1/admin/photos?eventId=${h.event.id}&status=uploaded&limit=2&cursor=${encodeURIComponent(byStatus.nextCursor)}`, cookie))
    ).json(),
  );
  assert.equal(rest.photos.length, 1);
  assert.deepEqual(new Set([...byStatus.photos, ...rest.photos].map((row) => row.id)), new Set([a, b, c]));
  const tooManyTags = await h.app.request(
    json(
      "POST",
      "/v1/uploads/init",
      { eventId: h.event.id, filename: "x.jpg", contentType: "image/jpeg", sha256: "a".repeat(64), bytes: 10, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { cookie: pCookie },
    ),
  );
  assert.equal(tooManyTags.status, 400);
});

test("participant feedback is stored, flagged on the gallery and limited to own photos", async () => {
  const h = await harness();
  const { id: participantId, cookie } = await participantCookie(h, "p@example.com");
  const photos = await seedGallery(h, participantId, 3);
  const [first, second] = photos;
  assert.ok(first && second);
  const res = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "not_me" }, { cookie }),
  );
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { photoId: first.photoId, verdict: "not_me" });

  const gallery = await h.app.request(get(`/v1/events/${h.event.slug}/gallery`, cookie));
  assert.equal(gallery.status, 200);
  const body = galleryResponseSchema.parse(await gallery.json());
  assert.equal(body.items.length, 3);
  assert.equal(body.items.find((item) => item.photoId === first.photoId)?.feedback, "not_me");
  assert.equal(body.items.find((item) => item.photoId === second.photoId)?.feedback, null);

  // Reversible, and remembered after a re-match (the verdict lives outside gallery_items).
  await h.app.request(json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "me" }, { cookie }));
  await h.app.request(json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: second.photoId, verdict: "not_me" }, { cookie }));
  await h.db.replaceGallery(participantId, h.event.id, photos.map((p) => ({ photoId: p.photoId, faceId: randomUUID(), score: p.score })), []);
  const again = galleryResponseSchema.parse(await (await h.app.request(get(`/v1/events/${h.event.slug}/gallery`, cookie))).json());
  assert.equal(again.items.find((item) => item.photoId === first.photoId)?.feedback, "me");
  assert.equal(again.items.find((item) => item.photoId === second.photoId)?.feedback, "not_me");

  const stranger = await participantCookie(h, "q@example.com");
  const forbidden = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "not_me" }, { cookie: stranger.cookie }),
  );
  assert.equal(forbidden.status, 403);
  const bad = await h.app.request(json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "maybe" }, { cookie }));
  assert.equal(bad.status, 400);
  assert.equal((await h.app.request(json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "me" }))).status, 401);
});

test("rematch needs KEEP_SELFIES and a stored selfie; delete gallery removes it", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const { id: participantId } = await participantCookie(h, "p@example.com");
  await seedGallery(h, participantId, 1);
  const path = `/v1/admin/galleries/${participantId}/${h.event.id}`;
  const off = await h.app.request(new Request(`http://api.local${path}/rematch`, { method: "POST", headers: { cookie } }));
  assert.equal(off.status, 409);
  assert.deepEqual(await off.json(), { error: MESSAGES.selfieNotKept });

  const kept = await harness({ env: { ...env, KEEP_SELFIES: true } });
  const keptCookie = await adminCookie(kept);
  const { id: keptParticipant } = await participantCookie(kept, "p@example.com");
  await seedGallery(kept, keptParticipant, 1);
  const keptPath = `/v1/admin/galleries/${keptParticipant}/${kept.event.id}`;
  const noKey = await kept.app.request(new Request(`http://api.local${keptPath}/rematch`, { method: "POST", headers: { cookie: keptCookie } }));
  assert.equal(noKey.status, 409);
  kept.db.setGallerySelfieKey(keptParticipant, kept.event.id, objectKeys.selfie(kept.event.id, keptParticipant, "kept"));
  const ok = await kept.app.request(new Request(`http://api.local${keptPath}/rematch`, { method: "POST", headers: { cookie: keptCookie } }));
  assert.equal(ok.status, 202);
  const { jobId } = (await ok.json()) as { jobId: string };
  const job = kept.db.jobView(jobId);
  assert.equal(job?.status, "queued");
  assert.equal(await kept.db.countMatchJobsSince(keptParticipant, new Date(0)), 1);
  // A second click while the job is queued returns the same job (dedupe rematch:<user>:<event>).
  const repeat = await kept.app.request(new Request(`http://api.local${keptPath}/rematch`, { method: "POST", headers: { cookie: keptCookie } }));
  assert.equal(repeat.status, 202);
  assert.deepEqual(await repeat.json(), { jobId });
  assert.equal(await kept.db.countMatchJobsSince(keptParticipant, new Date(0)), 1);
  const unknown = await kept.app.request(
    new Request(`http://api.local/v1/admin/galleries/${randomUUID()}/${kept.event.id}/rematch`, { method: "POST", headers: { cookie: keptCookie } }),
  );
  assert.equal(unknown.status, 404);

  const deleted = await h.app.request(new Request(`http://api.local${path}`, { method: "DELETE", headers: { cookie } }));
  assert.equal(deleted.status, 204);
  assert.equal(await h.db.findGalleryByUser(participantId, h.event.id), null);
  assert.deepEqual(await h.db.listGallery(participantId, h.event.id), []);
  const again = await h.app.request(new Request(`http://api.local${path}`, { method: "DELETE", headers: { cookie } }));
  assert.equal(again.status, 404);
});

test("deleting a gallery or a participant also deletes the selfie kept with KEEP_SELFIES", async () => {
  const h = await harness({ env: { ...env, KEEP_SELFIES: true } });
  const cookie = await adminCookie(h);
  const { id: participantId } = await participantCookie(h, "p@example.com");
  await seedGallery(h, participantId, 1);
  const selfieKey = objectKeys.selfie(h.event.id, participantId, "kept");
  await h.objects.put(selfieKey, Buffer.from("selfie"), "image/jpeg");
  h.db.setGallerySelfieKey(participantId, h.event.id, selfieKey);
  const deleted = await h.app.request(
    new Request(`http://api.local/v1/admin/galleries/${participantId}/${h.event.id}`, { method: "DELETE", headers: { cookie } }),
  );
  assert.equal(deleted.status, 204);
  assert.equal(h.objects.objects.has(selfieKey), false);

  const { id: other } = await participantCookie(h, "q@example.com");
  await h.db.replaceGallery(other, h.event.id, [], []);
  const otherKey = objectKeys.selfie(h.event.id, other, "kept");
  await h.objects.put(otherKey, Buffer.from("selfie"), "image/jpeg");
  h.db.setGallerySelfieKey(other, h.event.id, otherKey);
  const audits: string[] = [];
  const db: Database = h.db;
  const insertAudit = db.insertAudit.bind(db);
  db.insertAudit = async (input) => {
    audits.push(input.action);
    return insertAudit(input);
  };
  const removed = await h.app.request(
    new Request(`http://api.local/v1/admin/participants/${other}`, { method: "DELETE", headers: { cookie } }),
  );
  assert.equal(removed.status, 204);
  assert.equal(h.objects.objects.has(otherKey), false);
  assert.equal(await h.db.findUserById(other), null);
  assert.deepEqual(audits, ["participant.deleted"]);
  const missing = await h.app.request(
    new Request(`http://api.local/v1/admin/participants/${randomUUID()}`, { method: "DELETE", headers: { cookie } }),
  );
  assert.equal(missing.status, 404);
  // Not a participant: 404, and the admin's own account is untouched.
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const refused = await h.app.request(
    new Request(`http://api.local/v1/admin/participants/${admin.id}`, { method: "DELETE", headers: { cookie } }),
  );
  assert.equal(refused.status, 404);
});

test("event reset needs the slug as confirmation and enqueues one reset job", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const wrong = await h.app.request(json("POST", `/v1/admin/events/${h.event.id}/reset`, { confirm: "other" }, { cookie }));
  assert.equal(wrong.status, 400);
  const missing = await h.app.request(json("POST", `/v1/admin/events/${randomUUID()}/reset`, { confirm: "demo" }, { cookie }));
  assert.equal(missing.status, 404);
  const audits: string[] = [];
  const db: Database = h.db;
  db.insertAudit = async (input) => {
    audits.push(input.action);
  };
  const ok = await h.app.request(json("POST", `/v1/admin/events/${h.event.id}/reset`, { confirm: "demo" }, { cookie }));
  assert.equal(ok.status, 202);
  assert.deepEqual(audits, [], "the worker writes the one event.reset audit row, with the counts");
  const { jobId } = (await ok.json()) as { jobId: string };
  const job = h.db.jobView(jobId);
  assert.equal(job?.status, "queued");
  assert.equal(job?.dedupeKey, `reset:${h.event.id}`);
  const twice = await h.app.request(json("POST", `/v1/admin/events/${h.event.id}/reset`, { confirm: "demo" }, { cookie }));
  assert.deepEqual(await twice.json(), { jobId });
  const claimed = await h.db.claimJob();
  assert.equal(claimed?.type, "reset");
  assert.deepEqual(claimed?.payload, { eventId: h.event.id, actorId: (await h.db.findUserByEmailRole("admin@rephoto.local", "admin"))?.id });
});

test("csv exports stream galleries, match hits and feedback", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const { id: participantId, cookie: pCookie } = await participantCookie(h, "p@example.com");
  const photos = await seedGallery(h, participantId, 2);
  const [first] = photos;
  assert.ok(first);
  await h.app.request(json("POST", `/v1/events/${h.event.slug}/gallery/feedback`, { photoId: first.photoId, verdict: "not_me" }, { cookie: pCookie }));
  const runId = h.db.addMatchRun(
    { userId: participantId, eventId: h.event.id, liveness: "challenge", reason: null, selfieSha256: "ab".repeat(32), selfieFaces: 1, engineMs: 120, hits: 2 },
    [
      { photoId: first.photoId, externalFaceId: "f1", cosine: 0.72, similarity: 100, kept: true },
      { photoId: randomUUID(), externalFaceId: "f2", cosine: 0.31, similarity: 0, kept: false },
    ],
  );

  const galleries = await h.app.request(get(`/v1/admin/export/galleries.csv?eventId=${h.event.id}`, cookie));
  assert.equal(galleries.status, 200);
  assert.ok(galleries.headers.get("content-type")?.startsWith("text/csv"));
  assert.ok(galleries.headers.get("content-disposition")?.includes('gallerie-demo.csv'));
  const lines = (await galleries.text()).trim().split("\n");
  assert.equal(lines[0], "email,user_id,photo_id,sha256,filename,score,source,face_id,created_at,feedback");
  assert.equal(lines.length, 3);
  assert.ok(lines[1]?.startsWith(`p@example.com,${participantId},${first.photoId},`));
  assert.ok(lines[1]?.endsWith(",not_me"));
  assert.ok(lines[2]?.endsWith(","));

  const hits = await h.app.request(get(`/v1/admin/export/match-hits.csv?eventId=${h.event.id}`, cookie));
  assert.equal(hits.status, 200);
  const hitLines = (await hits.text()).trim().split("\n");
  assert.equal(hitLines[0], "run_id,email,user_id,run_created_at,photo_id,external_face_id,cosine,similarity,kept");
  assert.equal(hitLines.length, 3);
  assert.ok(hitLines[1]?.startsWith(`${runId},p@example.com,${participantId},`));
  assert.ok(hitLines[1]?.endsWith(",f1,0.72,100,true"));
  assert.ok(hitLines[2]?.endsWith(",f2,0.31,0,false"));

  const feedback = await h.app.request(get(`/v1/admin/export/feedback.csv?eventId=${h.event.id}`, cookie));
  assert.equal(feedback.status, 200);
  const feedbackLines = (await feedback.text()).trim().split("\n");
  assert.equal(feedbackLines[0], "email,user_id,photo_id,sha256,filename,verdict,score_at_time,created_at");
  assert.equal(feedbackLines.length, 2);
  assert.ok(feedbackLines[1]?.includes(`,${first.photoId},`));
  assert.ok(feedbackLines[1]?.includes(`,not_me,${first.score},`));

  assert.equal((await h.app.request(get("/v1/admin/export/galleries.csv", cookie))).status, 400);
  assert.equal((await h.app.request(get(`/v1/admin/export/galleries.csv?eventId=${randomUUID()}`, cookie))).status, 404);

  const runs = await h.app.request(get(`/v1/admin/match-runs?eventId=${h.event.id}&email=p@example.com`, cookie));
  assert.equal(runs.status, 200);
  const runsBody = adminMatchRunsResponseSchema.parse(await runs.json());
  assert.equal(runsBody.runs.length, 1);
  assert.equal(runsBody.runs[0]?.id, runId);
  assert.equal(runsBody.runs[0]?.kept, 1);
  assert.equal(runsBody.runs[0]?.maxCosine, 0.72);
  assert.equal(runsBody.runs[0]?.liveness, "challenge");
  const none = adminMatchRunsResponseSchema.parse(
    await (await h.app.request(get(`/v1/admin/match-runs?eventId=${h.event.id}&email=nobody@example.com`, cookie))).json(),
  );
  assert.equal(none.runs.length, 0);
});

test("admin metrics carry the queue by type, the oldest age, last errors and the face-service probe", async () => {
  const h = await harness();
  const cookie = await adminCookie(h);
  const queued = await h.db.enqueueJob("derive", { photoId: randomUUID() });
  h.db.setJobCreatedAt(queued, new Date(Date.now() - 90_000));
  const failed = await h.db.enqueueJob("index", { photoId: randomUUID() });
  await h.db.failJobTerminal(failed, "face service down");
  const res = await h.app.request(get("/v1/admin/metrics", cookie));
  assert.equal(res.status, 200);
  const body = adminMetricsResponseSchema.parse(await res.json());
  assert.deepEqual(body.faceService, { ok: null, ms: null });
  assert.ok(body.oldestQueuedSeconds !== null && body.oldestQueuedSeconds >= 89);
  const derive = body.jobsByType.find((row) => row.type === "derive");
  assert.equal(derive?.queued, 1);
  const index = body.jobsByType.find((row) => row.type === "index");
  assert.equal(index?.error, 1);
  assert.equal(body.lastErrors.length, 1);
  assert.equal(body.lastErrors[0]?.error, "face service down");
  assert.equal(body.lastErrors[0]?.type, "index");
});

test("rate limits come from env and exempt IPs skip them", async () => {
  const strict = await harness({ env: { ...env, MAGIC_LINK_PER_EMAIL: 1, MAGIC_LINK_PER_IP: 2, RATE_LIMIT_EXEMPT_IPS: "10.20.0.0/16, 2001:db8::1" } });
  const ask = (h: Harness, email: string, ip: string) =>
    h.app.request(json("POST", "/v1/auth/request-link", { email, role: "participant" }, { "x-forwarded-for": ip }));
  assert.equal((await ask(strict, "a@example.com", "198.51.100.7")).status, 202);
  assert.equal((await ask(strict, "a@example.com", "198.51.100.7")).status, 429);
  assert.equal((await ask(strict, "b@example.com", "198.51.100.7")).status, 202);
  assert.equal((await ask(strict, "c@example.com", "198.51.100.7")).status, 429);
  // The room's NAT (CIDR) and a v6 host are exempt from both limits.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await ask(strict, "a@example.com", "10.20.33.44")).status, 202);
    assert.equal((await ask(strict, "a@example.com", "2001:db8::1")).status, 202);
  }
  assert.equal((await ask(strict, "a@example.com", "10.21.0.1")).status, 429);

  const open = await harness({ env: { ...env, MAGIC_LINK_PER_IP: 0, MAGIC_LINK_PER_EMAIL: 0, SELFIE_MAX_PER_HOUR: 0 } });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.equal((await ask(open, "same@example.com", "198.51.100.9")).status, 202);
  }
  const { id: participantId, cookie } = await participantCookie(open, "live@example.com");
  await open.db.insertConsent({ userId: participantId, eventId: open.event.id, textVersion: CONSENT_TEXT_VERSION, ip: "127.0.0.1", userAgent: "t" });
  const selfie = () => {
    const form = new FormData();
    form.set("selfie", new File([Buffer.from("not really a jpeg")], "me.jpg", { type: "image/jpeg" }));
    return open.app.request(new Request(`http://api.local/v1/events/${open.event.slug}/selfie`, { method: "POST", headers: { cookie }, body: form }));
  };
  for (let attempt = 0; attempt < 7; attempt += 1) assert.equal((await selfie()).status, 202);

  const two = await harness({ env: { ...env, SELFIE_MAX_PER_HOUR: 2 } });
  const p2 = await participantCookie(two, "live@example.com");
  await two.db.insertConsent({ userId: p2.id, eventId: two.event.id, textVersion: CONSENT_TEXT_VERSION, ip: "127.0.0.1", userAgent: "t" });
  const selfie2 = () => {
    const form = new FormData();
    form.set("selfie", new File([Buffer.from("not really a jpeg")], "me.jpg", { type: "image/jpeg" }));
    return two.app.request(new Request(`http://api.local/v1/events/${two.event.slug}/selfie`, { method: "POST", headers: { cookie: p2.cookie }, body: form }));
  };
  assert.equal((await selfie2()).status, 202);
  assert.equal((await selfie2()).status, 202);
  assert.equal((await selfie2()).status, 429);
});

test("env defaults for the v5 limits and the ip matcher", () => {
  assert.equal(env.MAGIC_LINK_PER_EMAIL, 3);
  assert.equal(env.MAGIC_LINK_PER_IP, 20);
  assert.equal(env.SELFIE_MAX_PER_HOUR, 5);
  assert.equal(env.RATE_LIMIT_EXEMPT_IPS, "");
  assert.equal(env.BOOTSTRAP_ADMINS, "");
  assert.deepEqual(parseIpList(" a, ,b ,"), ["a", "b"]);
  const entries = ["192.0.2.10", "10.0.0.0/8", "2001:db8::/32", "fe80::1"];
  assert.equal(ipMatches("192.0.2.10", entries), true);
  assert.equal(ipMatches("192.0.2.11", entries), false);
  assert.equal(ipMatches("10.255.1.2", entries), true);
  assert.equal(ipMatches("::ffff:10.1.2.3", entries), true);
  assert.equal(ipMatches("11.0.0.1", entries), false);
  assert.equal(ipMatches("2001:db8:1::5", entries), true);
  assert.equal(ipMatches("2001:db9::5", entries), false);
  assert.equal(ipMatches("fe80::1", entries), true);
  assert.equal(ipMatches("unknown", entries), false);
  assert.equal(ipMatches("10.0.0.1", ["10.0.0.0/33", "garbage"]), false);
});

test("BOOTSTRAP_ADMINS upserts admins at boot", async () => {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const created = await bootstrapAdmins(db, "Ops@Example.com, admin@rephoto.local,, not-an-email");
  assert.deepEqual(created, ["ops@example.com", "admin@rephoto.local"]);
  const ops = await db.findUserByEmailRole("ops@example.com", "admin");
  assert.ok(ops);
  const again = await bootstrapAdmins(db, "ops@example.com");
  assert.deepEqual(again, ["ops@example.com"]);
  assert.equal((await db.findUserByEmailRole("ops@example.com", "admin"))?.id, ops.id);
  const parsed = envSchema.parse({
    DATABASE_URL: "postgres://x",
    S3_BUCKET: "b",
    S3_REGION: "eu-central-1",
    SESSION_SECRET: "test-session-secret-value",
    FACE_ENGINE: "fake",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1025",
    SMTP_FROM: "noreply@rephoto.local",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:8787",
    BOOTSTRAP_ADMINS: "x@example.com",
    RATE_LIMIT_EXEMPT_IPS: " 10.0.0.0/8 ",
    MAGIC_LINK_PER_IP: "0",
  });
  assert.equal(parsed.BOOTSTRAP_ADMINS, "x@example.com");
  assert.equal(parsed.RATE_LIMIT_EXEMPT_IPS, "10.0.0.0/8");
  assert.equal(parsed.MAGIC_LINK_PER_IP, 0);
});

// ---- public collection ----------------------------------------------------------------------

/** Inserts an indexed public photo (with thumb+web derivatives) owned by the seeded photographer. */
async function seedPublicPhoto(h: Harness): Promise<string> {
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const photoId = randomUUID();
  const bytes = Buffer.from(`pub-${photoId}`);
  await h.db.insertPhoto({
    id: photoId,
    eventId: h.event.id,
    photographerId: photographer.id,
    collection: "public",
    sha256: sha256(bytes),
    originalKey: objectKeys.original(h.event.id, photoId),
    contentType: "image/jpeg",
    bytes: bytes.byteLength,
  });
  await h.db.upsertDerivative({ photoId, kind: "thumb", s3Key: objectKeys.thumb(photoId) });
  await h.db.upsertDerivative({ photoId, kind: "web", s3Key: objectKeys.web(photoId) });
  await h.db.setPhotoIndexed(photoId);
  return photoId;
}

test("public-gallery lists only indexed public photos and paginates by cursor without gaps", async () => {
  const h = await harness();
  const { cookie } = await participantCookie(h, "viewer@example.com");
  const publicIds = new Set([await seedPublicPhoto(h), await seedPublicPhoto(h), await seedPublicPhoto(h)]);

  // An official indexed photo and a public-but-not-indexed photo must never show up.
  const official = await seedGallery(h, (await participantCookie(h, "owner@example.com")).id, 1);
  const pendingPublic = randomUUID();
  const pb = Buffer.from(`pending-${pendingPublic}`);
  await h.db.insertPhoto({
    id: pendingPublic,
    eventId: h.event.id,
    photographerId: (await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer"))!.id,
    collection: "public",
    sha256: sha256(pb),
    originalKey: objectKeys.original(h.event.id, pendingPublic),
    contentType: "image/jpeg",
    bytes: pb.byteLength,
  });

  type Page = { items: Array<{ photoId: string }>; nextCursor: string | null; limit: number };
  const full = (await (await h.app.request(get(`/v1/events/${h.event.slug}/public-gallery?limit=50`, cookie))).json()) as Page;
  assert.equal(full.items.length, 3, "only the three indexed public photos");
  assert.deepEqual(new Set(full.items.map((i) => i.photoId)), publicIds);
  assert.equal(full.items.some((i) => i.photoId === official[0]?.photoId), false, "official photo excluded");
  assert.equal(full.items.some((i) => i.photoId === pendingPublic), false, "non-indexed public photo excluded");
  assert.equal(full.nextCursor, null);

  // Cursor paging must reproduce the canonical order in chunks, with no overlap or dropped rows.
  const page1 = (await (await h.app.request(get(`/v1/events/${h.event.slug}/public-gallery?limit=2`, cookie))).json()) as Page;
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = (await (await h.app.request(
    get(`/v1/events/${h.event.slug}/public-gallery?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, cookie),
  )).json()) as Page;
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(
    [...page1.items, ...page2.items].map((i) => i.photoId),
    full.items.map((i) => i.photoId),
  );
});

test("public-gallery/download presigns public photos but 404s on any non-public id (no IDOR)", async () => {
  const h = await harness();
  const { cookie } = await participantCookie(h, "viewer@example.com");
  const a = await seedPublicPhoto(h);
  const b = await seedPublicPhoto(h);
  // An official photo id must not be reachable through the public download route.
  const official = (await seedGallery(h, (await participantCookie(h, "owner@example.com")).id, 1))[0]!.photoId;

  const leak = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/public-gallery/download`, { photoIds: [a, official], variant: "web" }, { cookie }),
  );
  assert.equal(leak.status, 404, "mixing in an official id is refused wholesale");

  const ok = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/public-gallery/download`, { photoIds: [a, b], variant: "web" }, { cookie }),
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { urls: Array<{ photoId: string; url: string }> };
  assert.deepEqual(new Set(body.urls.map((u) => u.photoId)), new Set([a, b]));
});

test("uploads/init: a participant may start a public upload but not an official one", async () => {
  const h = await harness();
  const { cookie } = await participantCookie(h, "contributor@example.com");
  const base = {
    eventId: h.event.id,
    filename: "a.jpg",
    contentType: "image/jpeg" as const,
    sha256: "a".repeat(64),
    bytes: 1234,
  };

  const official = await h.app.request(json("POST", "/v1/uploads/init", base, { cookie }));
  assert.equal(official.status, 403, "official (default) uploads stay photographer-only");

  const pub = await h.app.request(json("POST", "/v1/uploads/init", { ...base, collection: "public" }, { cookie }));
  assert.equal(pub.status, 201);
  const session = await h.db.findUploadSession(((await pub.json()) as { id: string }).id);
  assert.equal(session?.collection, "public");
});

test("public uploads are rate limited per participant per event", async () => {
  const h = await harness();
  const { cookie } = await participantCookie(h, "burst@example.com");
  const body = (n: number) => ({
    eventId: h.event.id,
    filename: `f${n}.jpg`,
    contentType: "image/jpeg" as const,
    sha256: "b".repeat(64),
    bytes: 1000 + n,
    collection: "public" as const,
  });
  for (let n = 0; n < PUBLIC_UPLOAD_RATE_LIMIT.max; n += 1) {
    const res = await h.app.request(json("POST", "/v1/uploads/init", body(n), { cookie }));
    assert.equal(res.status, 201, `init ${n} within the window`);
  }
  const blocked = await h.app.request(json("POST", "/v1/uploads/init", body(999), { cookie }));
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: MESSAGES.rateLimited });
});
