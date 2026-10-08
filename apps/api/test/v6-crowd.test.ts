/*
 * v6 section C (agent C): crowd upload, the kill switch, the report threshold, moderation
 * transitions and the per-album dedup.
 *
 * Run: node --import tsx --test apps/api/test/v6-crowd.test.ts
 *
 * One test per clause of the C2 authorization rule, as the acceptance criteria ask:
 * `kind = 'crowd'`, `uploads_open = true`, the caller is a participant of the event, and
 * their approved + pending count in the album is below `max_photos_per_user`.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  albumPhotosResponseSchema,
  albumUploadDedupeResponseSchema,
  envSchema,
  moderateResponseSchema,
  moderationResponseSchema,
  objectKeys,
  reportResponseSchema,
  SESSION_COOKIE_NAME,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase, type AlbumRow, type Database, type UserRow } from "@rephoto/db";
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
import { createQueue } from "../src/queue.ts";
import type { Screening, ScreeningInput, ScreeningVerdict } from "../src/screening.ts";

const baseEnv = {
  DATABASE_URL: "postgres://rephoto:rephoto@localhost:5432/rephoto",
  S3_BUCKET: "rephoto",
  S3_REGION: "eu-central-1",
  SESSION_SECRET: "test-session-secret-value",
  FACE_ENGINE: "fake",
  AWS_REGION: "eu-central-1",
  REKOGNITION_COLLECTION_PREFIX: "rephoto-",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_FROM: "noreply@rephoto.local",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:8787",
} as const;

const env: Env = envSchema.parse(baseEnv);

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly deleted: string[] = [];

  async put(key: string, body: Uint8Array, contentType: string, _options?: PutObjectOptions) {
    void _options;
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
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
    return stored ? { bytes: stored.body.byteLength, contentType: stored.contentType } : null;
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
  async presignPut(key: string): Promise<string> {
    return `http://localhost:9000/${key}?put=1`;
  }
  async createMultipartUpload(): Promise<string> {
    return `mp-${randomUUID()}`;
  }
  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `http://localhost:9000/${key}?upload=${uploadId}&part=${partNumber}`;
  }
  async completeMultipartUpload(): Promise<void> {}
  async abortMultipartUpload(): Promise<void> {}
  async presignGet(key: string): Promise<string> {
    return `http://localhost:9000/${key}`;
  }
}

class StubMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** A screening hook that records what it saw and answers whatever the test set. */
class RecordingScreening implements Screening {
  readonly seen: ScreeningInput[] = [];
  verdict: ScreeningVerdict = { state: "approved" };
  async screen(input: ScreeningInput): Promise<ScreeningVerdict> {
    this.seen.push(input);
    return this.verdict;
  }
}

type Harness = {
  app: ReturnType<typeof createApp>;
  db: MemoryDatabase;
  objects: MemoryObjectStore;
  screening: RecordingScreening;
  event: { id: string; slug: string };
  crowd: AlbumRow;
  official: AlbumRow;
  admin: UserRow;
};

async function harness(
  overrides: Partial<AppDeps> = {},
  albumOverrides: Partial<Parameters<Database["createAlbum"]>[0]> = {},
  envOverrides: Record<string, string> = {},
): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const official = await db.findDefaultAlbum(event.id);
  assert.ok(official, "migration 009 gives every event its official album");
  const crowd = await db.createAlbum({
    eventId: event.id,
    slug: "di-tutti",
    name: "Album di tutti",
    kind: "crowd",
    ...albumOverrides,
  });
  const admin = await db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const objects = new MemoryObjectStore();
  const screening = new RecordingScreening();
  const app = createApp({
    env: Object.keys(envOverrides).length > 0 ? envSchema.parse({ ...baseEnv, ...envOverrides }) : env,
    db,
    objects,
    mailer: new StubMailer(),
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
    screening,
    ...overrides,
  });
  return {
    app,
    db,
    objects,
    screening,
    event: { id: event.id, slug: event.slug },
    crowd,
    official,
    admin,
  };
}

/**
 * A signed-in participant who belongs to the harness event, which is what registering with
 * an event code produces (`event_members`, migration 013). Since the integration fix to
 * `assertEventMember`, membership is what the crowd feed and the report button check, so the
 * default fixture has to have it. Use {@link strangerParticipant} for someone who does not.
 */
async function participant(h: Harness, email: string): Promise<{ user: UserRow; cookie: string }> {
  const user = await h.db.createUser({ email, role: "participant" });
  await h.db.addEventMember({ userId: user.id, eventId: h.event.id, source: "event_code" });
  return { user, cookie: await cookieFor(h.db, user.id) };
}

/** A signed-in participant with no `event_members` row for the harness event. */
async function strangerParticipant(
  h: Harness,
  email: string,
): Promise<{ user: UserRow; cookie: string }> {
  const user = await h.db.createUser({ email, role: "participant" });
  return { user, cookie: await cookieFor(h.db, user.id) };
}

