import { z } from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.literal("eu-central-1"),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SESSION_SECRET: z.string().min(16),
  FACE_ENGINE: z.enum(["fake", "rekognition"]),
  AWS_REGION: z.literal("eu-central-1").default("eu-central-1"),
  REKOGNITION_COLLECTION_PREFIX: z.string().min(1).default("rephoto-"),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_FROM: z.string().min(1),
  WEB_ORIGIN: z.string().url(),
  API_ORIGIN: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;
