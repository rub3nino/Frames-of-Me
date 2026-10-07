/**
 * v6 E (agent E): tagging.
 *
 * Tagging makes the same person<->photo link face recognition makes, minus the biometrics, so
 * these tests are written as privacy tests, not feature tests. The autocomplete block below
 * ("the autocomplete must not become a directory") has one test per rule that keeps
 * `/tags/search` from publishing a searchable roster of 6 000 participants, because that is
 * exactly the endpoint a later "improvement" relaxes. If one of them starts failing, the
 * endpoint got looser — read the header of `apps/api/src/routes.tags.ts` before touching it.
 *
 * No network, no Postgres: `MemoryDatabase` mirrors migration 013 (`users.taggable` defaults
 * to false, `photo_tags` keyed by (photo_id, user_id), `audit_log` readable by target).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  envSchema,
  objectKeys,
  photoTagsResponseSchema,
  SESSION_COOKIE_NAME,
  TAG_CONSENT_TEXT,
  TAG_CONSENT_TEXT_VERSION,
  TAG_SEARCH_RATE_LIMIT,
  tagsMeResponseSchema,
  tagSearchResponseSchema,
  type Env,
} from "@rephoto/contracts";
import { MemoryDatabase, type Database } from "@rephoto/db";
import { FakeFaceEngine, MemoryFaceIndexStore } from "../../../packages/face-engine/src/fake.ts";
import { createApp } from "../src/app.ts";
import { sha256Hex } from "../src/crypto.ts";
import type { AppDeps } from "../src/deps.ts";
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

/** Tagging never reads or writes object bytes; only `presignGet` is ever called. */
class StubObjectStore implements ObjectStore {
  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    options?: PutObjectOptions,
  ): Promise<void> {
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

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

type Harness = {
  app: ReturnType<typeof createApp>;
  db: MemoryDatabase;
  mailer: RecordingMailer;
  event: { id: string; slug: string };
};

async function harness(overrides: Partial<AppDeps> = {}): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const mailer = new RecordingMailer();
  const app = createApp({
    env,
    db,
    objects: new StubObjectStore(),
    mailer,
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
    ...overrides,
  });
  return { app, db, mailer, event: { id: event.id, slug: event.slug } };
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

type Participant = { id: string; email: string; cookie: string };

type ParticipantOptions = {
  /**
   * A `consents` row: the consent to the BIOMETRIC comparison of a face against the event's
   * photos. Tagging must NOT require it (decision 2: a crowd album is never biometric, so its
   * participants never grant one), so the default is `false` and only the independence tests
   * care about the difference.
   */
  recognitionConsent?: boolean;
  /**
   * An `event_members` row: the NON-BIOMETRIC record of belonging to the event, as
   * `POST /v1/auth/register` writes it when an event code is claimed. This is what tagging is
   * gated on, so the default is `true`; `false` produces the participant who wandered in.
   */
  member?: boolean;
  /** Which event the membership row is for. Defaults to the harness event. */
  eventId?: string;
};

async function participant(
  h: Harness,
  email: string,
  options: ParticipantOptions = {},
): Promise<Participant> {
  const user = await h.db.createUser({ email, role: "participant" });
  if (options.recognitionConsent) {
    await h.db.insertConsent({
      userId: user.id,
      eventId: options.eventId ?? h.event.id,
      textVersion: "v1",
      ip: "127.0.0.1",
      userAgent: "test",
    });
  }
  if (options.member !== false) {
    await h.db.addEventMember({
      userId: user.id,
      eventId: options.eventId ?? h.event.id,
      source: "event_code",
    });
  }
  return { id: user.id, email, cookie: await sessionCookie(h.db, user.id) };
}

/** One photo uploaded by the seeded photographer, with both derivatives in place. */
async function seedPhoto(h: Harness, uploaderId?: string): Promise<string> {
  return seedPhotoIn(h, h.event.id, uploaderId);
}

/** The same, in a named event — the cross-event tests need photos on both sides. */
async function seedPhotoIn(h: Harness, eventId: string, uploaderId?: string): Promise<string> {
  const photographer = await h.db.findUserByEmailRole(
    "photographer@rephoto.local",
    "photographer",
  );
  assert.ok(photographer);
  const photoId = randomUUID();
  const bytes = Buffer.from(`original-${photoId}`);
  await h.db.insertPhoto({
    id: photoId,
    eventId,
    photographerId: uploaderId ?? photographer.id,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    originalKey: objectKeys.original(eventId, photoId),
    contentType: "image/jpeg",
    bytes: bytes.byteLength,
  });
  await h.db.upsertDerivative({ photoId, kind: "thumb", s3Key: objectKeys.thumb(photoId) });
  await h.db.upsertDerivative({ photoId, kind: "web", s3Key: objectKeys.web(photoId) });
  return photoId;
}

/** Puts the photo in the participant's own personal match gallery (so they can see it). */
async function giveGallery(h: Harness, userId: string, photoIds: string[]): Promise<void> {
  await h.db.replaceGallery(
    userId,
    h.event.id,
    photoIds.map((photoId, index) => ({ photoId, faceId: randomUUID(), score: 0.9 - index * 0.01 })),
    ["anchor-1"],
  );
}

/**
 * Opts a participant in, the only way `users.taggable` ever becomes true. The accepted
 * consent version is part of the body: the schema pins it to the current Italian text.
 */
async function optIn(h: Harness, who: Participant, displayName: string): Promise<void> {
  const response = await h.app.request(
    json(
      "PUT",
      `/v1/events/${h.event.slug}/tags/me`,
      { taggable: true, displayName, consentTextVersion: TAG_CONSENT_TEXT_VERSION },
      { cookie: who.cookie },
    ),
  );
  assert.equal(response.status, 200, await response.text());
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

function get(path: string, cookie?: string): Request {
  return new Request(`http://api.local${path}`, { headers: cookie ? { cookie } : {} });
}

function del(path: string, cookie?: string): Request {
  return new Request(`http://api.local${path}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}

// ---- opt-in ------------------------------------------------------------------------------

test("nobody is taggable by default, and the opt-in is the only way in", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  // `users.taggable` defaults to false (migration 013). A brand new participant reads back
  // as not taggable with no display name — not as "unknown", which a later patch could read
  // as a yes.
  const before = tagsMeResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/me`, alice.cookie))).json(),
  );
  assert.equal(before.profile.taggable, false);
  assert.equal(before.profile.displayName, null);
  assert.deepEqual(before.items, []);
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, false);

  await optIn(h, alice, "Alice R.");
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, true);
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.displayName, "Alice R.");
});

