import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { envSchema, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, type Env } from "@rephoto/contracts";
import { MemoryDatabase } from "@rephoto/db";
import {
  FakeFaceEngine,
  MemoryFaceIndexStore,
} from "../../../packages/face-engine/src/fake.ts";
import { createApp } from "../src/app.ts";
import { sha256Base64Url } from "../src/crypto.ts";
import type { AppDeps } from "../src/deps.ts";
import type { Mailer, MailMessage } from "../src/mailer.ts";
import type {
  CompletedPart,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
  StreamedObject,
} from "../src/object-store.ts";
import type { TokenExchangeInput } from "../src/oauth.ts";
import { createQueue } from "../src/queue.ts";

/**
 * v6 (agent B): Google OIDC, participant self-registration and the magic-link fallback.
 *
 * No test here reaches the network. The single networked seam — the Google token endpoint —
 * is injected as `AppDeps.googleTokenExchange`, so state, PKCE, the nonce and every claim
 * check run against a fake that hands back an id_token we built ourselves.
 */

const GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";

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
const googleEnv: Env = envSchema.parse({
  ...baseEnv,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URL: "http://localhost:8787/v1/auth/google/callback",
  OAUTH_STATE_SECRET: "oauth-state-secret-value",
});

/** Auth never touches the object store; every method is a stub that records nothing. */
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
  /** What the fake token exchange was called with, in order. */
  exchanged: TokenExchangeInput[];
  /** The id_token the next exchange hands back. */
  setIdToken(token: string): void;
};

async function harness(overrides: Partial<AppDeps> = {}): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.seedDemo();
  const event = await db.findEventBySlug("demo");
  assert.ok(event);
  const mailer = new RecordingMailer();
  const exchanged: TokenExchangeInput[] = [];
  let idToken = "";
  const app = createApp({
    env,
    db,
    objects: new StubObjectStore(),
    mailer,
    queue: createQueue(db),
    faces: new FakeFaceEngine(new MemoryFaceIndexStore()),
    googleTokenExchange: async (input) => {
      exchanged.push(input);
      return { idToken };
    },
    ...overrides,
  });
  return {
    app,
    db,
    mailer,
    event: { id: event.id, slug: event.slug },
    exchanged,
    setIdToken(token) {
      idToken = token;
    },
  };
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

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://api.local${path}`, { method: "GET", headers });
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

