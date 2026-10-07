/**
 * v6 G (agent G): the privacy routes — withdrawal by the participant, withdrawal by an
 * admin, the "I miei dati" read model and the retention schedule the status screen reads.
 *
 * The deletion itself is proven against a real Postgres in
 * `packages/db/src/privacy.pg.test.ts`; what is checked here is the HTTP contract: who may
 * call what, what comes back, which audit row is written, and that a withdrawal really does
 * close the selfie door until the participant consents again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  adminRetentionScheduleResponseSchema,
  consentWithdrawResponseSchema,
  CONSENT_TEXT_VERSION,
  envSchema,
  privacyStateResponseSchema,
  SESSION_COOKIE_NAME,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase, type Database } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/crypto.ts";
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

const env: Env = envSchema.parse({
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
});

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly deleted: string[] = [];

  async put(key: string, body: Uint8Array, contentType: string, options?: PutObjectOptions) {
    void options;
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async stream(key: string): Promise<StreamedObject | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { body: Readable.from([Buffer.from(stored.body)]), contentType: stored.contentType, bytes: stored.body.byteLength };
  }
  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const stored = this.objects.get(key);
    return stored ? { bytes: stored.body.byteLength, contentType: stored.contentType } : null;
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
  async presignPut(): Promise<string> {
    return "http://localhost:9000/put";
  }
  async createMultipartUpload(): Promise<string> {
    return `mp-${randomUUID()}`;
  }
  async presignUploadPart(): Promise<string> {
    return "http://localhost:9000/part";
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    void key;
    void uploadId;
    void parts;
  }
  async abortMultipartUpload(): Promise<void> {}
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

type Audit = { actorId: string | null; action: string; target: string; meta: Record<string, unknown> };

type Harness = {
  app: ReturnType<typeof createApp>;
  db: MemoryDatabase;
  objects: MemoryObjectStore;
  audits: Audit[];
  deletedFaces: string[][];
  event: { id: string; slug: string };
};

async function harness(): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const objects = new MemoryObjectStore();
  const inner = new FakeFaceEngine(new MemoryFaceIndexStore());
  const deletedFaces: string[][] = [];
  const app = createApp({
    env,
    db,
    objects,
    mailer: new RecordingMailer(),
    queue: createQueue(db),
    faces: {
      ...inner,
      indexPhoto: inner.indexPhoto.bind(inner),
      search: inner.search.bind(inner),
      searchFaces: inner.searchFaces.bind(inner),
      deleteCollection: inner.deleteCollection.bind(inner),
      async deleteFaces(eventId: string, ids: string[]) {
        deletedFaces.push([...ids]);
        await inner.deleteFaces(eventId, ids);
      },
    },
  });
  const audits: Audit[] = [];
  const typed: Database = db;
  typed.insertAudit = async (input) => {
    audits.push(input);
  };
  return { app, db, objects, audits, deletedFaces, event: { id: event.id, slug: event.slug } };
}

async function session(db: MemoryDatabase, userId: string): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function json(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://api.local${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://api.local${path}`, { method: "GET", headers });
}

/** A participant with a consent, a matched gallery, a selfie vector, anchors and a kept selfie. */
async function participantWithGallery(
  h: Harness,
  email = "ritira@example.com",
): Promise<{ userId: string; cookie: string; photoId: string; externalFaceId: string; selfieKey: string }> {
  const user = await h.db.createUser({ email, role: "participant" });
  await h.db.insertConsent({
    userId: user.id,
    eventId: h.event.id,
    textVersion: CONSENT_TEXT_VERSION,
    ip: "203.0.113.7",
    userAgent: "test",
  });
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(photographer, "seedDemo creates the photographer");
  const photoId = randomUUID();
  await h.db.insertPhoto({
    id: photoId,
    eventId: h.event.id,
    photographerId: photographer.id,
    sha256: randomUUID().replaceAll("-", "").repeat(2).slice(0, 64),
    originalKey: `originals/${h.event.id}/${photoId}`,
    contentType: "image/jpeg",
    bytes: 1234,
  });
  const externalFaceId = `face-${photoId}`;
  await h.db.replaceFaces(photoId, h.event.id, [
    { externalId: externalFaceId, bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.99 },
  ]);
  const faces = await h.db.findFaceRowsByPhoto(photoId);
  const face = faces[0];
  assert.ok(face);
  await h.db.replaceGallery(
    user.id,
    h.event.id,
    [{ photoId, faceId: face.id, score: 0.95 }],
    [externalFaceId],
  );
  const selfieKey = `selfies/${h.event.id}/${user.id}/kept.jpg`;
  await h.objects.put(selfieKey, Buffer.from("selfie"), "image/jpeg");
  await h.db.updateGalleryMatch(user.id, h.event.id, {
    queryEmbedding: [0.1, 0.2, 0.3],
    selfieKey,
  });
  return { userId: user.id, cookie: await session(h.db, user.id), photoId, externalFaceId, selfieKey };
}