test("the opt-in body must say taggable explicitly, and true needs a display name", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  const path = `/v1/events/${h.event.slug}/tags/me`;
  // A body that forgets `taggable` is a validation error, never an implicit opt-in.
  assert.equal((await h.app.request(json("PUT", path, { displayName: "Alice" }, { cookie: alice.cookie }))).status, 400);
  assert.equal((await h.app.request(json("PUT", path, {}, { cookie: alice.cookie }))).status, 400);
  // Taggable with no name would be a findable row with nothing to show but an e-mail.
  assert.equal(
    (
      await h.app.request(
        json("PUT", path, { taggable: true, consentTextVersion: TAG_CONSENT_TEXT_VERSION }, { cookie: alice.cookie }),
      )
    ).status,
    400,
  );
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, false);
  // A one-character display name is refused too (the autocomplete needs 3 characters).
  assert.equal(
    (
      await h.app.request(
        json(
          "PUT",
          path,
          { taggable: true, displayName: "A", consentTextVersion: TAG_CONSENT_TEXT_VERSION },
          { cookie: alice.cookie },
        ),
      )
    ).status,
    400,
  );
});

test("opting in requires accepting the current tagging consent text, and records it", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  const path = `/v1/events/${h.event.slug}/tags/me`;
  // The text says the three things it has to say.
  assert.match(TAG_CONSENT_TEXT, /associno il nome/);
  assert.match(TAG_CONSENT_TEXT, /rimuovere ogni tag/);
  assert.match(TAG_CONSENT_TEXT, /separato dal riconoscimento del volto/);

  // Opting in without the consent version, or with a stale one, is refused by the schema.
  for (const body of [
    { taggable: true, displayName: "Alice Rossi" },
    { taggable: true, displayName: "Alice Rossi", consentTextVersion: "2020-01-01" },
  ]) {
    assert.equal(
      (await h.app.request(json("PUT", path, body, { cookie: alice.cookie }))).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, false);

  await optIn(h, alice, "Alice Rossi");
  const stored = await h.db.findTagProfile(alice.id, h.event.id);
  assert.equal(stored?.consentTextVersion, TAG_CONSENT_TEXT_VERSION);
  assert.ok(stored?.consentAt instanceof Date, "the acceptance is timestamped");
  // Auditable: the accepted version is in the audit row too.
  const rows = await h.db.listAuditForTarget(`user:${alice.id}`);
  assert.deepEqual(rows.map((row) => row.action), ["tag.optin"]);
  assert.equal(rows[0]?.meta.consentTextVersion, TAG_CONSENT_TEXT_VERSION);

  // Opting out clears the consent pair and audits the withdrawal.
  const out = await h.app.request(json("PUT", path, { taggable: false }, { cookie: alice.cookie }));
  assert.equal(out.status, 200);
  const after = await h.db.findTagProfile(alice.id, h.event.id);
  assert.equal(after?.consentTextVersion, null);
  assert.equal(after?.consentAt, null);
  assert.deepEqual(
    (await h.db.listAuditForTarget(`user:${alice.id}`)).map((row) => row.action),
    ["tag.optin", "tag.optout"],
  );
});

