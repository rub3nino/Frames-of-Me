import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { envSchema, SESSION_COOKIE_NAME, type Env } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/crypto.ts";
import type { Mailer, MailMessage } from "../src/mailer.ts";
import type {
  CompletedPart,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
  StreamedObject,
} from "../src/object-store.ts";
import { createQueue } from "../src/queue.ts";

/**
 * v6 D (agent D): the admin console API — event codes, albums, per-album photographer
 * authorization, live status, participants, operations links.
 *
 * What is proven here:
 *
 *  - authorization per role on every new route (no session → 401, participant → 403);
 *  - the two frozen album rules, refused by the api as the database refuses them: a crowd
 *    album never recognises faces, and `recognition` is immutable after the first upload
 *    (the form's side of the same rules is `apps/web/lib/album-rules.test.ts`);
 *  - an event code is mintable, usable by `POST /v1/auth/register`, cappable, expirable and
 *    revocable — the blocking deliverable, end to end;
 *  - the shape of the live status screen;
 *  - the operations page lists exactly the configured `OPS_LINK_*` and nothing else.
 *
 * The moderation queue API belongs to agent C (spec section C2) and is not tested here.
 * Nothing here touches `galleries` / `gallery_items`: the personal match galleries are read
 * through the existing v5 route.
 */

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

/** The admin console never reads or writes objects: every method is a stub. */
class StubObjectStore implements ObjectStore {
  async put(key: string, body: Uint8Array, contentType: string, options?: PutObjectOptions): Promise<void> {
    void key;
    void body;
    void contentType;
    void options;
  }
  async get(): Promise<StoredObject | null> {
    return null;
  }
  async stream(): Promise<StreamedObject | null> {
    return { body: Readable.from([]), contentType: "image/jpeg", bytes: 0 };
  }
  async head(): Promise<{ bytes: number; contentType: string } | null> {
    return null;
  }
  async delete(): Promise<void> {}
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

class SilentMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

type Harness = {
  app: ReturnType<typeof createApp>;
  db: MemoryDatabase;
  event: { id: string; slug: string };
  adminCookie: string;
  participantCookie: string;
  photographerId: string;
};

async function harness(overrideEnv: Env = env): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const app = createApp({
    env: overrideEnv,
    db,
    objects: new StubObjectStore(),
    mailer: new SilentMailer(),
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
  });
  const admin = await db.findUserByEmailRole("admin@rephoto.local", "admin");
  const photographer = await db.findUserByEmailRole("photographer@rephoto.local", "photographer");
  assert.ok(admin && photographer);
  const participant = await db.insertUser("ospite@example.com", "participant");
  return {
    app,
    db,
    event: { id: event.id, slug: event.slug },
    adminCookie: await sessionCookie(db, admin.id),
    participantCookie: await sessionCookie(db, participant.id),
    photographerId: photographer.id,
  };
}

async function sessionCookie(db: MemoryDatabase, userId: string): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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

function del(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://api.local${path}`, { method: "DELETE", headers });
}

async function mintCode(
  h: Harness,
  body: Record<string, unknown> = {},
): Promise<{ code: string; uses: number; status: string }> {
  const response = await h.app.request(
    json("POST", `/v1/admin/events/${h.event.id}/codes`, body, { cookie: h.adminCookie }),
  );
  assert.equal(response.status, 201);
  const data = (await response.json()) as { code: { code: string; uses: number; status: string } };
  return data.code;
}

// ---- authorization --------------------------------------------------------------------------

