import { OAUTH_STATE_TTL_SECONDS, type Env } from "@rephoto/contracts";
import { randomBase64Url, sha256Base64Url, timingSafeEqualText } from "./crypto.js";
import {
  decodeIdToken,
  OauthError,
  signState,
  type GoogleClaims,
  type GoogleConfig,
  type GoogleTokenExchange,
  type OauthStatePayload,
  type StartedFlow,
  verifiedEmail,
  verifyCallbackState,
  verifyState,
} from "./oauth.js";

const TOKEN_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 120;

export type StaffOidcConfig = GoogleConfig & {
  authorizeUrl: string;
  tokenUrl: string;
  issuers: string[];
};

export function staffOidcConfig(env: Env): StaffOidcConfig | null {
  if (
    !env.STAFF_OIDC_AUTHORIZE_URL ||
    !env.STAFF_OIDC_TOKEN_URL ||
    !env.STAFF_OIDC_CLIENT_ID ||
    !env.STAFF_OIDC_CLIENT_SECRET ||
    !env.STAFF_OIDC_REDIRECT_URL
  ) {
    return null;
  }
  const issuers = env.STAFF_OIDC_ISSUERS.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    authorizeUrl: env.STAFF_OIDC_AUTHORIZE_URL,
    tokenUrl: env.STAFF_OIDC_TOKEN_URL,
    clientId: env.STAFF_OIDC_CLIENT_ID,
    clientSecret: env.STAFF_OIDC_CLIENT_SECRET,
    redirectUrl: env.STAFF_OIDC_REDIRECT_URL,
    stateSecret: env.OAUTH_STATE_SECRET,
    issuers: issuers.length > 0 ? issuers : [],
  };
}

export function startStaffFlow(config: StaffOidcConfig, now: number = Date.now()): StartedFlow {
  const payload: OauthStatePayload = {
    state: randomBase64Url(),
    verifier: randomBase64Url(),
    nonce: randomBase64Url(16),
    iat: Math.floor(now / 1000),
  };
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", payload.state);
  url.searchParams.set("nonce", payload.nonce);
  url.searchParams.set("code_challenge", sha256Base64Url(payload.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authorizeUrl: url.toString(),
    cookie: signState(config.stateSecret, payload),
    state: payload.state,
  };
}

export function createStaffTokenExchange(config: StaffOidcConfig): GoogleTokenExchange {
  return async ({ code, codeVerifier }) => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl,
    });
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) throw new OauthError(`token endpoint ${response.status}`);
    const parsed = (await response.json()) as { id_token?: string };
    if (!parsed.id_token) throw new OauthError("token endpoint returned no id_token");
    return { idToken: parsed.id_token };
  };
}

export function assertStaffClaims(
  claims: GoogleClaims,
  input: { config: StaffOidcConfig; nonce: string; now?: number },
): void {
  const now = input.now ?? Date.now();
  if (input.config.issuers.length > 0) {
    if (!claims.iss || !input.config.issuers.includes(claims.iss)) {
      throw new OauthError("unexpected issuer");
    }
  }
  if (claims.aud !== input.config.clientId) throw new OauthError("unexpected audience");
  if (claims.exp === null || claims.exp * 1000 + CLOCK_SKEW_SECONDS * 1000 < now) {
    throw new OauthError("expired id_token");
  }
  if (!claims.nonce || !timingSafeEqualText(claims.nonce, input.nonce)) {
    throw new OauthError("nonce mismatch");
  }
}

export {
  decodeIdToken,
  verifiedEmail,
  verifyCallbackState,
  verifyState,
  OauthError,
  OAUTH_STATE_TTL_SECONDS,
};