test("a participant who never opted in cannot be tagged", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com"); // never opts in
  const photoId = await seedPhoto(h);
  await giveGallery(h, bob.id, [photoId]);

  const response = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
  );
  assert.equal(response.status, 403);
  assert.equal(await h.db.findPhotoTag(photoId, alice.id), null);
  // Nothing was audited either: a refused tag is not a tag.
  assert.deepEqual(await h.db.listAuditForTarget(`photo:${photoId}`), []);
});

test("opting out removes the still-active tags and audits each removal", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice R.");
  const first = await seedPhoto(h);
  const second = await seedPhoto(h);
  await giveGallery(h, bob.id, [first, second]);
  for (const photoId of [first, second]) {
    const created = await h.app.request(
      json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
    );
    assert.equal(created.status, 201, await created.text());
  }

  const out = await h.app.request(
    json("PUT", `/v1/events/${h.event.slug}/tags/me`, { taggable: false }, { cookie: alice.cookie }),
  );
  assert.equal(out.status, 200);
  // A withdrawal ends the links, it does not merely stop new ones.
  for (const photoId of [first, second]) {
    assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "removed");
    const actions = (await h.db.listAuditForTarget(`photo:${photoId}`)).map((row) => row.action);
    assert.deepEqual(actions, ["photo.tagged", "photo.untagged"]);
  }
  const optOutRows = await h.db.listAuditForTarget(`user:${alice.id}`);
  assert.deepEqual(optOutRows.map((row) => row.action), ["tag.optin", "tag.optout"]);
  // And the tagger cannot put them back: the removed rows are still there.
  const again = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId: first, userId: alice.id }, { cookie: bob.cookie }),
  );
  assert.equal(again.status, 403);
});

// ---- tagging must never require the recognition consent ----------------------------------
//
// THE REGRESSION GUARD for a frozen decision. Decision 2 of docs/v6-spec.md freezes that a
// `crowd` album is NEVER biometric: no vectors, no recognition, enforced by the
// `crowd_never_recognizes` check. A participant whose only involvement is the crowd album
// therefore has no reason to ever grant recognition consent — and tagging is precisely the
// feature those people need, because it is the only way they can find themselves in a
// non-biometric album. An earlier revision of these routes gated tagging on an active
// `consents` row, which made the feature unavailable to exactly the population it is for and
// conflated two different legal bases: consent to biometric processing, and consent to be
// named in a photo. `users.taggable`, with its own Italian text, is the second one.
//
// If this test fails, someone has put a `hasActiveConsent` check back. Do not "fix" the test.

