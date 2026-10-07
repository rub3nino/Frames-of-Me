import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Env, Role } from "@rephoto/contracts";
import type { UserRow } from "@rephoto/db";
import type { AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";

export function applySecurityHeaders(headers: Headers, env: Env): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  if (env.WEB_ORIGIN.startsWith("https:")) {
    headers.set("Strict-Transport-Security", "max-age=15552000");
  }
}

function socketAddress(c: Context): string | null {
  try {
    const address = getConnInfo(c).remote.address;
    return address && address.length > 0 ? address : null;
  } catch {
    return null;
  }
}

/**
 * The client IP given `hops` trusted proxies appending to `x-forwarded-for`:
 * with `a, b, c` and hops 1 → `c`, hops 2 → `b`. Without the header → the socket address,
 * else "unknown".
 */
export function clientIp(c: Context, hops: number): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded && hops > 0) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const picked = entries[entries.length - hops];
    if (picked) return picked;
    const first = entries[0];
    if (first) return first;
  }
  return socketAddress(c) ?? "unknown";
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, MESSAGES.validation);
  }
}

export function requireUser(c: Context<AppEnv>): UserRow {
  const user = c.get("user");
  if (!user) throw new ApiError(401, MESSAGES.unauthorized);
  return user;
}

export function requireRole(user: UserRow, roles: readonly Role[]): void {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, MESSAGES.forbidden);
  }
}

export function since(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

export function webOrigin(env: Env): string {
  return env.WEB_ORIGIN.endsWith("/") ? env.WEB_ORIGIN.slice(0, -1) : env.WEB_ORIGIN;
}

export function encodeCursor(parts: string[]): string {
  return Buffer.from(parts.join("|"), "utf8").toString("base64url");
}

export function decodeCursor(raw: string, count: number): string[] | null {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = text.split("|");
  if (parts.length !== count || parts.some((part) => part.length === 0)) return null;
  return parts;
}