async function cookieFor(db: Database, userId: string): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function json(method: string, path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://api.local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(`http://api.local${path}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** init → PUT the bytes into the store → complete. Returns the complete response. */
async function upload(
  h: Harness,
  albumId: string,
  cookie: string,
  content: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bytes = Buffer.from(content);
  const init = await h.app.request(
    json(
      "POST",
      `/v1/albums/${albumId}/uploads/init`,
      {
        filename: "polaroid.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cookie,
    ),
  );
  if (init.status !== 201) {
    return { status: init.status, body: (await init.json()) as Record<string, unknown> };
  }
  const created = (await init.json()) as { id: string; objectKey: string };
  await h.objects.put(created.objectKey, bytes, "image/jpeg");
  const done = await h.app.request(
    json("POST", `/v1/albums/${albumId}/uploads/${created.id}/complete`, { parts: [] }, cookie),
  );
  return { status: done.status, body: (await done.json()) as Record<string, unknown> };
}

/** The derive job the worker would have run: both derivatives, so the photo shows up. */
async function derive(h: Harness, photoId: string): Promise<void> {
  await h.objects.put(objectKeys.thumb(photoId), Buffer.from("thumb"), "image/jpeg");
  await h.objects.put(objectKeys.web(photoId), Buffer.from("web"), "image/jpeg");
  await h.db.upsertDerivative({ photoId, kind: "thumb", s3Key: objectKeys.thumb(photoId) });
  await h.db.upsertDerivative({ photoId, kind: "web", s3Key: objectKeys.web(photoId) });
}

// ---- C2 clause 1: the album must be `kind = 'crowd'` ---------------------------------------

test("a participant cannot upload into the official album (clause: kind = 'crowd')", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const res = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.official.id}/uploads/init`,
      { filename: "a.jpg", contentType: "image/jpeg", sha256: sha256(Buffer.from("a")), bytes: 1 },
      anna.cookie,
    ),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: MESSAGES.uploadNotCrowd });
});

// ---- C2 clause 2: `uploads_open` is the kill switch ---------------------------------------

test("uploads_open = false makes every upload route answer 423, with no restart", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  // It works first: this is a live flip, not a start-up configuration.
  const first = await upload(h, h.crowd.id, anna.cookie, "one");
  assert.equal(first.status, 201);

  await h.db.updateAlbum(h.crowd.id, { uploadsOpen: false });

  const init = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      { filename: "b.jpg", contentType: "image/jpeg", sha256: sha256(Buffer.from("b")), bytes: 3 },
      anna.cookie,
    ),
  );
  assert.equal(init.status, 423);
  assert.deepEqual(await init.json(), { error: MESSAGES.uploadsClosed });

  // Every upload route, not just init: a session opened before the switch cannot be finished.
  const parts = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/${randomUUID()}/parts`, { partNumber: 1 }, anna.cookie),
  );
  assert.equal(parts.status, 423);
  const complete = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/${randomUUID()}/complete`, { parts: [] }, anna.cookie),
  );
  assert.equal(complete.status, 423);

  // And back on again, still with no restart.
  await h.db.updateAlbum(h.crowd.id, { uploadsOpen: true });
  const again = await upload(h, h.crowd.id, anna.cookie, "two");
  assert.equal(again.status, 201);
});

// ---- C2 clause 3: the caller is a participant of the event -------------------------------

test("only a participant of the event may upload (clause: event membership)", async () => {
  const h = await harness();
  // An `access = 'list'` event checks the imported participant list, as the selfie route does.
  await h.db.updateEvent(h.event.id, { access: "list" });
  const outsider = await participant(h, "outsider@example.com");
  const body = {
    filename: "a.jpg",
    contentType: "image/jpeg" as const,
    sha256: sha256(Buffer.from("a")),
    bytes: 1,
  };
  const refused = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/init`, body, outsider.cookie),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: MESSAGES.notOnList });

  await h.db.upsertEventParticipants(h.event.id, ["outsider@example.com"]);
  const allowed = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/init`, body, outsider.cookie),
  );
  assert.equal(allowed.status, 201);

  // A photographer is not a participant: the crowd routes are participant-only.
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const wrongRole = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      body,
      await cookieFor(h.db, photographer.id),
    ),
  );
  assert.equal(wrongRole.status, 403);

  // And an anonymous caller gets 401, never 403.
  const anon = await h.app.request(json("POST", `/v1/albums/${h.crowd.id}/uploads/init`, body));
  assert.equal(anon.status, 401);
});

// ---- C2 clause 4: the per-user cap --------------------------------------------------------

test("the per-user cap counts approved + pending and blocks at the limit", async () => {
  const h = await harness({}, { maxPhotosPerUser: 2 });
  const anna = await participant(h, "anna@example.com");
  const first = await upload(h, h.crowd.id, anna.cookie, "one");
  assert.equal(first.status, 201);
  const second = await upload(h, h.crowd.id, anna.cookie, "two");
  assert.equal(second.status, 201);

  const third = await upload(h, h.crowd.id, anna.cookie, "three");
  assert.equal(third.status, 403);
  assert.deepEqual(third.body, { error: MESSAGES.uploadQuotaReached });

  // A pending photo still occupies a slot.
  await h.db.setPhotoModeration({ photoId: String(first.body.photoId), state: "pending" });
  const stillFull = await upload(h, h.crowd.id, anna.cookie, "four");
  assert.equal(stillFull.status, 403);

  // A rejected one frees it.
  await h.db.setPhotoModeration({
    photoId: String(first.body.photoId),
    state: "rejected",
    moderatorId: h.admin.id,
  });
  const freed = await upload(h, h.crowd.id, anna.cookie, "five");
  assert.equal(freed.status, 201);

  // The cap is per user, not per album: someone else still has their own two slots.
  const bruno = await participant(h, "bruno@example.com");
  assert.equal((await upload(h, h.crowd.id, bruno.cookie, "b-one")).status, 201);
});

// ---- C2: post-moderation is the default --------------------------------------------------

test("moderation `post`: the photo is approved on arrival and visible at once", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const done = await upload(h, h.crowd.id, anna.cookie, "one");
  assert.equal(done.status, 201);
  assert.equal(done.body.status, "uploaded");
  assert.equal(done.body.moderationState, "approved");

  const photo = await h.db.findPhoto(String(done.body.photoId));
  assert.ok(photo);
  assert.equal(photo.moderationState, "approved");
  // `moderation_state` is SEPARATE from `status`: the processing pipeline is untouched.
  assert.equal(photo.status, "uploaded");
  assert.equal(photo.albumId, h.crowd.id);

  await derive(h, photo.id);
  const feed = await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, anna.cookie));
  assert.equal(feed.status, 200);
  const parsed = albumPhotosResponseSchema.parse(await feed.json());
  assert.equal(parsed.photos.length, 1);
  assert.equal(parsed.photos[0]?.id, photo.id);
  assert.equal(parsed.photos[0]?.mine, true);
  assert.deepEqual(parsed.quota, { used: 1, max: null });
});

test("the album carries from init to complete (upload_sessions.album_id)", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const bytes = Buffer.from("one");
  const init = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      {
        filename: "p.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      anna.cookie,
    ),
  );
  const created = (await init.json()) as { id: string; objectKey: string };
  const session = await h.db.findUploadSession(created.id);
  assert.ok(session);
  assert.equal(session.albumId, h.crowd.id);

  await h.objects.put(created.objectKey, bytes, "image/jpeg");
  const done = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/${created.id}/complete`, { parts: [] }, anna.cookie),
  );
  assert.equal(done.status, 201);
  const photo = await h.db.findPhoto(String(((await done.json()) as { photoId: string }).photoId));
  assert.equal(photo?.albumId, h.crowd.id);
});