/** An id_token as Google returns it: real base64url payload, signature never checked. */
function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature-not-verified`;
}

type StateCookie = { state: string; verifier: string; nonce: string; iat: number };

function readStateCookie(cookie: string): StateCookie {
  const body = cookie.slice(0, cookie.lastIndexOf("."));
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StateCookie;
}

type StartedFlow = { cookie: string; state: string; verifier: string; nonce: string; challenge: string };

async function startGoogle(h: Harness): Promise<StartedFlow> {
  const response = await h.app.request(get("/v1/auth/google/start"));
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const url = new URL(location);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_id"), GOOGLE_CLIENT_ID);
  const cookie = cookieValue(response, OAUTH_STATE_COOKIE_NAME);
  assert.ok(cookie);
  const payload = readStateCookie(cookie);
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  assert.ok(state && challenge);
  // The browser only ever sees the hash of the verifier.
  assert.equal(state, payload.state);
  assert.equal(challenge, sha256Base64Url(payload.verifier));
  assert.ok(!location.includes(payload.verifier));
  return { cookie, state, verifier: payload.verifier, nonce: payload.nonce, challenge };
}

function googleClaims(
  flow: StartedFlow,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    sub: "google-subject-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: flow.nonce,
    email: "ospite@example.com",
    email_verified: true,
    ...overrides,
  };
}

async function callback(
  h: Harness,
  flow: StartedFlow,
  options: { state?: string; cookie?: string | null; code?: string } = {},
): Promise<Response> {
  const state = options.state ?? flow.state;
  const cookie = options.cookie === null ? undefined : (options.cookie ?? flow.cookie);
  const code = options.code ?? "google-auth-code";
  const query = new URLSearchParams({ code, state, scope: "openid email", authuser: "0" });
  return h.app.request(
    get(
      `/v1/auth/google/callback?${query.toString()}`,
      cookie ? { cookie: `${OAUTH_STATE_COOKIE_NAME}=${cookie}` } : {},
    ),
  );
}

async function googleEventCode(h: Harness, code: string, overrides: Record<string, unknown> = {}) {
  return h.db.createEventCode({ eventId: h.event.id, code, ...overrides });
}

// ---- the non-negotiable: the magic link still works -----------------------------------------

test("magic-link login still works end to end and is no longer the only way in", async () => {
  const h = await harness();
  const requested = await h.app.request(
    json("POST", "/v1/auth/request-link", { email: "Fallback@Example.com", role: "participant" }),
  );
  assert.equal(requested.status, 202);
  const mail = h.mailer.sent[0];
  assert.ok(mail);
  assert.equal(mail.to, "fallback@example.com");
  assert.ok(mail.text.startsWith("http://localhost:3000/verifica?token="));

  const verified = await h.app.request(
    json("POST", "/v1/auth/verify", { token: tokenFromMail(mail.text) }),
  );
  assert.equal(verified.status, 200);
  const body = (await verified.json()) as { user: { id: string; email: string; role: string } };
  assert.equal(body.user.email, "fallback@example.com");
  assert.equal(body.user.role, "participant");
  const session = cookieValue(verified, SESSION_COOKIE_NAME);
  assert.ok(session);

  // The session the magic link minted opens a participant-only route.
  const gallery = await h.app.request(
    get(`/v1/events/${h.event.slug}/gallery`, {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
    }),
  );
  assert.equal(gallery.status, 200);
  // Clicking the link proves the address (v6 lazy verification).
  assert.notEqual(await h.db.findEmailVerifiedAt(body.user.id), null);
});

// ---- B3: credential registration gated by an event code -------------------------------------

test("register with a valid event code creates the participant, a session and no e-mail", async () => {
  const h = await harness();
  await googleEventCode(h, "BADGE-2026", { maxUses: 10 });
  const response = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "Nuova.Ospite@example.com",
      password: "dieci-caratteri-almeno",
      // lower case on the wire: the api normalises the code.
      eventCode: "badge-2026",
    }),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { user: { id: string; email: string; role: string } };
  assert.equal(body.user.email, "nuova.ospite@example.com");
  assert.equal(body.user.role, "participant");
  assert.ok(cookieValue(response, SESSION_COOKIE_NAME));

  // B3: registration sends nothing and leaves the address unverified.
  assert.equal(h.mailer.sent.length, 0);
  assert.equal(await h.db.findEmailVerifiedAt(body.user.id), null);
  const code = await h.db.findEventCode(h.event.id, "BADGE-2026");
  assert.equal(code?.uses, 1);

  // And the new credentials work on the login route.
  const login = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "nuova.ospite@example.com",
      password: "dieci-caratteri-almeno",
      role: "participant",
    }),
  );
  assert.equal(login.status, 200);
  assert.ok(cookieValue(login, SESSION_COOKIE_NAME));
  const wrong = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "nuova.ospite@example.com",
      password: "dieci-caratteri-sbagliati",
      role: "participant",
    }),
  );
  assert.equal(wrong.status, 401);
});

test("register refuses an exhausted, an expired and an absent event code", async () => {
  const h = await harness();
  await googleEventCode(h, "ONE-SHOT", { maxUses: 1 });
  await googleEventCode(h, "SCADUTO", {
    expiresAt: new Date(Date.now() - 60_000),
  });

  const first = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "a@example.com",
      password: "password-lunga-ok",
      eventCode: "ONE-SHOT",
    }),
  );
  assert.equal(first.status, 201);

  const exhausted = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "b@example.com",
      password: "password-lunga-ok",
      eventCode: "ONE-SHOT",
    }),
  );
  assert.equal(exhausted.status, 403);

  const expired = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "c@example.com",
      password: "password-lunga-ok",
      eventCode: "SCADUTO",
    }),
  );
  assert.equal(expired.status, 403);

  const absent = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "d@example.com",
      password: "password-lunga-ok",
      eventCode: "MAI-ESISTITO",
    }),
  );
  assert.equal(absent.status, 403);
  // No account was created by any of the three.
  assert.equal(await h.db.findUserByEmailRole("b@example.com", "participant"), null);
  assert.equal(await h.db.findUserByEmailRole("c@example.com", "participant"), null);
  assert.equal(await h.db.findUserByEmailRole("d@example.com", "participant"), null);
  // A missing code is rejected by the schema, not by the code check.
  const missing = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "e@example.com",
      password: "password-lunga-ok",
    }),
  );
  assert.equal(missing.status, 400);
});

test("register refuses a short password and never adopts an existing account", async () => {
  const h = await harness();
  await googleEventCode(h, "BADGE-2026");
  const short = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "corta@example.com",
      password: "nove-cara",
      eventCode: "BADGE-2026",
    }),
  );
  assert.equal(short.status, 400);
  // The code was not touched by a request the schema refused.
  assert.equal((await h.db.findEventCode(h.event.id, "BADGE-2026"))?.uses, 0);

  // An account created earlier by a magic link cannot be claimed with a new password.
  const existing = await h.db.insertUser("vecchia@example.com", "participant");
  const taken = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "vecchia@example.com",
      password: "password-lunga-ok",
      eventCode: "BADGE-2026",
    }),
  );
  assert.equal(taken.status, 409);
  assert.equal((await h.db.findEventCode(h.event.id, "BADGE-2026"))?.uses, 0);
  // Still no password on that row: the login route refuses it.
  const login = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "vecchia@example.com",
      password: "password-lunga-ok",
      role: "participant",
    }),
  );
  assert.equal(login.status, 401);
  assert.ok(existing.id);
});

test("register is rate limited per ip and per event code", async () => {
  const perIp = await harness({ env: envSchema.parse({ ...baseEnv, REGISTER_PER_IP: "2" }) });
  await googleEventCode(perIp, "LIMITE-IP");
  const ip = { "x-forwarded-for": "198.51.100.21" };
  for (const name of ["uno", "due"]) {
    const response = await perIp.app.request(
      json(
        "POST",
        "/v1/auth/register",
        { email: `${name}@example.com`, password: "password-lunga-ok", eventCode: "LIMITE-IP" },
        ip,
      ),
    );
    assert.equal(response.status, 201);
  }
  const blocked = await perIp.app.request(
    json(
      "POST",
      "/v1/auth/register",
      { email: "tre@example.com", password: "password-lunga-ok", eventCode: "LIMITE-IP" },
      ip,
    ),
  );
  assert.equal(blocked.status, 429);
  const otherIp = await perIp.app.request(
    json(
      "POST",
      "/v1/auth/register",
      { email: "tre@example.com", password: "password-lunga-ok", eventCode: "LIMITE-IP" },
      { "x-forwarded-for": "198.51.100.22" },
    ),
  );
  assert.equal(otherIp.status, 201);

  const perCode = await harness({
    env: envSchema.parse({ ...baseEnv, REGISTER_PER_CODE: "1" }),
  });
  await googleEventCode(perCode, "LIMITE-CODICE");
  await googleEventCode(perCode, "ALTRO-CODICE");
  const first = await perCode.app.request(
    json("POST", "/v1/auth/register", {
      email: "quattro@example.com",
      password: "password-lunga-ok",
      eventCode: "LIMITE-CODICE",
    }),
  );
  assert.equal(first.status, 201);
  const second = await perCode.app.request(
    json("POST", "/v1/auth/register", {
      email: "cinque@example.com",
      password: "password-lunga-ok",
      eventCode: "LIMITE-CODICE",
    }),
  );
  assert.equal(second.status, 429);
  const other = await perCode.app.request(
    json("POST", "/v1/auth/register", {
      email: "cinque@example.com",
      password: "password-lunga-ok",
      eventCode: "ALTRO-CODICE",
    }),
  );
  assert.equal(other.status, 201);
});

test("the password reset is the only e-mail a registered participant triggers", async () => {
  const h = await harness();
  await googleEventCode(h, "BADGE-2026");
  const registered = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "reset@example.com",
      password: "password-lunga-ok",
      eventCode: "BADGE-2026",
    }),
  );
  assert.equal(registered.status, 201);
  const { user } = (await registered.json()) as { user: { id: string } };
  assert.equal(h.mailer.sent.length, 0);

  // An unknown address gets the same 202 and no mail.
  const unknown = await h.app.request(
    json("POST", "/v1/auth/password-reset", { email: "mai-visto@example.com" }),
  );
  assert.equal(unknown.status, 202);
  assert.equal(h.mailer.sent.length, 0);

  const asked = await h.app.request(
    json("POST", "/v1/auth/password-reset", { email: "reset@example.com" }),
  );
  assert.equal(asked.status, 202);
  const mail = h.mailer.sent[0];
  assert.ok(mail);
  assert.ok(mail.text.startsWith("http://localhost:3000/registrati?reset="));

  const confirmed = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: tokenFromMail(mail.text, "reset"),
      password: "nuova-password-lunga",
    }),
  );
  assert.equal(confirmed.status, 200);
  assert.ok(cookieValue(confirmed, SESSION_COOKIE_NAME));
  // Clicking the link proved the address.
  assert.notEqual(await h.db.findEmailVerifiedAt(user.id), null);

  // The new password works, the old one does not, and the token is single use.
  const login = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "reset@example.com",
      password: "nuova-password-lunga",
      role: "participant",
    }),
  );
  assert.equal(login.status, 200);
  const old = await h.app.request(
    json("POST", "/v1/auth/login", {
      email: "reset@example.com",
      password: "password-lunga-ok",
      role: "participant",
    }),
  );
  assert.equal(old.status, 401);
  const replay = await h.app.request(
    json("POST", "/v1/auth/password-reset/confirm", {
      token: tokenFromMail(mail.text, "reset"),
      password: "terza-password-lunga",
    }),
  );
  assert.equal(replay.status, 400);
});

test("an event code is claimed in exactly one event, even when two events share the string", async () => {
  const h = await harness();
  const other = await h.db.createEvent({ slug: "secondo", name: "Secondo" });
  // Registration sends the code alone, while the primary key is (event_id, code).
  await h.db.createEventCode({ eventId: other.id, code: "DUE-EVENTI", maxUses: 1 });
  await h.db.createEventCode({ eventId: h.event.id, code: "DUE-EVENTI", maxUses: 1 });

  const first = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "sei@example.com",
      password: "password-lunga-ok",
      eventCode: "DUE-EVENTI",
    }),
  );
  assert.equal(first.status, 201);
  // Exactly one of the two rows moved: which one is the oldest valid row, and with equal
  // timestamps the event id breaks the tie — the point is that only one is charged.
  const afterFirst = await Promise.all([
    h.db.findEventCode(other.id, "DUE-EVENTI"),
    h.db.findEventCode(h.event.id, "DUE-EVENTI"),
  ]);
  assert.deepEqual(
    afterFirst.map((row) => row?.uses).sort(),
    [0, 1],
  );

  // The second registration falls through to the row the first one left alone.
  const second = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "sette@example.com",
      password: "password-lunga-ok",
      eventCode: "DUE-EVENTI",
    }),
  );
  assert.equal(second.status, 201);
  const afterSecond = await Promise.all([
    h.db.findEventCode(other.id, "DUE-EVENTI"),
    h.db.findEventCode(h.event.id, "DUE-EVENTI"),
  ]);
  assert.deepEqual(
    afterSecond.map((row) => row?.uses),
    [1, 1],
  );

  const third = await h.app.request(
    json("POST", "/v1/auth/register", {
      email: "otto@example.com",
      password: "password-lunga-ok",
      eventCode: "DUE-EVENTI",
    }),
  );
  assert.equal(third.status, 403);
});

// ---- B2: Google OIDC ------------------------------------------------------------------------

test("google start/callback round-trips state and PKCE and creates a participant", async () => {
  const h = await harness({ env: googleEnv });
  const flow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(flow)));
  const response = await callback(h, flow);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://localhost:3000/selfie");
  assert.ok(cookieValue(response, SESSION_COOKIE_NAME));

  // The exchange was handed the verifier whose S256 hash we sent to Google.
  assert.equal(h.exchanged.length, 1);
  assert.equal(h.exchanged[0]?.codeVerifier, flow.verifier);
  assert.equal(h.exchanged[0]?.code, "google-auth-code");
  assert.equal(sha256Base64Url(h.exchanged[0]?.codeVerifier ?? ""), flow.challenge);

  const user = await h.db.findUserByEmailRole("ospite@example.com", "participant");
  assert.ok(user);
  assert.equal(user.role, "participant");
  // A verified Google e-mail is a proof of the address.
  assert.notEqual(await h.db.findEmailVerifiedAt(user.id), null);
  // The identity row now points at that user.
  const linked = await h.db.findUserByIdentity("google", "google-subject-1");
  assert.equal(linked?.id, user.id);

  // The state cookie was consumed: it is cleared on the way out.
  const cleared = response.headers
    .getSetCookie()
    .some((header) => header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=;`));
  assert.ok(cleared);
});

