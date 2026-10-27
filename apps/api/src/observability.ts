import * as Sentry from "@sentry/node";
import type { Env } from "@rephoto/contracts";

export function initSentry(env: Env, service: string): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? service,
    tracesSampleRate: 0.1,
  });
}