test("a participant with NO recognition consent can opt in, be found, be tagged and untag", async () => {
  const h = await harness();
  // No `consents` row for either of them — the crowd-album-only participant.
  const alice = await participant(h, "alice@example.com");
  const bob = await participant(h, "bob@example.com");
  assert.equal(await h.db.hasActiveConsent(alice.id, h.event.id), false);
  assert.equal(await h.db.hasActiveConsent(bob.id, h.event.id), false);

  // 1. She can opt in.
  await optIn(h, alice, "Alice Rossi");
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, true);

  // 2. She is found in the autocomplete, by a tagger who also has no recognition consent.
  const found = tagSearchResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, bob.cookie))).json(),
  );
  assert.deepEqual(found.items, [{ userId: alice.id, displayName: "Alice Rossi" }]);

  // 3. She can be tagged.
  const photoId = await seedPhoto(h, bob.id); // bob uploaded it, so he can see it
  const created = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
  );
  assert.equal(created.status, 201, await created.text());
  const mine = tagsMeResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/me`, alice.cookie))).json(),
  );
  assert.deepEqual(mine.items.map((row) => row.photoId), [photoId]);

  // 4. And she can remove her own tag.
  const removed = await h.app.request(del(`/v1/events/${h.event.slug}/tags/${photoId}`, alice.cookie));
  assert.equal(removed.status, 200);
  assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "removed");

  // Still no `consents` row anywhere: nothing in this flow created one as a side effect.
  assert.equal(await h.db.hasActiveConsent(alice.id, h.event.id), false);
  assert.equal(await h.db.hasActiveConsent(bob.id, h.event.id), false);
});

test("granting the recognition consent changes nothing about tagging", async () => {
  const h = await harness();
  // Same flow, with the recognition consent present. The tagging behaviour is identical,
  // which is the other half of "independent": the gate is neither required nor consulted.
  const alice = await participant(h, "alice@example.com", { recognitionConsent: true });
  const bob = await participant(h, "bob@example.com", { recognitionConsent: true });
  assert.equal(await h.db.hasActiveConsent(alice.id, h.event.id), true);
  await optIn(h, alice, "Alice Rossi");
  const found = tagSearchResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, bob.cookie))).json(),
  );
  assert.deepEqual(found.items, [{ userId: alice.id, displayName: "Alice Rossi" }]);
  const photoId = await seedPhoto(h, bob.id);
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
      )
    ).status,
    201,
  );
});

// ---- event membership, and the opt-in being per event ------------------------------------
//
// THE TEST THAT PROVES THE HOLE IS CLOSED. Until `event_members` existed, "is this person a
// participant of this event?" had no honest answer for someone who never consented to face
// recognition and is not on an allowlist: `consents` and `galleries` are both biometric,
// `event_participants` only exists when `events.access = 'list'`, and the registration path
// resolved the event from the claimed code and then threw it away into an audit line. The
// autocomplete had no event scope at all, so a person who opted in at one event was suggested
// at every event the deployment runs — and a global `users.taggable` would have meant
// consenting once, at one event, to being nameable at all of them, which `TAG_CONSENT_TEXT`
// ("questo evento") would have made a false statement.

test("someone who opted in at event A is NOT suggested, taggable or untagged at event B", async () => {
  const h = await harness();
  const other = await h.db.createEvent({ slug: "altro", name: "Altro evento" });
  // Alice belongs to both events and opts in at the harness event ONLY.
  const alice = await participant(h, "alice@example.com");
  await h.db.addEventMember({ userId: alice.id, eventId: other.id, source: "event_code" });
  const bob = await participant(h, "bob@example.com");
  await h.db.addEventMember({ userId: bob.id, eventId: other.id, source: "event_code" });
  await optIn(h, alice, "Alice Rossi");

  // Found at event A.
  const atA = tagSearchResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, bob.cookie))).json(),
  );
  assert.deepEqual(atA.items, [{ userId: alice.id, displayName: "Alice Rossi" }]);
  // Invisible at event B, although the same account is a member there and has a display name.
  const atB = tagSearchResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${other.slug}/tags/search?q=ali`, bob.cookie))).json(),
  );
  assert.deepEqual(atB.items, [], "the opt-in is per event, so event B knows nothing");
  // And she cannot be tagged at event B either, not even with her id in hand.
  const photoB = await seedPhotoIn(h, other.id, bob.id);
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/events/${other.slug}/tags`, { photoId: photoB, userId: alice.id }, { cookie: bob.cookie }),
      )
    ).status,
    403,
  );
  // Her own profile at event B reads as not taggable, with no consent recorded there.
  const profileB = await h.db.findTagProfile(alice.id, other.id);
  assert.equal(profileB?.taggable, false);
  assert.equal(profileB?.consentTextVersion, null);
});

test("opting out of one event leaves the tags accepted at another event alone", async () => {
  const h = await harness();
  const other = await h.db.createEvent({ slug: "altro", name: "Altro evento" });
  const alice = await participant(h, "alice@example.com");
  await h.db.addEventMember({ userId: alice.id, eventId: other.id, source: "event_code" });
  const bob = await participant(h, "bob@example.com");
  await h.db.addEventMember({ userId: bob.id, eventId: other.id, source: "event_code" });
  // Opted in, and tagged, at both events.
  await optIn(h, alice, "Alice Rossi");
  const photoA = await seedPhoto(h, bob.id);
  const photoB = await seedPhotoIn(h, other.id, bob.id);
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/events/${h.event.slug}/tags`, { photoId: photoA, userId: alice.id }, { cookie: bob.cookie }),
      )
    ).status,
    201,
  );
  const outIn = await h.app.request(
    json(
      "PUT",
      `/v1/events/${other.slug}/tags/me`,
      { taggable: true, displayName: "Alice Rossi", consentTextVersion: TAG_CONSENT_TEXT_VERSION },
      { cookie: alice.cookie },
    ),
  );
  assert.equal(outIn.status, 200);
  assert.equal(
    (
      await h.app.request(
        json("POST", `/v1/events/${other.slug}/tags`, { photoId: photoB, userId: alice.id }, { cookie: bob.cookie }),
      )
    ).status,
    201,
  );

  // Opting out of event B cascades over event B only.
  const out = await h.app.request(
    json("PUT", `/v1/events/${other.slug}/tags/me`, { taggable: false }, { cookie: alice.cookie }),
  );
  assert.equal(out.status, 200);
  assert.equal((await h.db.findPhotoTag(photoB, alice.id))?.state, "removed");
  assert.equal(
    (await h.db.findPhotoTag(photoA, alice.id))?.state,
    "active",
    "a withdrawal at event B must not reach into event A",
  );
  assert.equal((await h.db.findTagProfile(alice.id, h.event.id))?.taggable, true);
});