test("google links to an existing participant and keeps the role of a linked identity", async () => {
  const h = await harness({ env: googleEnv });
  // The same address exists as a participant and as a photographer: unique (email, role).
  const participant = await h.db.insertUser("ospite@example.com", "participant");
  const photographer = await h.db.insertUser("ospite@example.com", "photographer");
  assert.notEqual(participant.id, photographer.id);

  const first = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(first)));
  const linkedResponse = await callback(h, first);
  assert.equal(linkedResponse.status, 302);
  // B2: Google resolves to the participant row, never to the photographer one.
  assert.equal(linkedResponse.headers.get("location"), "http://localhost:3000/selfie");
  assert.equal((await h.db.findUserByIdentity("google", "google-subject-1"))?.id, participant.id);

  // Signing in again reuses the identity row and creates nothing.
  const second = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(second)));
  const again = await callback(h, second);
  assert.equal(again.status, 302);
  assert.equal((await h.db.findUserByIdentity("google", "google-subject-1"))?.id, participant.id);

  // An identity that points at a photographer keeps that role on the next sign-in.
  await h.db.insertIdentity({
    userId: photographer.id,
    provider: "google",
    subject: "google-subject-staff",
    email: "ospite@example.com",
  });
  const staffFlow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(staffFlow, { sub: "google-subject-staff" })));
  const staff = await callback(h, staffFlow);
  assert.equal(staff.status, 302);
  assert.equal(staff.headers.get("location"), "http://localhost:3000/upload");
});

