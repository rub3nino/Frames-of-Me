/**
 * v6 hardening H1 (agent H): the password-reset token is not a magic link.
 *
 * The regression these tests exist for: agent B's reset flow minted and consumed rows of
 * `magic_links`, so *any* login link — one mailed by `/v1/auth/request-link`, one minted in
 * the admin console and shown as a QR on a screen — could be posted to
 * `/v1/auth/password-reset/confirm` and would set the account's password. A short-lived
 * session became a permanent take-over.
 *
 * `apps/api/test/v6-auth.test.ts` is deliberately untouched: its "magic-link login still
 * works end to end" test is the other half of the contract.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { envSchema, SESSION_COOKIE_NAME, type Env } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
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

/** Nothing here touches the object store. */
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
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
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

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (!pair) continue;
    const index = pair.indexOf("=");
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1);
  }
  return null;
}

function tokenFromMail(text: string, param = "token"): string {
  const url = new URL(text.trim());
  const value = url.searchParams.get(param);
  assert.ok(value, `missing ?${param} in ${text}`);
  return value;
}

const PASSWORD = "password-lunga-ok";
const EMAIL = "indurito@example.com";

/** A registered participant with a known password, through the real registration route. */
async function participant(h: Harness, email = EMAIL): Promise<{ id: string }> {
  await h.db.createEventCode({ eventId: h.event.id, code: "BADGE-2026", maxUses: 100 });
  const registered = await h.app.request(
    json("POST", "/v1/auth/register", { email, password: PASSWORD, eventCode: "BADGE-2026" }),
  );
  assert.equal(registered.status, 201);
  const { user } = (await registered.json()) as { user: { id: string } };
  return user;
}

async function login(h: Harness, email: string, password: string): Promise<number> {
  const response = await h.app.request(
    json("POST", "/v1/auth/login", { email, password, role: "participant" }),
  );
  return response.status;
}

async function askReset(h: Harness, email = EMAIL, ip?: string): Promise<Response> {
  return h.app.request(
    json("POST", "/v1/auth/password-reset", { email }, ip ? { "x-forwarded-for": ip } : {}),
  );
}

/** The most recent reset link's token. */
function resetToken(h: Harness): string {
  const mail = h.mailer.sent.at(-1);
  assert.ok(mail);
  assert.ok(mail.text.startsWith("http://localhost:3000/registrati?reset="));
  return tokenFromMail(mail.text, "reset");
}

// ---- the fix: a login token cannot set a password -------------------------------------------

test("a mailed magic link cannot set a password", async () => {
  const h = await harness();
  const user = await participant(h);

  // The event-day fallback, used by this very account: a login link arrives by mail.
  const requested = await h.app.request(
    json("POST", "/v1/auth/request-link", { email: EMAIL, role: "participant" }),
  );
  assert.equal(requested.status, 202);
  const magicToken = tokenFromMail(h.mailer.sent.at(-1)!.text);

  // Before the fix this answered 200 and the account was gone.
  const stolen = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: magicToken,
      password: "password-del-ladro",
    }),
  );
  assert.equal(stolen.status, 400);
  assert.equal(cookieValue(stolen, SESSION_COOKIE_NAME), null);
  assert.equal(await login(h, EMAIL, "password-del-ladro"), 401);
  assert.equal(await login(h, EMAIL, PASSWORD), 200);

  // And the link is still a perfectly good login link: nothing was consumed.
  const verified = await h.app.request(json("POST", "/v1/auth/verify", { token: magicToken }));
  assert.equal(verified.status, 200);
  assert.ok(cookieValue(verified, SESSION_COOKIE_NAME));
  const body = (await verified.json()) as { user: { id: string } };
  assert.equal(body.user.id, user.id);
});