test("every admin console route needs an admin session", async () => {
  const h = await harness();
  const album = await h.db.findDefaultAlbum(h.event.id);
  assert.ok(album);
  const calls: Request[] = [
    get(`/v1/admin/events/${h.event.id}/codes`),
    json("POST", `/v1/admin/events/${h.event.id}/codes`, {}),
    json("PATCH", `/v1/admin/events/${h.event.id}/codes/ABCD-EFGH`, { label: "x" }),
    del(`/v1/admin/events/${h.event.id}/codes/ABCD-EFGH`),
    get(`/v1/admin/events/${h.event.id}/albums`),
    json("POST", `/v1/admin/events/${h.event.id}/albums`, { slug: "x", name: "X", kind: "crowd" }),
    get(`/v1/admin/albums/${album.id}`),
    json("PATCH", `/v1/admin/albums/${album.id}`, { name: "X" }),
    get(`/v1/admin/albums/${album.id}/photographers`),
    json("POST", `/v1/admin/albums/${album.id}/photographers`, { email: "a@b.it" }),
    del(`/v1/admin/albums/${album.id}/photographers/${h.photographerId}`),
    get(`/v1/admin/events/${h.event.id}/status`),
    get(`/v1/admin/participants/lookup?eventId=${h.event.id}&email=ospite@example.com`),
    get("/v1/admin/ops-links"),
  ];
  for (const call of calls) {
    const anonymous = await h.app.request(call.clone());
    assert.equal(anonymous.status, 401, `${call.method} ${new URL(call.url).pathname} without a session`);
    const headers = new Headers(call.headers);
    headers.set("cookie", h.participantCookie);
    const asParticipant = await h.app.request(new Request(call.url, { method: call.method, headers, body: call.body ? await call.clone().text() : null }));
    assert.equal(
      asParticipant.status,
      403,
      `${call.method} ${new URL(call.url).pathname} as a participant`,
    );
  }
});

test("GET /v1/me/albums is for photographers and admins, not participants", async () => {
  const h = await harness();
  const anonymous = await h.app.request(get(`/v1/me/albums?eventId=${h.event.id}`));
  assert.equal(anonymous.status, 401);
  const asParticipant = await h.app.request(
    get(`/v1/me/albums?eventId=${h.event.id}`, { cookie: h.participantCookie }),
  );
  assert.equal(asParticipant.status, 403);
  const asPhotographer = await h.app.request(
    get(`/v1/me/albums?eventId=${h.event.id}`, {
      cookie: await sessionCookie(h.db, h.photographerId),
    }),
  );
  assert.equal(asPhotographer.status, 200);
});

// ---- event codes (the blocking deliverable) -------------------------------------------------

test("a minted code registers a participant, and is listed afterwards", async () => {
  const h = await harness();
  const minted = await mintCode(h, { label: "Badge ingresso" });
  assert.match(minted.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(minted.uses, 0);
  assert.equal(minted.status, "active");

  const registered = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "nuovo@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(registered.status, 201, await registered.text());

  const listed = await h.app.request(
    get(`/v1/admin/events/${h.event.id}/codes`, { cookie: h.adminCookie }),
  );
  assert.equal(listed.status, 200);
  const { codes } = (await listed.json()) as { codes: Array<{ code: string; uses: number; label: string | null }> };
  const row = codes.find((entry) => entry.code === minted.code);
  assert.ok(row);
  assert.equal(row.uses, 1);
  assert.equal(row.label, "Badge ingresso");
});

test("a code is case-insensitive on the way in and stored uppercase", async () => {
  const h = await harness();
  const minted = await mintCode(h, { code: "festa-2026" });
  assert.equal(minted.code, "FESTA-2026");
  const registered = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "minuscolo@example.com",
      password: "unapasswordlunga",
      eventCode: "festa-2026",
    }),
  );
  assert.equal(registered.status, 201);
});

test("the same code twice in one event is a conflict", async () => {
  const h = await harness();
  await mintCode(h, { code: "UNO-UNO" });
  const again = await h.app.request(
    json("POST", `/v1/admin/events/${h.event.id}/codes`, { code: "UNO-UNO" }, { cookie: h.adminCookie }),
  );
  assert.equal(again.status, 409);
});

test("a capped code stops at its cap", async () => {
  const h = await harness();
  const minted = await mintCode(h, { maxUses: 1 });
  const first = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "primo@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(first.status, 201);
  const second = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "secondo@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(second.status, 403);
  const listed = await h.app.request(
    get(`/v1/admin/events/${h.event.id}/codes`, { cookie: h.adminCookie }),
  );
  const { codes } = (await listed.json()) as { codes: Array<{ code: string; status: string }> };
  assert.equal(codes.find((entry) => entry.code === minted.code)?.status, "exhausted");
});