test("a session belonging to another album or another user is a 404", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const bruno = await participant(h, "bruno@example.com");
  const bytes = Buffer.from("one");
  const init = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      {
        filename: "p.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      anna.cookie,
    ),
  );
  const created = (await init.json()) as { id: string };
  const stolen = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/${created.id}/complete`, { parts: [] }, bruno.cookie),
  );
  assert.equal(stolen.status, 404);
});

// ---- C2: the screening hook --------------------------------------------------------------

test("the screening hook's default is a no-op; `auto_rejected` withholds and purges", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const published = await upload(h, h.crowd.id, anna.cookie, "fine");
  assert.equal(published.body.moderationState, "approved");
  assert.equal(h.screening.seen.length, 1);
  assert.equal(h.screening.seen[0]?.albumId, h.crowd.id);
  assert.equal(h.screening.seen[0]?.uploaderId, anna.user.id);

  h.screening.verdict = { state: "auto_rejected", reason: "nsfw:0.97" };
  const withheld = await upload(h, h.crowd.id, anna.cookie, "bad");
  assert.equal(withheld.status, 201);
  assert.equal(withheld.body.status, "auto_rejected");
  // Withheld before publication: `purgePhoto` removed the row and the object.
  assert.equal(await h.db.findPhoto(String(withheld.body.photoId)), null);
  assert.ok(h.objects.deleted.length > 0);
});

test("without an injected hook the default implementation publishes everything", async () => {
  // `screening` left out of AppDeps: `noopScreening` is what runs.
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const album = await db.createAlbum({
    eventId: event.id,
    slug: "di-tutti",
    name: "Album di tutti",
    kind: "crowd",
  });
  const objects = new MemoryObjectStore();
  const app = createApp({
    env,
    db,
    objects,
    mailer: new StubMailer(),
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
  });
  const user = await db.createUser({ email: "anna@example.com", role: "participant" });
  const cookie = await cookieFor(db, user.id);
  const bytes = Buffer.from("one");
  const init = await app.request(
    json(
      "POST",
      `/v1/albums/${album.id}/uploads/init`,
      {
        filename: "p.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      cookie,
    ),
  );
  const created = (await init.json()) as { id: string; objectKey: string };
  await objects.put(created.objectKey, bytes, "image/jpeg");
  const done = await app.request(
    json("POST", `/v1/albums/${album.id}/uploads/${created.id}/complete`, { parts: [] }, cookie),
  );
  assert.equal(done.status, 201);
  assert.equal(((await done.json()) as { moderationState: string }).moderationState, "approved");
});

// ---- C2: dedup is per album --------------------------------------------------------------

test("the same bytes twice in one album answer `already-uploaded`, not an error", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const first = await upload(h, h.crowd.id, anna.cookie, "same-bytes");
  assert.equal(first.status, 201);

  const bytes = Buffer.from("same-bytes");
  const again = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      {
        filename: "p.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      anna.cookie,
    ),
  );
  assert.equal(again.status, 200);
  const parsed = albumUploadDedupeResponseSchema.parse(await again.json());
  assert.equal(parsed.status, "already-uploaded");
  assert.equal(parsed.photoId, first.body.photoId);
  assert.equal(parsed.albumId, h.crowd.id);

  // Someone else re-forwarding the same WhatsApp image gets the same answer, not a 409.
  const bruno = await participant(h, "bruno@example.com");
  const other = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      {
        filename: "p.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      bruno.cookie,
    ),
  );
  assert.equal(other.status, 200);
});

test("the photographer route dedups per album and answers `already-uploaded`", async () => {
  const h = await harness();
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const cookie = await cookieFor(h.db, photographer.id);
  const bytes = Buffer.from("photographer-bytes");
  const body = {
    eventId: h.event.id,
    filename: "a.jpg",
    contentType: "image/jpeg" as const,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    stage: "original" as const,
  };
  const init = await h.app.request(json("POST", "/v1/uploads/init", body, cookie));
  assert.equal(init.status, 201);
  const created = (await init.json()) as { id: string; objectKey: string };
  await h.objects.put(created.objectKey, bytes, "image/jpeg");
  const done = await h.app.request(
    json("POST", `/v1/uploads/${created.id}/complete`, { parts: [] }, cookie),
  );
  assert.equal(done.status, 201);
  const photoId = ((await done.json()) as { photoId: string }).photoId;
  // The official album, resolved by the route, is where it landed.
  assert.equal((await h.db.findPhoto(photoId))?.albumId, h.official.id);

  const again = await h.app.request(json("POST", "/v1/uploads/init", body, cookie));
  assert.equal(again.status, 200);
  const parsed = albumUploadDedupeResponseSchema.parse(await again.json());
  assert.deepEqual(parsed, {
    status: "already-uploaded",
    photoId,
    albumId: h.official.id,
  });

  // The SAME bytes in the crowd album are a different photo (`unique (album_id, sha256)`).
  const anna = await participant(h, "anna@example.com");
  const crowdUpload = await upload(h, h.crowd.id, anna.cookie, "photographer-bytes");
  assert.equal(crowdUpload.status, 201);
  assert.notEqual(crowdUpload.body.photoId, photoId);
});

// ---- C2: the report button and the auto-pending threshold --------------------------------

test("a photo reaching the report threshold flips to pending and leaves the gallery", async () => {
  const h = await harness({}, {}, { REPORT_AUTO_PENDING: "2" });
  const anna = await participant(h, "anna@example.com");
  const done = await upload(h, h.crowd.id, anna.cookie, "one");
  const photoId = String(done.body.photoId);
  await derive(h, photoId);

  const bruno = await participant(h, "bruno@example.com");
  const carla = await participant(h, "carla@example.com");

  const first = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "inappropriate" }, bruno.cookie),
  );
  assert.equal(first.status, 200);
  const firstBody = reportResponseSchema.parse(await first.json());
  assert.deepEqual(firstBody, {
    status: "recorded",
    state: "approved",
    openReports: 1,
    counts: true,
    // A crowd-album photo is in nobody's match gallery, so there is nothing to hide for the
    // reporter: `hiddenForYou` is about `gallery_feedback`, not about the album feed.
    hiddenForYou: false,
  });
  // Still visible under the threshold.
  const visible = albumPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, anna.cookie))).json(),
  );
  assert.equal(visible.photos.length, 1);

  // A second report from the SAME person changes nothing: the threshold counts people.
  // (A stored `not_me` is the one thing a second report may change — see the escalation
  // test below — and this first report was already a counting one.)
  const repeat = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "other" }, bruno.cookie),
  );
  const repeatBody = reportResponseSchema.parse(await repeat.json());
  assert.deepEqual(repeatBody, {
    status: "already-reported",
    state: "approved",
    openReports: 1,
    counts: true,
    hiddenForYou: false,
  });

  // The second DISTINCT person crosses it, with a counting reason. `not_me` could not: that
  // is the whole point of MODERATION_COUNTING_REASONS.
  const second = await h.app.request(
    json(
      "POST",
      `/v1/photos/${photoId}/report`,
      { reason: "inappropriate", note: "non va bene" },
      carla.cookie,
    ),
  );
  const secondBody = reportResponseSchema.parse(await second.json());
  assert.deepEqual(secondBody, {
    status: "recorded",
    state: "pending",
    openReports: 2,
    counts: true,
    hiddenForYou: false,
  });
  assert.equal((await h.db.findPhoto(photoId))?.moderationState, "pending");

  // And it is gone from the album feed until a moderator rules.
  const gone = albumPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, anna.cookie))).json(),
  );
  assert.equal(gone.photos.length, 0);
});

test("reporting requires a participant of the event and a photo still visible", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const done = await upload(h, h.crowd.id, anna.cookie, "one");
  const photoId = String(done.body.photoId);

  assert.equal(
    (await h.app.request(json("POST", `/v1/photos/${photoId}/report`, { reason: "other" }))).status,
    401,
  );
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/photos/${randomUUID()}/report`, { reason: "other" }, anna.cookie),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/photos/${photoId}/report`, { reason: "nope" }, anna.cookie),
      )
    ).status,
    400,
  );

  await h.db.setPhotoModeration({
    photoId,
    state: "rejected",
    moderatorId: h.admin.id,
  });
  const withheld = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "other" }, anna.cookie),
  );
  assert.equal(withheld.status, 404);
  assert.deepEqual(await withheld.json(), { error: MESSAGES.photoNotVisible });
});

/**
 * Seeds `count` official-album photos with derivatives and puts them in `userId`'s personal
 * match gallery, scores descending. Returns the photo ids in gallery order.
 */
async function seedMatchGallery(
  h: Harness,
  userId: string,
  count: number,
  salt = "",
): Promise<string[]> {
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);
  const items: Array<{ photoId: string; faceId: string; score: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const photoId = randomUUID();
    const bytes = Buffer.from(`original-${salt}-${index}`);
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
    await derive(h, photoId);
    items.push({ photoId, faceId: randomUUID(), score: 0.9 - index * 0.1 });
  }
  await h.db.replaceGallery(userId, h.event.id, items, ["anchor-1"]);
  return items.map((row) => row.photoId);
}

/**
 * THE regression guard for the interaction that made `not_me` dangerous.
 *
 * `not_me` is the expected output of face matching: one group photo is matched to several
 * people and each of them correctly rejects it. Because a non-approved photo leaves EVERY
 * personal gallery, counting those rejections toward the auto-pending threshold would turn
 * the recognition system's normal error mode into global takedowns — three taps on
 * "non sono io" and a correctly-uploaded photo vanishes for all 6,000 participants until one
 * of two moderators rules on it.
 *
 * So: the reports are recorded, the photo stays `approved` and visible to everyone else, and
 * the only thing that changes is the reporter's own `gallery_feedback` row.
 */
test("not_me reports never reach the threshold: the photo stays approved and visible to everyone else", async () => {
  // A threshold of 2 that `not_me` must not be able to cross, even with 3 distinct people.
  const h = await harness({}, {}, { REPORT_AUTO_PENDING: "2" });
  const anna = await participant(h, "anna@example.com");
  const bruno = await participant(h, "bruno@example.com");
  const carla = await participant(h, "carla@example.com");
  const dario = await participant(h, "dario@example.com");

  // One group photo, in everybody's match gallery: exactly the shape that produces wrong
  // matches at scale.
  const [photoId] = await seedMatchGallery(h, anna.user.id, 1, "group");
  assert.ok(photoId);
  for (const other of [bruno, carla, dario]) {
    await h.db.replaceGallery(
      other.user.id,
      h.event.id,
      [{ photoId, faceId: randomUUID(), score: 0.82 }],
      ["anchor-1"],
    );
  }

  // Three DISTINCT people say "non sono io" — one more than the threshold.
  for (const reporter of [bruno, carla, dario]) {
    const res = await h.app.request(
      json("POST", `/v1/photos/${photoId}/report`, { reason: "not_me" }, reporter.cookie),
    );
    assert.equal(res.status, 200);
    const body = reportResponseSchema.parse(await res.json());
    assert.equal(body.status, "recorded");
    assert.equal(body.state, "approved", "a wrong match is not a takedown");
    assert.equal(body.counts, false, "not_me never counts toward the threshold");
    assert.equal(body.openReports, 0, "the counting total ignores not_me entirely");
    assert.equal(body.hiddenForYou, true, "but it does hide the photo for the reporter");
  }

  // The photo itself never moved.
  const photo = await h.db.findPhoto(photoId);
  assert.equal(photo?.moderationState, "approved");
  // The reports were recorded, so a moderator can still see the wrong-match signal.
  assert.equal(await h.db.countOpenNotMeReports(photoId), 3);
  assert.equal(await h.db.countOpenReports(photoId), 0);

  // It is still in the gallery of someone who did NOT report it, unflagged.
  const annaPage = await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 });
  assert.equal(annaPage.total, 1);
  assert.equal(annaPage.items[0]?.photoId, photoId);
  assert.deepEqual(await h.db.listFeedback(anna.user.id, h.event.id, [photoId]), []);

  // And it is flagged `not_me` for each reporter — the per-user answer they actually asked
  // for. (v5 keeps the row and the web hides it under "Nascoste"; the report route writes
  // exactly the same `gallery_feedback` row as the gallery's own button.)
  for (const reporter of [bruno, carla, dario]) {
    assert.deepEqual(await h.db.listFeedback(reporter.user.id, h.event.id, [photoId]), [
      { photoId, verdict: "not_me" },
    ]);
  }

  // By default the queue does not carry it: at 6,000 participants wrong matches would bury
  // two moderators. A moderator who wants them asks for them.
  const adminCookie = await cookieFor(h.db, h.admin.id);
  const quiet = moderationResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/moderation", adminCookie))).json(),
  );
  assert.equal(quiet.items.length, 0);
  const asked = moderationResponseSchema.parse(
    await (
      await h.app.request(get("/v1/admin/moderation?includeNotMe=true", adminCookie))
    ).json(),
  );
  assert.equal(asked.items.length, 1);
  assert.equal(asked.items[0]?.photoId, photoId);
  assert.equal(asked.items[0]?.openReports, 0);
  assert.equal(asked.items[0]?.notMeReports, 3);
  assert.deepEqual(asked.items[0]?.reasons, ["not_me"]);
});

/** The other half of the guard: excluding `not_me` must not have disabled moderation. */
test("the threshold still fires on inappropriate reports from distinct people", async () => {
  const h = await harness({}, {}, { REPORT_AUTO_PENDING: "2" });
  const anna = await participant(h, "anna@example.com");
  const bruno = await participant(h, "bruno@example.com");
  const carla = await participant(h, "carla@example.com");
  const [photoId] = await seedMatchGallery(h, anna.user.id, 1, "abuse");
  assert.ok(photoId);

  // A `not_me` first, from the person who will then escalate. It must neither count nor
  // spend their only report on this photo: tapping "non sono io" and later realising the
  // photo is genuinely inappropriate has to remain sayable.
  const ignored = reportResponseSchema.parse(
    await (
      await h.app.request(
        json("POST", `/v1/photos/${photoId}/report`, { reason: "not_me" }, bruno.cookie),
      )
    ).json(),
  );
  assert.equal(ignored.openReports, 0);
  assert.equal(ignored.state, "approved");

  // The same person escalates `not_me` -> `inappropriate`: one counting report now, still
  // under the threshold and still visible.
  const first = reportResponseSchema.parse(
    await (
      await h.app.request(
        json("POST", `/v1/photos/${photoId}/report`, { reason: "inappropriate" }, bruno.cookie),
      )
    ).json(),
  );
  assert.equal(first.status, "recorded", "an escalation is a new report, not a repeat");
  assert.equal(first.counts, true);
  assert.equal(first.openReports, 1);
  assert.equal(first.state, "approved");
  // One row, escalated in place: the escalation did not become a second vote.
  assert.equal(await h.db.countOpenNotMeReports(photoId), 0);
  assert.equal((await h.db.listOpenReports(photoId)).length, 1);
  // And it is one-way: `not_me` can never replace a counting reason, so this is not a way
  // to un-report a photo.
  const downgrade = reportResponseSchema.parse(
    await (
      await h.app.request(
        json("POST", `/v1/photos/${photoId}/report`, { reason: "not_me" }, bruno.cookie),
      )
    ).json(),
  );
  assert.equal(downgrade.status, "already-reported");
  assert.equal(downgrade.openReports, 1);
  assert.equal((await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 })).total, 1);

  // A second DISTINCT person with a counting reason crosses it.
  const second = reportResponseSchema.parse(
    await (
      await h.app.request(
        json("POST", `/v1/photos/${photoId}/report`, { reason: "copyright" }, carla.cookie),
      )
    ).json(),
  );
  assert.equal(second.openReports, 2);
  assert.equal(second.state, "pending");
  assert.equal((await h.db.findPhoto(photoId))?.moderationState, "pending");
  // And now it really does leave everyone's gallery, which is the point of the threshold.
  assert.equal((await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 })).total, 0);

  // It is in the queue without being asked for, with the wrong-match signal alongside.
  const adminCookie = await cookieFor(h.db, h.admin.id);
  const page = moderationResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/moderation", adminCookie))).json(),
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.photoId, photoId);
  assert.equal(page.items[0]?.openReports, 2);
  // Bruno's `not_me` was escalated in place, so no wrong-match signal is left on this photo.
  assert.equal(page.items[0]?.notMeReports, 0);
  assert.deepEqual(page.items[0]?.reasons, ["copyright", "inappropriate"]);
});

// ---- C2: the moderation queue and the rulings --------------------------------------------

test("the queue shows what is not approved or carries an open report; staff only", async () => {
  const h = await harness({}, {}, { REPORT_AUTO_PENDING: "5" });
  const anna = await participant(h, "anna@example.com");
  const bruno = await participant(h, "bruno@example.com");
  const quiet = await upload(h, h.crowd.id, anna.cookie, "quiet");
  const reported = await upload(h, h.crowd.id, anna.cookie, "reported");
  await derive(h, String(quiet.body.photoId));
  await derive(h, String(reported.body.photoId));
  await h.app.request(
    json(
      "POST",
      `/v1/photos/${String(reported.body.photoId)}/report`,
      { reason: "inappropriate" },
      bruno.cookie,
    ),
  );

  assert.equal((await h.app.request(get("/v1/admin/moderation", anna.cookie))).status, 403);
  assert.equal((await h.app.request(get("/v1/admin/moderation"))).status, 401);

  const adminCookie = await cookieFor(h.db, h.admin.id);
  const res = await h.app.request(get("/v1/admin/moderation", adminCookie));
  assert.equal(res.status, 200);
  const page = moderationResponseSchema.parse(await res.json());
  assert.equal(page.items.length, 1, "an approved photo with no report is not in the queue");
  const item = page.items[0];
  assert.equal(item?.photoId, reported.body.photoId);
  assert.equal(item?.moderationState, "approved");
  assert.equal(item?.openReports, 1);
  assert.deepEqual(item?.reasons, ["inappropriate"]);
  assert.ok(item?.thumbUrl);

  // Filters.
  const byAlbum = moderationResponseSchema.parse(
    await (
      await h.app.request(get(`/v1/admin/moderation?albumId=${h.official.id}`, adminCookie))
    ).json(),
  );
  assert.equal(byAlbum.items.length, 0);
  const byState = moderationResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/moderation?state=pending", adminCookie))).json(),
  );
  assert.equal(byState.items.length, 0);
});

// `moderated_by` / `moderated_at` and the `audit_log` row are asserted against a real
// Postgres in packages/db/src/moderation.pg.test.ts: MemoryDatabase.insertAudit is a no-op
// and keeps no accessor for the two columns, so this test covers the transitions only.
test("moderating settles the reports, restores the photo, and is staff-only", async () => {
  const h = await harness({}, {}, { REPORT_AUTO_PENDING: "1" });
  const anna = await participant(h, "anna@example.com");
  const bruno = await participant(h, "bruno@example.com");
  const done = await upload(h, h.crowd.id, anna.cookie, "one");
  const photoId = String(done.body.photoId);
  await derive(h, photoId);
  const report = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "inappropriate" }, bruno.cookie),
  );
  assert.equal(reportResponseSchema.parse(await report.json()).state, "pending");

  const adminCookie = await cookieFor(h.db, h.admin.id);
  const approved = await h.app.request(
    json("POST", `/v1/admin/photos/${photoId}/moderate`, { state: "approved" }, adminCookie),
  );
  assert.equal(approved.status, 200);
  assert.deepEqual(moderateResponseSchema.parse(await approved.json()), {
    photoId,
    state: "approved",
    purged: false,
  });
  // The reports that caused it are settled, so the same report cannot re-trigger it.
  assert.equal(await h.db.countOpenReports(photoId), 0);
  assert.equal((await h.db.findPhoto(photoId))?.moderationState, "approved");
  // Visible again.
  const feed = albumPhotosResponseSchema.parse(
    await (await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, anna.cookie))).json(),
  );
  assert.equal(feed.photos.length, 1);

  // Only staff may rule, and an unknown photo is a 404.
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/admin/photos/${photoId}/moderate`, { state: "rejected" }, anna.cookie),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/admin/photos/${randomUUID()}/moderate`, { state: "rejected" }, adminCookie),
      )
    ).status,
    404,
  );
  // `auto_rejected` is the hook's verdict, never a moderator's.
  assert.equal(
    (
      await h.app.request(
        json(
          "POST",
          `/v1/admin/photos/${photoId}/moderate`,
          { state: "auto_rejected" },
          adminCookie,
        ),
      )
    ).status,
    400,
  );
});

test("rejecting purges the object through purgePhoto", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const done = await upload(h, h.crowd.id, anna.cookie, "one");
  const photoId = String(done.body.photoId);
  await derive(h, photoId);
  const photo = await h.db.findPhoto(photoId);
  assert.ok(photo);
  assert.ok(h.objects.objects.has(photo.originalKey));

  const adminCookie = await cookieFor(h.db, h.admin.id);
  const res = await h.app.request(
    json("POST", `/v1/admin/photos/${photoId}/moderate`, { state: "rejected" }, adminCookie),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(moderateResponseSchema.parse(await res.json()), {
    photoId,
    state: "rejected",
    purged: true,
  });
  // purgePhoto: the row, the original and both derivatives are gone.
  assert.equal(await h.db.findPhoto(photoId), null);
  assert.equal(h.objects.objects.has(photo.originalKey), false);
  assert.equal(h.objects.objects.has(objectKeys.thumb(photoId)), false);
  assert.equal(h.objects.objects.has(objectKeys.web(photoId)), false);
});

test("a staff-only album is not readable by a participant", async () => {
  const h = await harness({}, { visibility: "staff" });
  const anna = await participant(h, "anna@example.com");
  const res = await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, anna.cookie));
  assert.equal(res.status, 403);
  // Staff still read it.
  const adminCookie = await cookieFor(h.db, h.admin.id);
  assert.equal(
    (await h.app.request(get(`/v1/albums/${h.crowd.id}/photos`, adminCookie))).status,
    200,
  );
});

// ---- C3: video is out of scope -----------------------------------------------------------

test("the upload route refuses every video content type (decision 4, frozen)", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  for (const contentType of ["video/mp4", "video/quicktime", "video/webm", "image/heic"]) {
    const res = await h.app.request(
      json(
        "POST",
        `/v1/albums/${h.crowd.id}/uploads/init`,
        {
          filename: "clip.mp4",
          contentType,
          sha256: sha256(Buffer.from("x")),
          bytes: 10,
        },
        anna.cookie,
      ),
    );
    assert.equal(res.status, 400, contentType);
    assert.deepEqual(await res.json(), { error: MESSAGES.validation });
  }
});

test("complete refuses bytes stored under a content type the PUT was not signed for", async () => {
  // Ported from main's fda8d64 — and this is the riskier of the two upload paths, because
  // it is the one any signed-in participant can reach. `albumUploadInitBodySchema` keeps the
  // DECLARED type to image/jpeg or image/png (the test above), but S3 stores whatever
  // `Content-Type` the client actually sent, so the declared type alone proves nothing.
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const bytes = Buffer.from("MZ\u0090\u0000not an image at all");
  const init = await h.app.request(
    json(
      "POST",
      `/v1/albums/${h.crowd.id}/uploads/init`,
      {
        filename: "polaroid.jpg",
        contentType: "image/jpeg",
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      },
      anna.cookie,
    ),
  );
  assert.equal(init.status, 201);
  const created = (await init.json()) as { id: string; objectKey: string };
  // Right key, right byte count, wrong stored content type.
  await h.objects.put(created.objectKey, bytes, "application/x-msdownload");
  const done = await h.app.request(
    json("POST", `/v1/albums/${h.crowd.id}/uploads/${created.id}/complete`, { parts: [] }, anna.cookie),
  );
  assert.equal(done.status, 400);
  assert.deepEqual(await done.json(), { error: MESSAGES.validation });
  assert.equal((await h.db.findUploadSession(created.id))?.status, "aborted");
  // The bytes go back out, and no photo row was ever created.
  assert.ok(h.objects.deleted.includes(created.objectKey));
  assert.equal(h.objects.objects.has(created.objectKey), false);
  assert.equal(await h.db.findPhotoByAlbumSha(h.crowd.id, sha256(bytes)), null);
});

// ---- the burst gate (ported from main's PUBLIC_UPLOAD_RATE_LIMIT) -------------------------

test("crowd uploads are rate limited per participant per album, and the limit is per album", async () => {
  // Main had `PUBLIC_UPLOAD_RATE_LIMIT` on its participant upload path; this branch had no
  // rate limit of any kind here. `max_photos_per_user` is NOT a substitute: it is null by
  // default, and this album leaves it null on purpose so the 429 can only be the burst gate.
  const h = await harness({}, {}, { ALBUM_UPLOAD_MAX_PER_HOUR: "3" });
  assert.equal(h.crowd.maxPhotosPerUser, null, "the absolute cap must be off for this test");
  const anna = await participant(h, "anna@example.com");

  for (let n = 0; n < 3; n += 1) {
    const res = await upload(h, h.crowd.id, anna.cookie, `shot-${n}`);
    assert.equal(res.status, 201, `upload ${n} should be allowed`);
  }
  const limited = await upload(h, h.crowd.id, anna.cookie, "shot-4");
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: MESSAGES.rateLimited });

  // Another participant is unaffected: the window is per (album, uploader).
  const bruno = await participant(h, "bruno@example.com");
  assert.equal((await upload(h, h.crowd.id, bruno.cookie, "bruno-1")).status, 201);

  // And so is a sibling crowd album, which has its own uploads_open and its own cap.
  const other = await h.db.createAlbum({
    eventId: h.event.id,
    slug: "secondo",
    name: "Secondo album",
    kind: "crowd",
  });
  assert.equal((await upload(h, other.id, anna.cookie, "altro-1")).status, 201);
});

test("the burst gate counts sessions that were started, not photos that landed", async () => {
  // An init that never completes still cost a presigned PUT, so a loop that inits and walks
  // away has to count. This is why the fallback counts `upload_sessions` rather than photos.
  const h = await harness({}, {}, { ALBUM_UPLOAD_MAX_PER_HOUR: "2" });
  const anna = await participant(h, "anna@example.com");
  const init = (n: number) => {
    const bytes = Buffer.from(`abandoned-${n}`);
    return h.app.request(
      json(
        "POST",
        `/v1/albums/${h.crowd.id}/uploads/init`,
        {
          filename: "polaroid.jpg",
          contentType: "image/jpeg",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
        },
        anna.cookie,
      ),
    );
  };
  assert.equal((await init(0)).status, 201);
  assert.equal((await init(1)).status, 201);
  assert.equal((await h.db.countAlbumPhotosByUploader(h.crowd.id, anna.user.id)), 0);
  const third = await init(2);
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: MESSAGES.rateLimited });
});

test("ALBUM_UPLOAD_MAX_PER_HOUR = 0 disables the burst gate, and exempt IPs skip it", async () => {
  const off = await harness({}, {}, { ALBUM_UPLOAD_MAX_PER_HOUR: "0" });
  const anna = await participant(off, "anna@example.com");
  for (let n = 0; n < 4; n += 1) {
    assert.equal((await upload(off, off.crowd.id, anna.cookie, `off-${n}`)).status, 201);
  }

  // The test room's NAT: one IP, many participants, all behind the exempt CIDR.
  const exempt = await harness(
    {},
    {},
    { ALBUM_UPLOAD_MAX_PER_HOUR: "1", RATE_LIMIT_EXEMPT_IPS: "10.20.0.0/16" },
  );
  const bruno = await participant(exempt, "bruno@example.com");
  const initFrom = (ip: string, n: number) => {
    const bytes = Buffer.from(`nat-${ip}-${n}`);
    return exempt.app.request(
      new Request(`http://api.local/v1/albums/${exempt.crowd.id}/uploads/init`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: bruno.cookie,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({
          filename: "polaroid.jpg",
          contentType: "image/jpeg",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
        }),
      }),
    );
  };
  for (let n = 0; n < 3; n += 1) {
    assert.equal((await initFrom("10.20.33.44", n)).status, 201, `exempt attempt ${n}`);
  }
  // The same account from an IP outside the CIDR is gated again — and it is gated at once,
  // because the exemption skips the CHECK and not the RECORDING: the database fallback
  // counts `upload_sessions` rows, and the three exempt inits wrote three of them. This is
  // main's behaviour too, and it is the honest one for a count of what actually happened.
  // (The Redis path differs: an exempt call never reaches the INCR. Documented, not a bug —
  // the two paths agree on the common case, where nothing is exempt.)
  assert.equal((await initFrom("198.51.100.7", 0)).status, 429);
});

