import { OAUTH_STATE_TTL_SECONDS, type Env } from "@rephoto/contracts";
import {
  hmacSha256,
  randomBase64Url,
  sha256Base64Url,
  timingSafeEqualText,
} from "./crypto.js";

/**
 * Google OIDC, authorization code + PKCE (v6, agent B).
 *
 * Nothing here reaches the network except `createGoogleTokenExchange`, which is the single
 * injectable seam: `AppDeps.googleTokenExchange`. The tests pass a fake exchange, so the
 * whole state/PKCE/claims path is covered without a live Google round-trip.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
const TOKEN_TIMEOUT_MS = 10_000;
/** Tolerance for a clock skew between us and Google when checking `exp`. */
const CLOCK_SKEW_SECONDS = 120;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  stateSecret: string;
};

/** Null when the deployment has no Google client configured: the routes then answer 404. */
export function googleConfig(env: Env): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URL) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUrl: env.GOOGLE_REDIRECT_URL,
    stateSecret: env.OAUTH_STATE_SECRET,
  };
}

export type TokenExchangeInput = {
  code: string;
  codeVerifier: string;
  config: GoogleConfig;
};

/** What we need back from the token endpoint. Access and refresh tokens are not kept. */
export type TokenExchangeResult = { idToken: string };

/** The seam: replaced by a fake in the tests. */
export type GoogleTokenExchange = (input: TokenExchangeInput) => Promise<TokenExchangeResult>;

export class OauthError extends Error {
  constructor(readonly reason: string) {
    super(`oauth: ${reason}`);
    this.name = "OauthError";
  }
}

// ---- state + PKCE ---------------------------------------------------------------------------

export type OauthStatePayload = {
  /** Opaque anti-CSRF value, echoed by Google in `?state=` and compared with the cookie. */
  state: string;
  /** PKCE code_verifier; only its S256 hash left the server. */
  verifier: string;
  /** OIDC nonce, compared with the `nonce` claim of the id_token. */
  nonce: string;
  /** Issued-at, seconds. The payload expires after OAUTH_STATE_TTL_SECONDS. */
  iat: number;
};

export type StartedFlow = {
  /** Where the browser is sent. */
  authorizeUrl: string;
  /** Value of the short-lived signed cookie. */
  cookie: string;
  state: string;
};

function encodePayload(payload: OauthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(raw: string): OauthStatePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.verifier !== "string" ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.iat !== "number"
  ) {
    return null;
  }
  return {
    state: candidate.state,
    verifier: candidate.verifier,
    nonce: candidate.nonce,
    iat: candidate.iat,
  };
}

/** `<base64url payload>.<hmac>`; the cookie is httpOnly, so the payload is never read by JS. */
export function signState(secret: string, payload: OauthStatePayload): string {
  const body = encodePayload(payload);
  return `${body}.${hmacSha256(secret, body)}`;
}

/** Null for a tampered signature, a malformed payload or an expired one. */
export function verifyState(
  secret: string,
  cookie: string,
  now: number = Date.now(),
): OauthStatePayload | null {
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  if (!timingSafeEqualText(signature, hmacSha256(secret, body))) return null;
  const payload = decodePayload(body);
  if (!payload) return null;
  const age = now / 1000 - payload.iat;
  if (age < -CLOCK_SKEW_SECONDS || age > OAUTH_STATE_TTL_SECONDS) return null;
  return payload;
}