test("google never trusts an unverified email claim", async () => {
  const h = await harness({ env: googleEnv });
  const existing = await h.db.insertUser("ospite@example.com", "participant");

  const flow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(flow, { email_verified: false })));
  const refused = await callback(h, flow);
  assert.equal(refused.status, 400);
  assert.equal(cookieValue(refused, SESSION_COOKIE_NAME), null);
  // No link to the account that happens to carry the same address.
  assert.equal(await h.db.findUserByIdentity("google", "google-subject-1"), null);

  // Same for a token with no email claim at all.
  const second = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(second, { email: undefined, email_verified: undefined })));
  const noEmail = await callback(h, second);
  assert.equal(noEmail.status, 400);
  assert.equal(await h.db.findUserByIdentity("google", "google-subject-1"), null);

  // Once the address is verified the same subject links to the existing participant.
  const third = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(third)));
  const accepted = await callback(h, third);
  assert.equal(accepted.status, 302);
  assert.equal((await h.db.findUserByIdentity("google", "google-subject-1"))?.id, existing.id);
});

test("google refuses a tampered, missing or replayed state and a wrong nonce or audience", async () => {
  const h = await harness({ env: googleEnv });

  const tampered = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(tampered)));
  // The signature no longer matches the payload.
  const brokenCookie = `${tampered.cookie.slice(0, tampered.cookie.lastIndexOf(".") + 1)}AAAA`;
  assert.equal((await callback(h, tampered, { cookie: brokenCookie })).status, 400);
  // The state in the query does not match the one inside the cookie.
  assert.equal((await callback(h, tampered, { state: "state-di-un-altro" })).status, 400);
  // No cookie at all (a different browser, or a stripped cookie).
  assert.equal((await callback(h, tampered, { cookie: null })).status, 400);
  // The cookie of another flow, whose state belongs to another request.
  const other = await startGoogle(h);
  assert.equal((await callback(h, tampered, { cookie: other.cookie })).status, 400);
  // Nothing was exchanged for any of those.
  assert.equal(h.exchanged.length, 0);

  // A valid flow whose id_token carries someone else's nonce.
  const nonceFlow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(nonceFlow, { nonce: "nonce-di-un-altro" })));
  assert.equal((await callback(h, nonceFlow)).status, 400);

  // ... or another client's audience, or an expired token.
  const audFlow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(audFlow, { aud: "un-altro-client" })));
  assert.equal((await callback(h, audFlow)).status, 400);
  const expFlow = await startGoogle(h);
  h.setIdToken(
    idToken(googleClaims(expFlow, { exp: Math.floor(Date.now() / 1000) - 3600 })),
  );
  assert.equal((await callback(h, expFlow)).status, 400);
  const issFlow = await startGoogle(h);
  h.setIdToken(idToken(googleClaims(issFlow, { iss: "https://evil.example.com" })));
  assert.equal((await callback(h, issFlow)).status, 400);

  assert.equal(await h.db.findUserByIdentity("google", "google-subject-1"), null);

  // A missing code with a valid state is refused before any exchange.
  const codeless = await startGoogle(h);
  const response = await h.app.request(
    get(`/v1/auth/google/callback?state=${encodeURIComponent(codeless.state)}`, {
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${codeless.cookie}`,
    }),
  );
  assert.equal(response.status, 400);
});

test("google is a 404 when the deployment has no client configured", async () => {
  const h = await harness();
  assert.equal((await h.app.request(get("/v1/auth/google/start"))).status, 404);
  assert.equal(
    (await h.app.request(get("/v1/auth/google/callback?code=x&state=y"))).status,
    404,
  );
});

test("a refused consent screen comes back to the sign-in page", async () => {
  const h = await harness({ env: googleEnv });
  const response = await h.app.request(get("/v1/auth/google/callback?error=access_denied"));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://localhost:3000/?google=annullato");
});