// ---- Section G, hard rule: the personal match galleries are untouched ---------------------

test("a personal match gallery still works, and a withheld photo leaves it", async () => {
  const h = await harness();
  const anna = await participant(h, "anna@example.com");
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer);

  const items: Array<{ photoId: string; faceId: string; score: number }> = [];
  for (let index = 0; index < 3; index += 1) {
    const photoId = randomUUID();
    const bytes = Buffer.from(`original-${index}`);
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
    await derive(h, photoId);
    items.push({ photoId, faceId: randomUUID(), score: 0.9 - index * 0.1 });
  }
  await h.db.replaceGallery(anna.user.id, h.event.id, items, ["anchor-1"]);

  const before = await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 });
  assert.equal(before.total, 3);
  assert.equal(before.items.length, 3);

  // C2: a photo withheld by moderation leaves the gallery until a moderator rules.
  await h.db.setPhotoModeration({ photoId: items[0]!.photoId, state: "pending" });
  const during = await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 });
  assert.equal(during.total, 2);
  assert.equal(during.items.length, 2);

  // And comes back when the moderator approves it: the gallery row itself never moved.
  await h.db.setPhotoModeration({
    photoId: items[0]!.photoId,
    state: "approved",
    moderatorId: h.admin.id,
  });
  const after = await h.db.listGalleryPage(anna.user.id, h.event.id, { limit: 10 });
  assert.equal(after.total, 3);
  assert.deepEqual(
    after.items.map((row) => row.photoId),
    items.map((row) => row.photoId),
  );
});