test("a participant who is not a member of the event cannot opt in or search", async () => {
  const h = await harness();
  // No `event_members` row: nobody claimed a code, nobody consented, no allowlist entry.
  const stray = await participant(h, "stray@example.com", { member: false });
  const path = `/v1/events/${h.event.slug}/tags/me`;
  const optIn = await h.app.request(
    json(
      "PUT",
      path,
      { taggable: true, displayName: "Stray", consentTextVersion: TAG_CONSENT_TEXT_VERSION },
      { cookie: stray.cookie },
    ),
  );
  assert.equal(optIn.status, 403);
  assert.equal(await h.db.findTagProfile(stray.id, h.event.id), null);
  // Opting out is refused for the same reason: there is nothing to withdraw.
  assert.equal(
    (await h.app.request(json("PUT", path, { taggable: false }, { cookie: stray.cookie }))).status,
    403,
  );
  assert.equal(
    (await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, stray.cookie))).status,
    403,
  );
  // Reading their own (empty) tag area still works: that must never depend on a gate.
  const mine = await h.app.request(get(`/v1/events/${h.event.slug}/tags/me`, stray.cookie));
  assert.equal(mine.status, 200);
  const body = tagsMeResponseSchema.parse(await mine.json());
  assert.equal(body.profile.taggable, false);
  assert.deepEqual(body.items, []);
});

test("registering with an event code records the non-biometric membership", async () => {
  const h = await harness();
  await h.db.createEventCode({ eventId: h.event.id, code: "BADGE-1" });
  const response = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "nuovo@example.com",
      password: "unapasswordlunga",
      eventCode: "BADGE-1",
    }),
  );
  assert.equal(response.status, 201, await response.text());
  const user = await h.db.findUserByEmailRole("nuovo@example.com", "participant");
  assert.ok(user);
  const member = await h.db.findEventMember(user.id, h.event.id);
  assert.ok(member, "the claimed code's event is persisted, not only audited");
  assert.equal(member.source, "event_code");
  // Membership is not taggability: registering makes nobody findable.
  assert.equal(member.taggable, false);
  assert.equal(member.taggableConsentVersion, null);
  assert.equal(await h.db.hasActiveConsent(user.id, h.event.id), false);
});

// ---- the autocomplete must not become a directory of the event ---------------------------
//
// One test per rule. With 6 000 participants, relaxing any single one of these publishes a
// searchable roster of everyone present.