export function startGoogleFlow(config: GoogleConfig, now: number = Date.now()): StartedFlow {
  const payload: OauthStatePayload = {
    state: randomBase64Url(),
    verifier: randomBase64Url(),
    nonce: randomBase64Url(16),
    iat: Math.floor(now / 1000),
  };
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", payload.state);
  url.searchParams.set("nonce", payload.nonce);
  url.searchParams.set("code_challenge", sha256Base64Url(payload.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // No refresh token is wanted: one sign-in, then our own session cookie.
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return { authorizeUrl: url.toString(), cookie: signState(config.stateSecret, payload), state: payload.state };
}

/**
 * The callback half of the round-trip: the cookie must verify, and the `state` echoed by
 * Google must equal the one inside it. A missing or tampered state ends here.
 */
export function verifyCallbackState(
  config: GoogleConfig,
  input: { cookie: string | undefined; state: string | undefined },
  now: number = Date.now(),
): OauthStatePayload {
  if (!input.cookie) throw new OauthError("missing state cookie");
  if (!input.state) throw new OauthError("missing state parameter");
  const payload = verifyState(config.stateSecret, input.cookie, now);
  if (!payload) throw new OauthError("invalid state cookie");
  if (!timingSafeEqualText(input.state, payload.state)) throw new OauthError("state mismatch");
  return payload;
}

// ---- id_token -------------------------------------------------------------------------------

export type GoogleClaims = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  nonce: string | null;
  aud: string | null;
  iss: string | null;
  exp: number | null;
};

/**
 * Reads the payload of a JWT **without verifying its signature**.
 *
 * That is sound only because the token is fetched by us, over TLS, straight from Google's
 * token endpoint in exchange for a code bound to our PKCE verifier (OIDC Core 3.1.3.7,
 * point 6: signature validation MAY be skipped for a token received directly from the
 * token endpoint). Never call this on a token that arrived from a browser.
 */
export function decodeIdToken(idToken: string): GoogleClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new OauthError("malformed id_token");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new OauthError("malformed id_token payload");
  }
  if (!parsed || typeof parsed !== "object") throw new OauthError("malformed id_token payload");
  const claims = parsed as Record<string, unknown>;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new OauthError("id_token without sub");
  }
  // `email_verified` arrives as a boolean from Google and as the string "true" from some
  // OIDC proxies. Anything else counts as not verified.
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null;
  return {
    sub: claims.sub,
    email,
    emailVerified,
    nonce: typeof claims.nonce === "string" ? claims.nonce : null,
    aud: typeof claims.aud === "string" ? claims.aud : null,
    iss: typeof claims.iss === "string" ? claims.iss : null,
    exp: typeof claims.exp === "number" ? claims.exp : null,
  };
}

/** Throws OauthError unless issuer, audience, expiry and nonce all match. */
export function assertGoogleClaims(
  claims: GoogleClaims,
  input: { config: GoogleConfig; nonce: string; now?: number },
): void {
  const now = input.now ?? Date.now();
  if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss as (typeof GOOGLE_ISSUERS)[number])) {
    throw new OauthError("unexpected issuer");
  }
  if (claims.aud !== input.config.clientId) throw new OauthError("unexpected audience");
  if (claims.exp === null || claims.exp * 1000 + CLOCK_SKEW_SECONDS * 1000 < now) {
    throw new OauthError("expired id_token");
  }
  if (!claims.nonce || !timingSafeEqualText(claims.nonce, input.nonce)) {
    throw new OauthError("nonce mismatch");
  }
}

/**
 * The verified e-mail, lowercased, or null. **This is the only way the rest of the code is
 * allowed to learn the address**: an unverified `email` claim is dropped on the floor, so a
 * Google account with an unconfirmed address can never take over a RePhoto account.
 */
export function verifiedEmail(claims: GoogleClaims): string | null {
  if (!claims.emailVerified || !claims.email) return null;
  return claims.email.trim().toLowerCase();
}

// ---- the networked half ---------------------------------------------------------------------

/** The real token exchange. Replaced in tests; never exercised by `npm test`. */
export function createGoogleTokenExchange(): GoogleTokenExchange {
  return async ({ code, codeVerifier, config }) => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl,
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) throw new OauthError(`token endpoint ${response.status}`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new OauthError("token endpoint returned no json");
    }
    const idToken = (parsed as { id_token?: unknown } | null)?.id_token;
    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new OauthError("token endpoint returned no id_token");
    }
    return { idToken };
  };
}