// ---- integration fix 1: event membership actually bites ------------------------------------
//
// `assertEventMember` read `if (event.access !== "list") return;`, so on an `open` event it
// authorised ANY signed-in participant. A person registered at event A could upload to, list
// and report in event B's crowd album. These tests cover the three call sites named in agent
// E's hand-over note, plus the cross-event case itself.

/** Event B: its own crowd album, and nobody from the harness event is a member of it. */
async function otherEvent(h: Harness): Promise<{ eventId: string; crowd: AlbumRow }> {
  const other = await h.db.createEvent({ slug: "altro-evento", name: "Altro evento" });
  const crowd = await h.db.createAlbum({
    eventId: other.id,
    slug: "di-tutti",
    name: "Album di tutti",
    kind: "crowd",
  });
  return { eventId: other.id, crowd };
}

test("a participant of another event cannot list a crowd album they do not belong to", async () => {
  const h = await harness();
  const other = await otherEvent(h);
  // Anna belongs to the harness event, and to nothing else. Both events are `access = 'open'`,
  // which is exactly the case the old check waved through.
  const anna = await participant(h, "anna@example.com");
  assert.equal(await h.db.isEventMember(anna.user.id, h.event.id), true);
  assert.equal(await h.db.isEventMember(anna.user.id, other.eventId), false);

  const refused = await h.app.request(
    json("GET", `/v1/albums/${other.crowd.id}/photos`, undefined, anna.cookie),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: MESSAGES.notEventMember });

  // Her own event's crowd album is untouched by the fix.
  const allowed = await h.app.request(
    json("GET", `/v1/albums/${h.crowd.id}/photos`, undefined, anna.cookie),
  );
  assert.equal(allowed.status, 200);
});

