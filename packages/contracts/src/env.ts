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
    FACE_ENGINE: z.enum(["fake", "rekognition"]),
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
    SMTP_FROM: z.string().min(1),
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
  })
  .superRefine((env, ctx) => {
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
  })
  .transform((env) => ({
    ...env,
    S3_FORCE_PATH_STYLE:
      env.S3_FORCE_PATH_STYLE === undefined
        ? Boolean(env.S3_ENDPOINT)
        : env.S3_FORCE_PATH_STYLE === "true",
    WORKER_PUBLISH_METRICS: env.WORKER_PUBLISH_METRICS === "true",
  }));

export type Env = z.infer<typeof envSchema>;