test("an admin-minted magic link cannot set a password either", async () => {
  const h = await harness();
  await participant(h);
  // `POST /v1/admin/magic-links` writes exactly this row and shows the token as a QR on a
  // screen: the widest-distributed login token there is.
  const token = "token-dalla-consolle-admin";
  await h.db.insertMagicLink({
    email: EMAIL,
    role: "participant",
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    ip: null,
  });
  const stolen = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", { token, password: "password-del-ladro" }),
  );
  assert.equal(stolen.status, 400);
  assert.equal(await login(h, EMAIL, PASSWORD), 200);
});

test("a reset token is not a login link: /v1/auth/verify refuses it", async () => {
  const h = await harness();
  await participant(h);
  assert.equal((await askReset(h)).status, 202);
  const refused = await h.app.request(
    json("POST", "/v1/auth/verify", { token: resetToken(h) }),
  );
  assert.equal(refused.status, 400);
  assert.equal(cookieValue(refused, SESSION_COOKIE_NAME), null);
});

// ---- the reset token's own lifecycle --------------------------------------------------------

test("the reset token works once, and the password change burns the others", async () => {
  const h = await harness();
  const user = await participant(h);
  assert.equal((await askReset(h)).status, 202);
  const first = resetToken(h);
  assert.equal((await askReset(h)).status, 202);
  const second = resetToken(h);
  assert.notEqual(first, second);

  const confirmed = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: second,
      password: "nuova-password-lunga",
    }),
  );
  assert.equal(confirmed.status, 200);
  assert.ok(cookieValue(confirmed, SESSION_COOKIE_NAME));
  assert.notEqual(await h.db.findEmailVerifiedAt(user.id), null);
  assert.equal(await login(h, EMAIL, "nuova-password-lunga"), 200);
  assert.equal(await login(h, EMAIL, PASSWORD), 401);

  // Replay of the one just used.
  const replay = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: second,
      password: "terza-password-lunga",
    }),
  );
  assert.equal(replay.status, 400);
  // And the still-unused one issued before the password changed: a reset link mailed to an
  // address the attacker controls must not outlive the password it was meant to replace.
  const stale = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: first,
      password: "quarta-password-lunga",
    }),
  );
  assert.equal(stale.status, 400);
  assert.equal(await login(h, EMAIL, "nuova-password-lunga"), 200);
});

test("an expired reset token is refused", async () => {
  const h = await harness();
  const user = await participant(h);
  const token = "token-scaduto-per-il-test";
  await h.db.insertPasswordResetToken({
    userId: user.id,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() - 1000),
    ip: null,
  });
  const expired = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", { token, password: "nuova-password-lunga" }),
  );
  assert.equal(expired.status, 400);
  assert.equal(await login(h, EMAIL, PASSWORD), 200);
});

// ---- the reset budget is its own ------------------------------------------------------------

test("resets are rate limited on their own table, without touching the magic-link budget", async () => {
  // Two resets per account per hour; the login-link budget stays at its default of three.
  const limited: Env = envSchema.parse({ ...baseEnv, PASSWORD_RESET_PER_USER: "2" });
  const h = await harness({ env: limited });
  await participant(h);

  assert.equal((await askReset(h)).status, 202);
  assert.equal((await askReset(h)).status, 202);
  const third = await askReset(h);
  assert.equal(third.status, 429);
  assert.equal(h.mailer.sent.filter((mail) => mail.text.includes("reset=")).length, 2);

  // The event-day fallback is unaffected: before the fix the two flows shared one budget,
  // so three resets left a participant unable to ask for a login link at all.
  const requested = await h.app.request(
    json("POST", "/v1/auth/request-link", { email: EMAIL, role: "participant" }),
  );
  assert.equal(requested.status, 202);
  assert.ok(h.mailer.sent.at(-1)!.text.startsWith("http://localhost:3000/verifica?token="));
});

test("an unknown address is still answered 202 with no mail, and burns no account budget", async () => {
  const h = await harness();
  const unknown = await askReset(h, "mai-visto@example.com");
  assert.equal(unknown.status, 202);
  assert.equal(h.mailer.sent.length, 0);
});