test("the autocomplete returns nothing for an empty, 1-character or 2-character query", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice R.");
  const base = `/v1/events/${h.event.slug}/tags/search`;

  // Not "an empty list": a 400. An empty list is the kind of answer a later refactor
  // "fixes" into a full one.
  for (const query of ["", "?q=", "?q=a", "?q=al", "?q=%20%20", "?q=a%20"]) {
    const response = await h.app.request(get(`${base}${query}`, bob.cookie));
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(query)}`);
    const text = await response.text();
    // Whatever the body is, it must not contain a display name or an e-mail.
    assert.ok(!text.includes("Alice"), `leaked a display name for ${JSON.stringify(query)}`);
    assert.ok(!text.includes("alice@example.com"), `leaked an e-mail for ${JSON.stringify(query)}`);
  }
  // Three characters do work, so the minimum is a floor and not a broken endpoint.
  const ok = await h.app.request(get(`${base}?q=ali`, bob.cookie));
  assert.equal(ok.status, 200);
  assert.equal(tagSearchResponseSchema.parse(await ok.json()).items.length, 1);
});

test("the autocomplete never returns a non-taggable user", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const optedIn = await participant(h, "alice@example.com");
  const optedOut = await participant(h, "alida@example.com");
  await optIn(h, optedIn, "Alice Rossi");
  await optIn(h, optedOut, "Alida Bianchi");
  // Alida changes her mind.
  const out = await h.app.request(
    json("PUT", `/v1/events/${h.event.slug}/tags/me`, { taggable: false }, { cookie: optedOut.cookie }),
  );
  assert.equal(out.status, 200);

  const response = await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, bob.cookie));
  const body = tagSearchResponseSchema.parse(await response.json());
  assert.deepEqual(
    body.items.map((row) => row.displayName),
    ["Alice Rossi"],
  );
  assert.equal(body.items[0]?.userId, optedIn.id);
});

test("the autocomplete returns display names only, never e-mail addresses", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");

  const response = await h.app.request(get(`/v1/events/${h.event.slug}/tags/search?q=ali`, bob.cookie));
  const raw = await response.text();
  assert.ok(!raw.includes("alice@example.com"), raw);
  assert.ok(!raw.includes("@"), raw);
  // `.strict()`: a future `email` (or any other) field on the row fails the parse here.
  const body = tagSearchResponseSchema.parse(JSON.parse(raw));
  assert.deepEqual(body.items, [{ userId: alice.id, displayName: "Alice Rossi" }]);
  assert.deepEqual(Object.keys(body.items[0] ?? {}).sort(), ["displayName", "userId"]);
});

test("the autocomplete matches a prefix only, so the roster cannot be walked", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const base = `/v1/events/${h.event.slug}/tags/search`;

  const prefix = tagSearchResponseSchema.parse(
    await (await h.app.request(get(`${base}?q=Ali`, bob.cookie))).json(),
  );
  assert.equal(prefix.items.length, 1, "a prefix match works, case-insensitively");
  // A substring of the middle or the end finds nothing: you have to know how the name starts.
  for (const query of ["ice", "oss", "ssi", "lic"]) {
    const body = tagSearchResponseSchema.parse(
      await (await h.app.request(get(`${base}?q=${query}`, bob.cookie))).json(),
    );
    assert.deepEqual(body.items, [], `substring ${query} must not match`);
  }
  // And a LIKE wildcard is escaped, not interpreted: `%` is three characters of nothing.
  for (const query of ["%25%25%25", "___", "%25al"]) {
    const body = tagSearchResponseSchema.parse(
      await (await h.app.request(get(`${base}?q=${query}`, bob.cookie))).json(),
    );
    assert.deepEqual(body.items, [], `wildcard ${query} must not match`);
  }
});

test("the autocomplete is rate limited per session", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const path = `/v1/events/${h.event.slug}/tags/search?q=ali`;
  for (let index = 0; index < TAG_SEARCH_RATE_LIMIT.max; index += 1) {
    assert.equal((await h.app.request(get(path, bob.cookie))).status, 200, `call ${index}`);
  }
  const blocked = await h.app.request(get(path, bob.cookie));
  assert.equal(blocked.status, 429);
  // A second session of the SAME account shares the budget: opening a tab buys nothing.
  const sameUser = await sessionCookie(h.db, bob.id);
  assert.equal((await h.app.request(get(path, sameUser))).status, 429);
  // A different participant has their own budget.
  const carol = await participant(h, "carol@example.com");
  assert.equal((await h.app.request(get(path, carol.cookie))).status, 200);
});

test("the autocomplete is closed to anonymous callers and to staff", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const path = `/v1/events/${h.event.slug}/tags/search?q=ali`;
  assert.equal((await h.app.request(get(path))).status, 401);

  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  assert.equal((await h.app.request(get(path, await sessionCookie(h.db, admin.id)))).status, 403);
});

test("the autocomplete still honours the participant allowlist when access = list", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const outsider = await participant(h, "outsider@example.com");
  // The event-membership gate that survives: who belongs at the event, not who consented to
  // face recognition.
  await h.db.updateEvent(h.event.id, { access: "list" });
  await h.db.upsertEventParticipants(h.event.id, ["alice@example.com"]);
  const path = `/v1/events/${h.event.slug}/tags/search?q=ali`;
  assert.equal((await h.app.request(get(path, outsider.cookie))).status, 403);
  assert.equal((await h.app.request(get(path, alice.cookie))).status, 200);
});

// ---- tagging, removal and the audit trail ------------------------------------------------

test("a tag notifies the tagged person and writes an audit row", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  await giveGallery(h, bob.id, [photoId]);

  const created = await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
  );
  assert.equal(created.status, 201, await created.text());
  assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "active");

  const audit = await h.db.listAuditForTarget(`photo:${photoId}`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, "photo.tagged");
  assert.equal(audit[0]?.actorId, bob.id);
  assert.deepEqual(audit[0]?.meta, { eventId: h.event.id, userId: alice.id, taggedBy: bob.id });

  // The notification: an `email` job of kind `tagged` for the tagged person, not the tagger.
  const job = await h.db.claimJob();
  assert.equal(job?.type, "email");
  assert.deepEqual(job?.payload, {
    userId: alice.id,
    eventId: h.event.id,
    galleryPath: "/tag",
    kind: "tagged",
  });

  // And she sees the photo in her own tag area.
  const mine = tagsMeResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/me`, alice.cookie))).json(),
  );
  assert.deepEqual(mine.items.map((row) => row.photoId), [photoId]);
});