test("a participant of another event cannot report a photo in a crowd album they do not belong to", async () => {
  const h = await harness();
  const other = await otherEvent(h);
  // Bruno is a member of event B and puts a photo in its crowd album.
  const bruno = await strangerParticipant(h, "bruno@example.com");
  await h.db.addEventMember({
    userId: bruno.user.id,
    eventId: other.eventId,
    source: "event_code",
  });
  const posted = await upload(h, other.crowd.id, bruno.cookie, "bruno-in-b");
  assert.equal(posted.status, 201);
  const photoId = posted.body.photoId as string;

  // Anna, a member of the harness event only, must not be able to report it: a report is a
  // takedown signal, and enough of them withhold the photo from everyone.
  const anna = await participant(h, "anna@example.com");
  const refused = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "inappropriate" }, anna.cookie),
  );
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: MESSAGES.notEventMember });
  assert.equal(await h.db.countOpenReports(photoId), 0);

  // Bruno, who does belong to event B, still can.
  const ok = await h.app.request(
    json("POST", `/v1/photos/${photoId}/report`, { reason: "inappropriate" }, bruno.cookie),
  );
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { status: string }).status, "recorded");
  assert.equal(await h.db.countOpenReports(photoId), 1);
});

test("uploading into a crowd album records membership with source 'upload'", async () => {
  const h = await harness();
  // A share-link / QR arrival: signed in (Google knows nothing about any event), no event
  // code, so no membership row. This path works today and must keep working — so the upload
  // route enrols rather than refusing.
  const link = await strangerParticipant(h, "link@example.com");
  assert.equal(await h.db.isEventMember(link.user.id, h.event.id), false);

  const posted = await upload(h, h.crowd.id, link.cookie, "arrived-by-link");
  assert.equal(posted.status, 201);

  const member = await h.db.findEventMember(link.user.id, h.event.id);
  assert.ok(member, "the upload path writes the membership row");
  assert.equal(member.source, "upload");
  assert.equal(member.eventId, h.event.id);

  // And having uploaded, they can now read the album they just contributed to.
  const feed = await h.app.request(
    json("GET", `/v1/albums/${h.crowd.id}/photos`, undefined, link.cookie),
  );
  assert.equal(feed.status, 200);
});

