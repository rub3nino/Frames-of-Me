import { z } from "zod";

function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const optionalText = z.preprocess(blankToUndefined, z.string().min(1).optional());

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    S3_ENDPOINT: z.preprocess(blankToUndefined, z.string().url().optional()),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: optionalText,
    S3_SECRET_KEY: optionalText,
    S3_REGION: z.literal("eu-central-1"),
    S3_FORCE_PATH_STYLE: z.preprocess(
      blankToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    SESSION_SECRET: z.string().min(16),
    FACE_ENGINE: z.enum(["fake", "rekognition", "insightface"]),
    FACE_SERVICE_URL: z.preprocess(
      blankToUndefined,
      z.string().url().default("http://localhost:8090"),
    ),
    INSIGHTFACE_MIN_COSINE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0.5),
    ),
    INSIGHTFACE_SURE_COSINE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0.7),
    ),
    INSIGHTFACE_MAX_FACES: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(4096).default(200),
    ),
    INSIGHTFACE_MIN_FACE_QUALITY: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0.2),
    ),
    // --- v5 recognition (agent A) ---------------------------------------------
    /** `attach`: an anchor ↔ face cosine below this never adds a photo to a gallery. */
    INSIGHTFACE_ATTACH_MIN_COSINE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0.55),
    ),
    /** `match`: only hits at or above this cosine become anchors. Defaults to INSIGHTFACE_SURE_COSINE. */
    INSIGHTFACE_ANCHOR_MIN_COSINE: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).optional(),
    ),
    /** Faces asked of the service per indexed photo (`max_faces` of `/v1/embed`). */
    INSIGHTFACE_INDEX_MAX_FACES: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(150).default(100),
    ),
    /** Selfie gate: long edge of the largest face, in pixels of the image sent to the engine. */
    SELFIE_MIN_FACE_PX: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).default(120),
    ),
    /** Selfie gate: engine quality of the largest face. */
    SELFIE_MIN_QUALITY: z.preprocess(
      blankToUndefined,
      z.coerce.number().min(0).max(1).default(0.6),
    ),
    /** Which bytes `index` sends to the engine. Default: `original` for insightface, `web` otherwise. */
    FACE_INDEX_SOURCE: z.preprocess(
      blankToUndefined,
      z.enum(["web", "original"]).optional(),
    ),
    /** Long edge of the detection JPEG rendered from the original (FACE_INDEX_SOURCE=original). */
    FACE_DETECT_LONG_EDGE: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(640).max(8192).default(2560),
    ),
    /** Write every `match` run and all its hits to match_runs / match_hits (test campaign). */
    MATCH_LOG: z.preprocess(blankToUndefined, z.enum(["true", "false"]).default("false")),
    /** Keep the selfie object after `match` and record its key on the gallery (rematch tooling). */
    KEEP_SELFIES: z.preprocess(blankToUndefined, z.enum(["true", "false"]).default("false")),
    /** Add photoId / userId / eventId to the worker job log lines. */
    LOG_IDS: z.preprocess(blankToUndefined, z.enum(["true", "false"]).default("false")),
    FACE_INDEX_TPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive().default(20),
    ),
    FACE_SEARCH_TPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive().default(20),
    ),
    LIVENESS_CHECK: z.preprocess(
      blankToUndefined,
      z.enum(["true", "false"]).default("false"),
    ),
    AWS_REGION: z.literal("eu-central-1").default("eu-central-1"),
    REKOGNITION_COLLECTION_PREFIX: z.string().min(1).default("rephoto-"),
    REKOGNITION_SEARCH_MAX_FACES: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(4096).default(500),
    ),
    MAIL_TRANSPORT: z.enum(["smtp", "ses"]).default("smtp"),
    SMTP_HOST: optionalText,
    SMTP_PORT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    SMTP_USER: optionalText,
    SMTP_PASSWORD: optionalText,
    /** Implicit TLS from the first byte (SMTPS). Defaults to true on port 465, false otherwise. */
    SMTP_SECURE: z.preprocess(blankToUndefined, z.enum(["true", "false"]).optional()),
    /** STARTTLS on a plain connection: auto = upgrade when the server offers it, true = require, false = never. */
    SMTP_STARTTLS: z.preprocess(
      blankToUndefined,
      z.enum(["true", "false", "auto"]).default("auto"),
    ),
    SMTP_FROM: z.string().min(1),
    /** Magic links per email per hour (agent D, v5). */
    MAGIC_LINK_PER_EMAIL: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(3),
    ),
    /** Magic links per client IP per hour; 0 disables the per-IP limit. */
    MAGIC_LINK_PER_IP: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(20),
    ),
    /** Selfies per participant per hour; 0 disables the limit. */
    SELFIE_MAX_PER_HOUR: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(5),
    ),
    /** Comma-separated IPs or CIDRs that skip both limits (the test room's NAT). */
    RATE_LIMIT_EXEMPT_IPS: z.preprocess(blankToUndefined, z.string().default("")),
    /** Comma-separated emails upserted as admin when the api boots. */
    BOOTSTRAP_ADMINS: z.preprocess(blankToUndefined, z.string().default("")),
    WEB_ORIGIN: z.string().url(),
    API_ORIGIN: z.string().url(),
    SEED_DEMO: z.preprocess(blankToUndefined, z.enum(["true", "false"]).optional()),
    WORKER_CONCURRENCY: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(32).default(4),
    ),
    REKOGNITION_INDEX_TPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive().default(5),
    ),
    REKOGNITION_SEARCH_TPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive().default(5),
    ),
    TRUSTED_PROXY_HOPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(1),
    ),
    DATABASE_POOL_MAX: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).default(10),
    ),
    WORKER_PUBLISH_METRICS: z.preprocess(
      blankToUndefined,
      z.enum(["true", "false"]).default("false"),
    ),
    /** Host the browser uses for presigned URLs (MinIO behind a proxy); S3_ENDPOINT stays internal. */
    S3_PUBLIC_ENDPOINT: z.preprocess(blankToUndefined, z.string().url().optional()),
    // --- v6 auth (agent B) ----------------------------------------------------
    /** Google OIDC client. The three GOOGLE_* vars go together; without them the Google routes 404. */
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /** Must match the redirect URI registered in the Google console, e.g. https://host/v1/auth/google/callback. */
    GOOGLE_REDIRECT_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
    /** HMAC key for the short-lived state/PKCE cookie. Defaults to SESSION_SECRET when unset. */
    OAUTH_STATE_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
    /** Self-registrations per client IP per hour; 0 disables the limit. */
    REGISTER_PER_IP: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(20),
    ),
    /** Self-registrations per event code per hour; 0 disables the limit. */
    REGISTER_PER_CODE: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(600),
    ),
    // --- v6 hardening (agent H): the password-reset budget is its own -------------------
    //
    // It used to be the magic-link budget (`MAGIC_LINK_PER_*`), which coupled two
    // unrelated flows: a reset flood exhausted the event-day login fallback, and a
    // login-link flood locked a participant out of their own reset. Counted on
    // `password_reset_tokens` (migration 016), which only this route writes.
    /** Reset links per account per hour; 0 disables the limit. */
    PASSWORD_RESET_PER_USER: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(3),
    ),
    /** Reset links per client IP per hour; 0 disables the limit. */
    PASSWORD_RESET_PER_IP: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).default(20),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.INSIGHTFACE_SURE_COSINE <= env.INSIGHTFACE_MIN_COSINE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INSIGHTFACE_SURE_COSINE"],
        message: "must be greater than INSIGHTFACE_MIN_COSINE",
      });
    }
    if (env.S3_ENDPOINT) {
      if (!env.S3_ACCESS_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["S3_ACCESS_KEY"],
          message: "required when S3_ENDPOINT is set",
        });
      }
      if (!env.S3_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["S3_SECRET_KEY"],
          message: "required when S3_ENDPOINT is set",
        });
      }
    }
    if (env.MAIL_TRANSPORT === "smtp") {
      if (!env.SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SMTP_HOST"],
          message: "required when MAIL_TRANSPORT is smtp",
        });
      }
      if (!env.SMTP_PORT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SMTP_PORT"],
          message: "required when MAIL_TRANSPORT is smtp",
        });
      }
    }
    // v6 (agent B): a half-configured Google client is a deploy mistake, not a feature.
    const google = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URL];
    if (google.some(Boolean) && !google.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_CLIENT_ID"],
        message:
          "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URL must be set together",
      });
    }
  })
  .transform((env) => ({
    ...env,
    S3_FORCE_PATH_STYLE:
      env.S3_FORCE_PATH_STYLE === undefined
        ? Boolean(env.S3_ENDPOINT)
        : env.S3_FORCE_PATH_STYLE === "true",
    WORKER_PUBLISH_METRICS: env.WORKER_PUBLISH_METRICS === "true",
    SMTP_SECURE:
      env.SMTP_SECURE === undefined ? env.SMTP_PORT === 465 : env.SMTP_SECURE === "true",
    LIVENESS_CHECK: env.LIVENESS_CHECK === "true",
    INSIGHTFACE_ANCHOR_MIN_COSINE: env.INSIGHTFACE_ANCHOR_MIN_COSINE ?? env.INSIGHTFACE_SURE_COSINE,
    FACE_INDEX_SOURCE:
      env.FACE_INDEX_SOURCE ?? (env.FACE_ENGINE === "insightface" ? "original" : "web"),
    MATCH_LOG: env.MATCH_LOG === "true",
    KEEP_SELFIES: env.KEEP_SELFIES === "true",
    LOG_IDS: env.LOG_IDS === "true",
    OAUTH_STATE_SECRET: env.OAUTH_STATE_SECRET ?? env.SESSION_SECRET,
  }));

export type Env = z.infer<typeof envSchema>;
