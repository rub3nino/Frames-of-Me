import type { Context } from "hono";
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

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
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