test("the upload path checks the allowlist BEFORE enrolling, so a gated event stays gated", async () => {
  const h = await harness();
  // `access = 'list'` is the gated event: the imported allowlist is the boundary, and it is
  // checked first so no membership row is written for an event the person cannot use.
  await h.db.updateEvent(h.event.id, { access: "list" });
  const stranger = await strangerParticipant(h, "stranger@example.com");

  const refused = await upload(h, h.crowd.id, stranger.cookie, "should-not-land");
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: MESSAGES.notOnList });
  assert.equal(
    await h.db.isEventMember(stranger.user.id, h.event.id),
    false,
    "a refused upload must not leave a membership row behind",
  );

  // On the allowlist, the same upload enrols and succeeds.
  await h.db.upsertEventParticipants(h.event.id, ["stranger@example.com"]);
  const ok = await upload(h, h.crowd.id, stranger.cookie, "should-land");
  assert.equal(ok.status, 201);
  assert.equal(await h.db.isEventMember(stranger.user.id, h.event.id), true);
});

test("accepting an invite records event membership", async () => {
  const h = await harness();
  const token = randomUUID();
  await h.db.insertInvite({
    email: "invitato@example.com",
    eventId: h.event.id,
    tokenHash: sha256Hex(token),
    role: "participant",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const res = await h.app.request(json("POST", "/v1/auth/accept-invite", { token }));
  assert.equal(res.status, 200);
  const user = await h.db.findUserByEmailRole("invitato@example.com", "participant");
  assert.ok(user);
  const member = await h.db.findEventMember(user.id, h.event.id);
  assert.ok(member, "invite acceptance is an entry path and records membership");
  assert.equal(member.source, "invite");
});