function selfieRequest(slug: string, cookie: string): Request {
  const form = new FormData();
  form.set("selfie", new File([Buffer.from("not really a jpeg")], "me.jpg", { type: "image/jpeg" }));
  return new Request(`http://api.local/v1/events/${slug}/selfie`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

test("the privacy page shows the consent, the gallery and the participant's own uploads", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  const response = await h.app.request(get(`/v1/events/${h.event.slug}/privacy`, { cookie: person.cookie }));
  assert.equal(response.status, 200);
  const state = privacyStateResponseSchema.parse(await response.json());
  assert.equal(state.event.slug, h.event.slug);
  assert.equal(state.consent?.textVersion, CONSENT_TEXT_VERSION);
  assert.equal(state.withdrawnAt, null);
  assert.equal(state.gallery?.photos, 1);
  assert.equal(state.gallery?.selfieVector, true);
  assert.equal(state.gallery?.anchors, 1);
  assert.equal(state.uploads, 0, "the photo was uploaded by the photographer, not by them");
});

test("the participant withdraws: gallery, selfie vector, anchors, templates and selfie object go", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);

  const response = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/consent/withdraw`, { confirm: true }, { cookie: person.cookie }),
  );
  assert.equal(response.status, 200);
  const body = consentWithdrawResponseSchema.parse(await response.json());
  assert.deepEqual(body.deleted, {
    consents: 1,
    gallery: true,
    galleryItems: 1,
    selfieVector: true,
    anchors: 1,
    faceVectors: 0,
    selfieObjects: 1,
    feedback: 0,
    matchRuns: 0,
  });
  assert.ok(Date.parse(body.withdrawnAt) > 0);

  // The engine is told about the identified face (what deletes the Rekognition entry; with
  // FACE_ENGINE=insightface the row is already gone inside the transaction).
  assert.deepEqual(h.deletedFaces, [[person.externalFaceId]]);
  assert.ok(h.objects.deleted.includes(person.selfieKey), "the kept selfie object is deleted");
  assert.equal(await h.db.hasActiveConsent(person.userId, h.event.id), false);
  assert.equal(await h.db.findGalleryByUser(person.userId, h.event.id), null);

  const audit = h.audits.find((row) => row.action === "consent.withdrawn");
  assert.ok(audit, "every withdrawal leaves an audit row");
  assert.equal(audit.actorId, person.userId);
  assert.equal(audit.target, `user:${person.userId}`);
  assert.equal(audit.meta.eventId, h.event.id);
  assert.equal(audit.meta.identifiedFaces, 1);
  assert.ok(!("externalFaceIds" in audit.meta), "the face ids are never written to the audit");

  // The photo stays in the album; only the link to the person is gone.
  const photo = await h.db.findPhoto(person.photoId);
  assert.ok(photo, "the photo of the official album is not deleted by a withdrawal");

  // And the door is shut: no selfie until a new consent.
  const selfie = await h.app.request(selfieRequest(h.event.slug, person.cookie));
  assert.equal(selfie.status, 403);
  assert.equal(((await selfie.json()) as { error: string }).error, MESSAGES.consentRequired);

  const state = privacyStateResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/privacy`, { cookie: person.cookie }))).json(),
  );
  assert.equal(state.consent, null);
  assert.ok(state.withdrawnAt);
  assert.equal(state.gallery, null);
});

test("re-consent after a withdrawal reopens the selfie and does not resurrect the gallery", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/consent/withdraw`, { confirm: true }, { cookie: person.cookie }),
  );

  const consent = await h.app.request(
    json(
      "POST",
      `/v1/events/${h.event.slug}/consent`,
      { textVersion: CONSENT_TEXT_VERSION, accepted: true },
      { cookie: person.cookie },
    ),
  );
  assert.equal(consent.status, 201);
  assert.equal(await h.db.hasActiveConsent(person.userId, h.event.id), true);
  assert.equal(await h.db.findGalleryByUser(person.userId, h.event.id), null, "a new selfie is needed");

  const selfie = await h.app.request(selfieRequest(h.event.slug, person.cookie));
  assert.equal(selfie.status, 202, "the selfie is accepted again");
});

test("a second withdrawal deletes nothing and still answers 200", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  const body = { confirm: true };
  await h.app.request(json("POST", `/v1/events/${h.event.slug}/consent/withdraw`, body, { cookie: person.cookie }));
  const again = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/consent/withdraw`, body, { cookie: person.cookie }),
  );
  assert.equal(again.status, 200);
  const parsed = consentWithdrawResponseSchema.parse(await again.json());
  assert.deepEqual(
    { consents: parsed.deleted.consents, gallery: parsed.deleted.gallery, items: parsed.deleted.galleryItems },
    { consents: 0, gallery: false, items: 0 },
  );
});