test("capping a live code at the uses already made closes it", async () => {
  const h = await harness();
  const minted = await mintCode(h);
  await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "terzo@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  const capped = await h.app.request(
    json(
      "PATCH",
      `/v1/admin/events/${h.event.id}/codes/${minted.code}`,
      { maxUses: 1 },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(capped.status, 200);
  const { code } = (await capped.json()) as { code: { status: string; uses: number; maxUses: number } };
  assert.equal(code.uses, 1);
  assert.equal(code.maxUses, 1);
  assert.equal(code.status, "exhausted");
  const blocked = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "quarto@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(blocked.status, 403);
});

test("an expiry in the past refuses the code", async () => {
  const h = await harness();
  const minted = await mintCode(h, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(minted.status, "expired");
  const refused = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "tardi@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(refused.status, 403);
});

test("revoking a code refuses it but keeps the uses it already had", async () => {
  const h = await harness();
  const minted = await mintCode(h);
  await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "prima@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  const revoked = await h.app.request(
    del(`/v1/admin/events/${h.event.id}/codes/${minted.code}`, { cookie: h.adminCookie }),
  );
  assert.equal(revoked.status, 200);
  const { code } = (await revoked.json()) as { code: { status: string; uses: number } };
  assert.equal(code.status, "expired");
  assert.equal(code.uses, 1, "the row keeps who already registered");
  const refused = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "dopo@example.com",
      password: "unapasswordlunga",
      eventCode: minted.code,
    }),
  );
  assert.equal(refused.status, 403);
  // Revoking something that is not there is a 404, not a silent success.
  const missing = await h.app.request(
    del(`/v1/admin/events/${h.event.id}/codes/MAI-MAI00`, { cookie: h.adminCookie }),
  );
  assert.equal(missing.status, 404);
});

// ---- albums: the two frozen rules -----------------------------------------------------------

