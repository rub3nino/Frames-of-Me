import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Password hashing for staff login. scrypt is a built-in, memory-hard KDF — no
 * extra dependency. Stored as `scrypt$<saltHex>$<hashHex>`.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Constant-time verify. Returns false for a null/empty/malformed stored hash. */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---- v6 (agent B): primitives for the signed OAuth state and PKCE -------------------------

/** base64url of an HMAC-SHA256. Used to sign the short-lived state/PKCE cookie. */
export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Constant-time comparison of two base64url/ASCII strings of any length. */
export function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on different lengths, so compare digests of equal size.
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

/** 32 random bytes, base64url: the PKCE verifier and the state nonce. */
export function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** base64url SHA-256 of the verifier: the PKCE `code_challenge` with method S256. */
export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
