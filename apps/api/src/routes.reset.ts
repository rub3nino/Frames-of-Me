/**
 * v6 hardening H1 (agent H): password reset on a token of its own.
 *
 * Agent B shipped the reset flow on top of `magic_links`: one table, one `newToken()`, one
 * `consumeMagicLink`. Functionally correct, and a real escalation. A magic link is a *login*
 * token — it is mailed by `POST /v1/auth/request-link`, minted by the admin console
 * (`POST /v1/admin/magic-links`, shown as a QR on a screen), and documented as the event-day
 * fallback. Whoever got hold of one used to get a session that expires in 30 days at worst.
 * With the reset confirm accepting the same token, they got to SET THE PASSWORD: a
 * take-over, long after the link itself expired.
 *
 * So the reset token is its own thing:
 *   - its own table, `password_reset_tokens` (migration 016), which only this file writes;
 *   - bound to a `user_id` resolved when the link is issued, never to (email, role), so a
 *     later change of address cannot redirect an outstanding token;
 *   - 15 minutes instead of 20, single use, and burnt by `consumePasswordResetToken` in one
 *     statement, so a replay or a race loses;
 *   - burnt again by every password change (`Database.setUserPassword`);
 *   - its own rate limit, `PASSWORD_RESET_PER_USER` / `PASSWORD_RESET_PER_IP`, so this flow
 *     and the login-link fallback can no longer starve each other.
 *
 * The magic-link login path (`request-link` → `verify`) is untouched and keeps working.
 *
 * Registered from `routes.ts` with one line; these two routes used to live there.
 */
import type { Hono } from "hono";
import {
  PASSWORD_RESET_RATE_LIMIT,
  PASSWORD_RESET_TTL_SECONDS,
  passwordResetBodySchema,
  passwordResetConfirmBodySchema,
} from "@rephoto/contracts";
import { hashPassword, newToken, sha256Hex } from "./crypto.js";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { readJson, since, webOrigin } from "./http.js";
import { publicUser, rateLimitExempt, startSession } from "./routes.js";

export function registerResetRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.post("/v1/auth/password-reset", async (c) => {
    const body = passwordResetBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const email = body.data.email.toLowerCase();
    const ip = c.get("ip");
    // Only participants have a self-service reset: staff passwords are set by an admin
    // (`POST /v1/admin/staff`), which is the v5 behaviour agent B kept.
    const user = await deps.db.findUserByEmailRole(email, "participant");
    // The per-IP budget is checked for everyone, including unknown addresses: otherwise the
    // cheapest way to probe which addresses exist is to watch which requests get a 429.
    // The per-account budget can only be checked once an account is known.
    await enforceResetLimits(deps, user?.id ?? null, ip);
    // Always 202: whether the account exists is not answered here.
    if (user) {
      const token = newToken();
      await deps.db.insertPasswordResetToken({
        userId: user.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
        ip: ip === "unknown" ? null : ip,
      });
      await deps.mailer.send({
        to: email,
        subject: "Reimposta la password di Frames of Me",
        text: `${webOrigin(deps.env)}/registrati?reset=${encodeURIComponent(token)}`,
      });
    }
    return c.json({ status: "sent" }, 202);
  });

  app.post("/v1/auth/password-reset/confirm", async (c) => {
    const body = passwordResetConfirmBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    // The hash is looked up in `password_reset_tokens` only. A magic link — mailed,
    // intercepted or minted in the admin console — is not in this table and cannot be: this
    // single line is the fix. Unknown, used and expired are one answer.
    const consumed = await deps.db.consumePasswordResetToken(sha256Hex(body.data.token));
    if (!consumed) throw new ApiError(400, MESSAGES.linkInvalid);
    const user = await deps.db.findUserById(consumed.userId);
    // The user was deleted between the mail and the click; the token is already burnt.
    if (!user || user.role !== "participant") throw new ApiError(400, MESSAGES.linkInvalid);
    // `setUserPassword` also burns this user's other open reset tokens (migration 016), so a
    // second link mailed before this one was used dies here.
    await deps.db.setUserPassword(user.id, hashPassword(body.data.password));
    // Clicking the link proves the address: this is where lazy verification completes.
    await deps.db.markEmailVerified(user.id);
    await deps.db.insertAudit({
      actorId: user.id,
      action: "auth.password_reset",
      target: `user:${user.id}`,
      meta: {},
    });
    await startSession(c, deps, user);
    return c.json({ user: publicUser(user) });
  });
}

/**
 * Counted on `password_reset_tokens`, the table only this route writes — not on
 * `magic_links`, which the login fallback and the admin console also fill.
 *
 * `userId` is null for an address with no account: nothing was written for it, so only the
 * per-IP budget applies. That is the right shape anyway — a per-address counter for
 * addresses that do not exist would be a memory of strangers' typos.
 */
async function enforceResetLimits(
  deps: AppDeps,
  userId: string | null,
  ip: string,
): Promise<void> {
  if (rateLimitExempt(deps, ip)) return;
  const windowStart = since(PASSWORD_RESET_RATE_LIMIT.windowSeconds);
  const perUser = deps.env.PASSWORD_RESET_PER_USER;
  if (userId && perUser > 0) {
    const byUser = await deps.db.countPasswordResetTokensSince({ userId, since: windowStart });
    if (byUser >= perUser) throw new ApiError(429, MESSAGES.rateLimited);
  }
  const perIp = deps.env.PASSWORD_RESET_PER_IP;
  if (perIp > 0 && ip !== "unknown") {
    const byIp = await deps.db.countPasswordResetTokensSince({ ip, since: windowStart });
    if (byIp >= perIp) throw new ApiError(429, MESSAGES.rateLimited);
  }
}
