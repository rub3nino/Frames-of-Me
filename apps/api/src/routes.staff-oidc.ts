import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_TTL_SECONDS } from "@rephoto/contracts";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { webOrigin } from "./http.js";
import {
  assertStaffClaims,
  createStaffTokenExchange,
  decodeIdToken,
  OauthError,
  staffOidcConfig,
  startStaffFlow,
  verifiedEmail,
  verifyCallbackState,
} from "./oauth-staff.js";
import { googleCallbackQuerySchema } from "@rephoto/contracts";
import { homePathForRole, resolveGoogleUser, startSession } from "./routes.js";

export function registerStaffOidcRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/v1/auth/staff/start", async (c) => {
    const config = staffOidcConfig(deps.env);
    if (!config) throw new ApiError(404, MESSAGES.notFound);
    const flow = startStaffFlow(config);
    setCookie(c, OAUTH_STATE_COOKIE_NAME, flow.cookie, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: deps.env.WEB_ORIGIN.startsWith("https:"),
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return c.redirect(flow.authorizeUrl, 302);
  });

  app.get("/v1/auth/staff/callback", async (c) => {
    const config = staffOidcConfig(deps.env);
    if (!config) throw new ApiError(404, MESSAGES.notFound);
    const query = googleCallbackQuerySchema.safeParse(c.req.query());
    const cookie = getCookie(c, OAUTH_STATE_COOKIE_NAME);
    deleteCookie(c, OAUTH_STATE_COOKIE_NAME, {
      path: "/",
      secure: deps.env.WEB_ORIGIN.startsWith("https:"),
    });
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    if (query.data.error) return c.redirect(`${webOrigin(deps.env)}/staff?oidc=annullato`, 302);
    try {
      const flow = verifyCallbackState(config, { cookie, state: query.data.state });
      if (!query.data.code) throw new OauthError("missing code");
      const { idToken } = await createStaffTokenExchange(config)({
        code: query.data.code,
        codeVerifier: flow.verifier,
        config,
      });
      const claims = decodeIdToken(idToken);
      assertStaffClaims(claims, { config, nonce: flow.nonce });
      const email = verifiedEmail(claims);
      const user = await resolveGoogleUser(deps, claims.sub, email);
      if (user.role === "participant") throw new ApiError(403, MESSAGES.forbidden);
      await startSession(c, deps, user);
      return c.redirect(`${webOrigin(deps.env)}${homePathForRole(user.role)}`, 302);
    } catch (error) {
      if (error instanceof OauthError) throw new ApiError(400, MESSAGES.linkInvalid);
      throw error;
    }
  });
}