test("the tagged person removes their own tag, and the tagger cannot re-add it", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  await giveGallery(h, bob.id, [photoId]);
  const path = `/v1/events/${h.event.slug}/tags`;
  assert.equal(
    (await h.app.request(json("POST", path, { photoId, userId: alice.id }, { cookie: bob.cookie }))).status,
    201,
  );

  // The tagger cannot remove it — a tag is an assertion about someone else.
  assert.equal((await h.app.request(del(`${path}/${photoId}`, bob.cookie))).status, 404);
  assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "active");

  const removed = await h.app.request(del(`${path}/${photoId}`, alice.cookie));
  assert.equal(removed.status, 200);
  // Removal reuses the `not_me` feedback flow: the same row the gallery's button writes.
  assert.deepEqual(await removed.json(), { photoId, verdict: "not_me" });
  assert.deepEqual(await h.db.listFeedback(alice.id, h.event.id, [photoId]), [
    { photoId, verdict: "not_me" },
  ]);
  assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "removed");

  // The removal is terminal: the tagger's second attempt is a 409, not a silent re-create.
  const again = await h.app.request(json("POST", path, { photoId, userId: alice.id }, { cookie: bob.cookie }));
  assert.equal(again.status, 409);
  assert.equal((await h.db.findPhotoTag(photoId, alice.id))?.state, "removed");
  // A third party cannot re-create it either.
  const carol = await participant(h, "carol@example.com");
  await giveGallery(h, carol.id, [photoId]);
  assert.equal(
    (await h.app.request(json("POST", path, { photoId, userId: alice.id }, { cookie: carol.cookie }))).status,
    409,
  );

  // Removing twice is a 404, and the photo is gone from her tag area.
  assert.equal((await h.app.request(del(`${path}/${photoId}`, alice.cookie))).status, 404);
  const mine = tagsMeResponseSchema.parse(
    await (await h.app.request(get(`/v1/events/${h.event.slug}/tags/me`, alice.cookie))).json(),
  );
  assert.deepEqual(mine.items, []);
});

test("every tag and every untag is audited", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  await giveGallery(h, bob.id, [photoId]);
  const path = `/v1/events/${h.event.slug}/tags`;
  await h.app.request(json("POST", path, { photoId, userId: alice.id }, { cookie: bob.cookie }));
  await h.app.request(del(`${path}/${photoId}`, alice.cookie));

  const rows = await h.db.listAuditForTarget(`photo:${photoId}`);
  assert.deepEqual(rows.map((row) => row.action), ["photo.tagged", "photo.untagged"]);
  assert.equal(rows[0]?.actorId, bob.id, "the tag is attributed to the tagger");
  assert.equal(rows[1]?.actorId, alice.id, "the untag is attributed to the tagged person");
  assert.deepEqual(rows[1]?.meta, { eventId: h.event.id, userId: alice.id, reason: "not_me" });
});