test("withdrawal needs the confirmation, a session and the participant role", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  const path = `/v1/events/${h.event.slug}/consent/withdraw`;

  assert.equal((await h.app.request(json("POST", path, {}, { cookie: person.cookie }))).status, 400);
  assert.equal(
    (await h.app.request(json("POST", path, { confirm: false }, { cookie: person.cookie }))).status,
    400,
  );
  assert.equal((await h.app.request(json("POST", path, { confirm: true }))).status, 401);

  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const adminCookie = await session(h.db, admin.id);
  assert.equal(
    (await h.app.request(json("POST", path, { confirm: true }, { cookie: adminCookie }))).status,
    403,
    "the self-service route is the participant's own: an admin uses the admin route",
  );
  assert.equal(
    (await h.app.request(get(`/v1/events/${h.event.slug}/privacy`, { cookie: adminCookie }))).status,
    403,
  );
});

test("an admin withdraws for a participant, with the reason in the audit row", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const cookie = await session(h.db, admin.id);

  const response = await h.app.request(
    json(
      "POST",
      `/v1/admin/participants/${person.userId}/consent/withdraw`,
      { eventId: h.event.id, note: "richiesta via e-mail del 2026-10-07" },
      { cookie },
    ),
  );
  assert.equal(response.status, 200);
  const body = consentWithdrawResponseSchema.parse(await response.json());
  assert.equal(body.deleted.gallery, true);
  assert.equal(body.deleted.selfieVector, true);
  assert.equal(await h.db.hasActiveConsent(person.userId, h.event.id), false);

  const audit = h.audits.find((row) => row.action === "consent.withdrawn");
  assert.ok(audit);
  assert.equal(audit.actorId, admin.id, "the admin is the actor");
  assert.equal(audit.target, `user:${person.userId}`, "the participant is the target");
  assert.equal(audit.meta.note, "richiesta via e-mail del 2026-10-07");
});

test("the admin withdrawal route refuses an unknown user, a non-participant and a non-admin", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  const photographer = await h.db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(admin && photographer);
  const cookie = await session(h.db, admin.id);

  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/admin/participants/${randomUUID()}/consent/withdraw`, { eventId: h.event.id }, { cookie }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/admin/participants/${photographer.id}/consent/withdraw`, { eventId: h.event.id }, { cookie }),
      )
    ).status,
    404,
    "a photographer is not a participant",
  );
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/admin/participants/${person.userId}/consent/withdraw`, { eventId: randomUUID() }, { cookie }),
      )
    ).status,
    404,
    "unknown event",
  );
  assert.equal(
    (
      await h.app.request(
        json(
          "POST",
          `/v1/admin/participants/${person.userId}/consent/withdraw`,
          { eventId: h.event.id },
          { cookie: person.cookie },
        )
      )
    ).status,
    403,
  );
  assert.equal(
    (await h.app.request(json("POST", `/v1/admin/participants/not-a-uuid/consent/withdraw`, { eventId: h.event.id }, { cookie }))).status,
    400,
  );
});

test("the retention schedule reports every event, the next window and the alarm", async () => {
  const h = await harness();
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const cookie = await session(h.db, admin.id);

  const first = adminRetentionScheduleResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/retention/schedule", { cookie }))).json(),
  );
  assert.equal(first.enabled, true, "RETENTION_SCHEDULER defaults to true");
  assert.equal(first.windowSeconds, 24 * 3600);
  const before = first.events.find((row) => row.eventId === h.event.id);
  assert.ok(before);
  assert.equal(before.runs, 0);
  assert.equal(before.lastRunAt, null);
  assert.equal(before.alarm, "never", "nothing has ever run for this event");
  assert.ok(Date.parse(before.nextRunAt) <= Date.now(), "a run is due now");

  const windowStart = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
  assert.equal(
    await h.db.claimRetentionWindow({ eventId: h.event.id, windowStart, windowSeconds: 86_400 }),
    true,
  );
  const jobId = await h.db.enqueueJob("retention", { eventId: h.event.id, actorId: null });
  await h.db.recordRetentionRun({ eventId: h.event.id, outcome: "enqueued", jobId });

  const after = adminRetentionScheduleResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/retention/schedule", { cookie }))).json(),
  );
  const row = after.events.find((event) => event.eventId === h.event.id);
  assert.ok(row);
  assert.equal(row.runs, 1);
  assert.equal(row.outcome, "enqueued");
  assert.equal(row.jobId, jobId);
  assert.equal(row.jobStatus, "queued");
  assert.equal(row.alarm, null);
  assert.equal(
    row.nextRunAt,
    new Date(windowStart.getTime() + 86_400_000).toISOString(),
    "the next run is the next window, not a timer",
  );

  await h.db.recordRetentionRun({ eventId: h.event.id, outcome: "failed", error: "coda non disponibile" });
  const failed = adminRetentionScheduleResponseSchema.parse(
    await (await h.app.request(get("/v1/admin/retention/schedule", { cookie }))).json(),
  );
  assert.equal(failed.events.find((event) => event.eventId === h.event.id)?.alarm, "failed");
});

test("the retention schedule is admin-only", async () => {
  const h = await harness();
  const person = await participantWithGallery(h);
  assert.equal((await h.app.request(get("/v1/admin/retention/schedule"))).status, 401);
  assert.equal(
    (await h.app.request(get("/v1/admin/retention/schedule", { cookie: person.cookie }))).status,
    403,
  );
});