test("rule 2: creating a crowd album with recognition is refused", async () => {
  const h = await harness();
  const refused = await h.app.request(
    json(
      "POST",
      `/v1/admin/events/${h.event.id}/albums`,
      { slug: "tutti", name: "Album di tutti", kind: "crowd", recognition: true },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(refused.status, 400, "the contract refuses the pair before the database sees it");
});

test("rule 2: turning recognition on for a crowd album is refused with the reason", async () => {
  const h = await harness();
  const created = await h.app.request(
    json(
      "POST",
      `/v1/admin/events/${h.event.id}/albums`,
      { slug: "tutti", name: "Album di tutti", kind: "crowd" },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(created.status, 201);
  const { album } = (await created.json()) as { album: { id: string; recognition: boolean; moderation: string } };
  assert.equal(album.recognition, false);
  assert.equal(album.moderation, "post", "a crowd album defaults to post-moderation");

  const refused = await h.app.request(
    json("PATCH", `/v1/admin/albums/${album.id}`, { recognition: true }, { cookie: h.adminCookie }),
  );
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /riconoscimento/i);
});

test("rule 3: recognition is immutable once the album has its first upload", async () => {
  const h = await harness();
  const created = await h.app.request(
    json(
      "POST",
      `/v1/admin/events/${h.event.id}/albums`,
      { slug: "secondo", name: "Secondo album", kind: "official", recognition: false },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(created.status, 201);
  const { album } = (await created.json()) as { album: { id: string } };

  // Before the first photo the flag moves freely.
  const allowed = await h.app.request(
    json("PATCH", `/v1/admin/albums/${album.id}`, { recognition: true }, { cookie: h.adminCookie }),
  );
  assert.equal(allowed.status, 200);

  await h.db.markAlbumFirstUpload(album.id);

  const refused = await h.app.request(
    json("PATCH", `/v1/admin/albums/${album.id}`, { recognition: false }, { cookie: h.adminCookie }),
  );
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /prima foto/i);

  // Everything else about the album still changes after the first upload.
  const renamed = await h.app.request(
    json(
      "PATCH",
      `/v1/admin/albums/${album.id}`,
      { name: "Rinominato", uploadsOpen: false },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(renamed.status, 200);
  const patched = (await renamed.json()) as { album: { name: string; uploadsOpen: boolean; recognition: boolean } };
  assert.equal(patched.album.name, "Rinominato");
  assert.equal(patched.album.uploadsOpen, false);
  assert.equal(patched.album.recognition, true, "the locked flag kept its value");
});

test("albums list starts with the official album of the event", async () => {
  const h = await harness();
  const response = await h.app.request(
    get(`/v1/admin/events/${h.event.id}/albums`, { cookie: h.adminCookie }),
  );
  assert.equal(response.status, 200);
  const { albums } = (await response.json()) as {
    albums: Array<{ slug: string; kind: string; recognition: boolean }>;
  };
  assert.equal(albums.length, 1);
  assert.equal(albums[0]?.slug, "ufficiale");
  assert.equal(albums[0]?.kind, "official");
  assert.equal(albums[0]?.recognition, true);
});

test("the same slug twice in one event is a conflict", async () => {
  const h = await harness();
  const body = { slug: "doppio", name: "Doppio", kind: "official" as const };
  const first = await h.app.request(
    json("POST", `/v1/admin/events/${h.event.id}/albums`, body, { cookie: h.adminCookie }),
  );
  assert.equal(first.status, 201);
  const second = await h.app.request(
    json("POST", `/v1/admin/events/${h.event.id}/albums`, body, { cookie: h.adminCookie }),
  );
  assert.equal(second.status, 409);
});

// ---- photographer authorization per album ---------------------------------------------------

test("an album with no list is open to every photographer of the event", async () => {
  const h = await harness();
  const album = await h.db.findDefaultAlbum(h.event.id);
  assert.ok(album);
  const response = await h.app.request(
    get(`/v1/admin/albums/${album.id}/photographers`, { cookie: h.adminCookie }),
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as { photographers: unknown[]; restricted: boolean };
  assert.deepEqual(data.photographers, []);
  assert.equal(data.restricted, false);
});

test("an album with a list only lets the listed photographers in", async () => {
  const h = await harness();
  const other = await h.db.insertUser("secondo@studio.it", "photographer");
  await h.db.addEventPhotographer(h.event.id, other.id);

  const created = await h.app.request(
    json(
      "POST",
      `/v1/admin/events/${h.event.id}/albums`,
      { slug: "ristretto", name: "Album ristretto", kind: "official", recognition: true },
      { cookie: h.adminCookie },
    ),
  );
  const { album } = (await created.json()) as { album: { id: string } };

  const granted = await h.app.request(
    json(
      "POST",
      `/v1/admin/albums/${album.id}/photographers`,
      { email: "secondo@studio.it" },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(granted.status, 201);

  const listed = await h.app.request(
    get(`/v1/admin/albums/${album.id}/photographers`, { cookie: h.adminCookie }),
  );
  const data = (await listed.json()) as { photographers: Array<{ email: string }>; restricted: boolean };
  assert.equal(data.restricted, true);
  assert.deepEqual(data.photographers.map((row) => row.email), ["secondo@studio.it"]);

  const mine = await h.app.request(
    get(`/v1/me/albums?eventId=${h.event.id}`, { cookie: await sessionCookie(h.db, h.photographerId) }),
  );
  const seen = (await mine.json()) as { albums: Array<{ slug: string }> };
  assert.deepEqual(
    seen.albums.map((row) => row.slug),
    ["ufficiale"],
    "the photographer who is not on the list does not see the restricted album",
  );

  const theirs = await h.app.request(
    get(`/v1/me/albums?eventId=${h.event.id}`, { cookie: await sessionCookie(h.db, other.id) }),
  );
  const allowed = (await theirs.json()) as { albums: Array<{ slug: string }> };
  assert.deepEqual(allowed.albums.map((row) => row.slug).sort(), ["ristretto", "ufficiale"]);

  // Removing the last grant puts the album back to the event-level rule.
  const removed = await h.app.request(
    del(`/v1/admin/albums/${album.id}/photographers/${other.id}`, { cookie: h.adminCookie }),
  );
  assert.equal(removed.status, 200);
  const after = await h.app.request(
    get(`/v1/me/albums?eventId=${h.event.id}`, { cookie: await sessionCookie(h.db, h.photographerId) }),
  );
  const reopened = (await after.json()) as { albums: Array<{ slug: string }> };
  assert.equal(reopened.albums.length, 2);
});

test("authorizing an unknown photographer is a 404, not a new user", async () => {
  const h = await harness();
  const album = await h.db.findDefaultAlbum(h.event.id);
  assert.ok(album);
  const response = await h.app.request(
    json(
      "POST",
      `/v1/admin/albums/${album.id}/photographers`,
      { email: "mai@visto.it" },
      { cookie: h.adminCookie },
    ),
  );
  assert.equal(response.status, 404);
  assert.equal(await h.db.findUserByEmailRole("mai@visto.it", "photographer"), null);
});

// ---- live status ----------------------------------------------------------------------------

test("the live status screen reports the event's media, albums, queue and errors", async () => {
  const h = await harness();
  await h.app.request(
    json(
      "POST",
      `/v1/admin/events/${h.event.id}/albums`,
      { slug: "tutti", name: "Album di tutti", kind: "crowd", uploadsOpen: false },
      { cookie: h.adminCookie },
    ),
  );
  const response = await h.app.request(
    get(`/v1/admin/events/${h.event.id}/status`, { cookie: h.adminCookie }),
  );
  assert.equal(response.status, 200);
  const status = (await response.json()) as {
    event: { slug: string };
    photos: number;
    photosByStatus: Record<string, number>;
    faces: number;
    galleries: number;
    selfiesWaiting: number;
    matchJobsPending: number;
    albums: Array<{ slug: string; uploadsOpen: boolean; photos: number }>;
    jobsByType: unknown[];
    lastErrors: unknown[];
    faceService: { ok: boolean | null };
    at: string;
  };
  assert.equal(status.event.slug, "demo");
  assert.deepEqual(Object.keys(status.photosByStatus).sort(), ["error", "indexed", "processing", "uploaded"]);
  assert.equal(status.photos, 0);
  assert.equal(status.selfiesWaiting, 0);
  assert.equal(status.matchJobsPending, 0);
  // Ordered by `created_at, id` and both albums are created in the same millisecond here,
  // so the set is what matters, not the order.
  assert.deepEqual(
    new Map(status.albums.map((album) => [album.slug, album.uploadsOpen])),
    new Map([
      ["ufficiale", true],
      ["tutti", false],
    ]),
  );
  assert.ok(Array.isArray(status.jobsByType));
  assert.ok(Array.isArray(status.lastErrors));
  assert.equal(status.faceService.ok, null, "no face service with FACE_ENGINE=fake");
  assert.ok(!Number.isNaN(Date.parse(status.at)));
});

// ---- participants ---------------------------------------------------------------------------

test("a participant lookup reports consent, verification and gallery, and never revokes", async () => {
  const h = await harness();
  const response = await h.app.request(
    get(`/v1/admin/participants/lookup?eventId=${h.event.id}&email=OSPITE@example.com`, {
      cookie: h.adminCookie,
    }),
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as {
    user: { email: string };
    consent: { active: boolean; canRevoke: boolean };
    onParticipantList: boolean;
    emailVerifiedAt: string | null;
    gallery: unknown | null;
  };
  assert.equal(data.user.email, "ospite@example.com");
  assert.equal(data.consent.active, false);
  assert.equal(data.consent.canRevoke, false, "revocation is agent G's: the seam stays closed");
  assert.equal(data.gallery, null);
  assert.equal(data.emailVerifiedAt, null);

  const unknown = await h.app.request(
    get(`/v1/admin/participants/lookup?eventId=${h.event.id}&email=nessuno@example.com`, {
      cookie: h.adminCookie,
    }),
  );
  assert.equal(unknown.status, 404);
});

// ---- operations -----------------------------------------------------------------------------

test("the operations page lists exactly the configured OPS_LINK_* and nothing else", async () => {
  const empty = await harness();
  const none = await empty.app.request(get("/v1/admin/ops-links", { cookie: empty.adminCookie }));
  assert.equal(none.status, 200);
  assert.deepEqual(((await none.json()) as { links: unknown[] }).links, []);

  const configured = await harness(
    envSchema.parse({
      ...baseEnv,
      OPS_LINK_RESEND: "https://resend.com/emails",
      OPS_LINK_SENTRY: "https://sentry.io/issues/",
    }),
  );
  const response = await configured.app.request(
    get("/v1/admin/ops-links", { cookie: configured.adminCookie }),
  );
  const { links } = (await response.json()) as { links: Array<{ key: string; url: string }> };
  assert.deepEqual(
    links.map((link) => link.key),
    ["resend", "sentry"],
  );
  assert.equal(links[0]?.url, "https://resend.com/emails");
});