test("a participant cannot tag on a photo they cannot see", async () => {
  const h = await harness();
  const stranger = await participant(h, "stranger@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  const path = `/v1/events/${h.event.slug}/tags`;

  // Not the uploader, and the photo is not in their gallery.
  assert.equal(
    (await h.app.request(json("POST", path, { photoId, userId: alice.id }, { cookie: stranger.cookie }))).status,
    403,
  );
  assert.equal(await h.db.findPhotoTag(photoId, alice.id), null);
  // The tag list of that photo is closed to them too.
  assert.equal(
    (await h.app.request(get(`/v1/events/${h.event.slug}/photos/${photoId}/tags`, stranger.cookie))).status,
    403,
  );
  // An unknown photo id is a 404, and a malformed one a 400.
  assert.equal(
    (await h.app.request(json("POST", path, { photoId: randomUUID(), userId: alice.id }, { cookie: stranger.cookie }))).status,
    404,
  );
  assert.equal((await h.app.request(get(`/v1/events/${h.event.slug}/photos/not-a-uuid/tags`, stranger.cookie))).status, 400);
});

test("the tag list of a photo carries display names, never e-mail addresses", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  await giveGallery(h, bob.id, [photoId]);
  await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId, userId: alice.id }, { cookie: bob.cookie }),
  );

  const response = await h.app.request(get(`/v1/events/${h.event.slug}/photos/${photoId}/tags`, bob.cookie));
  const raw = await response.text();
  assert.ok(!raw.includes("@"), raw);
  const body = photoTagsResponseSchema.parse(JSON.parse(raw));
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.displayName, "Alice Rossi");
});

test("tagging is closed to anonymous callers and to staff", async () => {
  const h = await harness();
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const photoId = await seedPhoto(h);
  const slug = h.event.slug;
  const admin = await h.db.findUserByEmailRole("admin@rephoto.local", "admin");
  assert.ok(admin);
  const adminCookie = await sessionCookie(h.db, admin.id);

  const calls: Array<[string, string, unknown?]> = [
    ["GET", `/v1/events/${slug}/tags/me`],
    ["PUT", `/v1/events/${slug}/tags/me`, { taggable: true, displayName: "Admin" }],
    ["GET", `/v1/events/${slug}/tags/search?q=ali`],
    ["POST", `/v1/events/${slug}/tags`, { photoId, userId: alice.id }],
    ["DELETE", `/v1/events/${slug}/tags/${photoId}`],
    ["GET", `/v1/events/${slug}/photos/${photoId}/tags`],
  ];
  for (const [method, path, body] of calls) {
    const make = (headers: Record<string, string>) =>
      body === undefined
        ? new Request(`http://api.local${path}`, { method, headers })
        : json(method, path, body, headers);
    assert.equal((await h.app.request(make({}))).status, 401, `${method} ${path} anon`);
    assert.equal((await h.app.request(make({ cookie: adminCookie }))).status, 403, `${method} ${path} admin`);
  }
});

// ---- the personal match galleries must behave exactly as before ---------------------------

test("tagging leaves the personal match gallery untouched", async () => {
  const h = await harness();
  const bob = await participant(h, "bob@example.com");
  const alice = await participant(h, "alice@example.com");
  await optIn(h, alice, "Alice Rossi");
  const tagged = await seedPhoto(h);
  const own = await seedPhoto(h);
  await giveGallery(h, bob.id, [tagged, own]);
  await giveGallery(h, alice.id, [own]);
  const before = await h.db.listGallery(alice.id, h.event.id);

  await h.app.request(
    json("POST", `/v1/events/${h.event.slug}/tags`, { photoId: tagged, userId: alice.id }, { cookie: bob.cookie }),
  );
  // A tag is NOT a gallery item: being tagged does not inject a photo into the match gallery.
  assert.deepEqual(await h.db.listGallery(alice.id, h.event.id), before);
  const gallery = await h.app.request(get(`/v1/events/${h.event.slug}/gallery?limit=60`, alice.cookie));
  assert.equal(gallery.status, 200);
  const body = (await gallery.json()) as { total: number; items: Array<{ photoId: string }> };
  assert.equal(body.total, 1);
  assert.deepEqual(body.items.map((row) => row.photoId), [own]);
});
