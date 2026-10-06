import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "@rephoto/contracts";
import { sha256Hex } from "./crypto.js";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { applySecurityHeaders, clientIp } from "./http.js";
import { registerRoutes } from "./routes.js";

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin === deps.env.WEB_ORIGIN) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Headers", "Content-Type");
      c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      return c.body(null, 204);
    }
    c.set("ip", clientIp(c));
    const token = getCookie(c, SESSION_COOKIE_NAME);
    c.set("user", token ? await deps.db.findUserBySession(sha256Hex(token)) : null);
    await next();
    applySecurityHeaders(c.res.headers, deps.env);
  });

  app.onError((error, c) => {
    const response =
      error instanceof ApiError
        ? c.json({ error: error.message }, error.status)
        : c.json({ error: MESSAGES.internal }, 500);
    if (!(error instanceof ApiError)) {
      const message = error instanceof Error ? error.message : "api error";
      console.error(message.slice(0, 300));
    }
    applySecurityHeaders(response.headers, deps.env);
    return response;
  });

  app.notFound((c) => {
    const response = c.json({ error: MESSAGES.notFound }, 404);
    applySecurityHeaders(response.headers, deps.env);
    return response;
  });

  registerRoutes(app, deps);
  return app;
}
