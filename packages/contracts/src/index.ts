import { z } from "zod";

export const roleSchema = z.enum(["participant", "photographer", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const imageContentTypeSchema = z.enum(["image/jpeg", "image/png"]);
export type ImageContentType = z.infer<typeof imageContentTypeSchema>;

export const photoStatusSchema = z.enum([
  "queued",
  "processing",
  "indexed",
  "error",
]);
export type PhotoStatus = z.infer<typeof photoStatusSchema>;

export const searchStatusSchema = z.enum(["queued", "done", "error"]);
export type SearchStatus = z.infer<typeof searchStatusSchema>;

export const jobStatusSchema = z.enum(["queued", "running", "done", "error"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const faceEngineNameSchema = z.enum(["fake", "rekognition"]);
export type FaceEngineName = z.infer<typeof faceEngineNameSchema>;

export const uuidSchema = z.string().uuid();

export const eventSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const filenameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/\\]+$/)
  .refine((value) => value !== "." && value !== "..", {
    message: "Il nome file non è valido.",
  });

export const LIMITS = {
  photoMaxBytes: 30 * 1024 * 1024,
  selfieMaxBytes: 8 * 1024 * 1024,
  signedUrlTtlSeconds: 15 * 60,
  partSizeBytes: 8 * 1024 * 1024,
  magicLinkTtlSeconds: 30 * 60,
  sessionTtlSeconds: 30 * 24 * 60 * 60,
  minSimilarityDefault: 90,
  retentionDaysDefault: 90,
  maxFacesPerPhoto: 50,
  galleryDownloadMaxPhotos: 100,
  magicLinkPerEmail: 5,
  magicLinkPerIp: 30,
  magicLinkWindowSeconds: 15 * 60,
  selfiePerUser: 10,
  selfiePerIp: 30,
  selfieWindowSeconds: 60 * 60,
  jobMaxAttempts: 5,
} as const;

export const sessionCookie = {
  name: "rephoto_session",
  httpOnly: true as const,
  sameSite: "lax" as const,
  path: "/",
  maxAgeSeconds: LIMITS.sessionTtlSeconds,
};

export const SELFIE_FIELD_NAME = "image";

export const CONSENT_TEXT_VERSION = "2026-10-06";

export const errorCodeSchema = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "consent_required",
  "conflict",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const userSchema = z
  .object({
    id: uuidSchema,
    email: z.string().email(),
    role: roleSchema,
  })
  .strict();
export type User = z.infer<typeof userSchema>;

export const requestLinkBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    eventSlug: eventSlugSchema,
  })
  .strict();
export type RequestLinkBody = z.infer<typeof requestLinkBodySchema>;

export const requestLinkResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type RequestLinkResponse = z.infer<typeof requestLinkResponseSchema>;

export const verifyBodySchema = z
  .object({
    token: z.string().min(20).max(500),
  })
  .strict();
export type VerifyBody = z.infer<typeof verifyBodySchema>;

export const verifyResponseSchema = userSchema;
export type VerifyResponse = User;

export const meResponseSchema = userSchema;
export type MeResponse = User;

export const consentBodySchema = z
  .object({
    textVersion: z.string().min(1).max(40),
    accepted: z.literal(true),
  })
  .strict();
export type ConsentBody = z.infer<typeof consentBodySchema>;

export const consentResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type ConsentResponse = z.infer<typeof consentResponseSchema>;

export const selfieResponseSchema = z
  .object({
    searchId: uuidSchema,
  })
  .strict();
export type SelfieResponse = z.infer<typeof selfieResponseSchema>;

export const searchStatusResponseSchema = z
  .object({
    status: searchStatusSchema,
    galleryReady: z.boolean(),
  })
  .strict();
export type SearchStatusResponse = z.infer<typeof searchStatusResponseSchema>;

export const galleryItemSchema = z
  .object({
    photoId: uuidSchema,
    thumbUrl: z.string().url(),
    webUrl: z.string().url(),
    score: z.number().min(0).max(100),
  })
  .strict();
export type GalleryItem = z.infer<typeof galleryItemSchema>;

export const galleryResponseSchema = z
  .object({
    items: z.array(galleryItemSchema),
  })
  .strict();
export type GalleryResponse = z.infer<typeof galleryResponseSchema>;

export const galleryDownloadBodySchema = z
  .object({
    photoIds: z
      .array(uuidSchema)
      .min(1)
      .max(LIMITS.galleryDownloadMaxPhotos),
  })
  .strict();
export type GalleryDownloadBody = z.infer<typeof galleryDownloadBodySchema>;

export const galleryDownloadResponseSchema = z
  .object({
    urls: z.array(z.string().url()),
  })
  .strict();
export type GalleryDownloadResponse = z.infer<
  typeof galleryDownloadResponseSchema
>;

export const createUploadBodySchema = z
  .object({
    eventSlug: eventSlugSchema,
    filename: filenameSchema,
    contentType: imageContentTypeSchema,
    byteSize: z.number().int().positive().max(LIMITS.photoMaxBytes),
    sha256: sha256Schema,
  })
  .strict();
export type CreateUploadBody = z.infer<typeof createUploadBodySchema>;

export const uploadPartSchema = z
  .object({
    partNumber: z.number().int().positive(),
    url: z.string().url(),
  })
  .strict();

export const uploadCreatedResponseSchema = z
  .object({
    deduped: z.literal(false),
    uploadId: uuidSchema,
    key: z.string().min(1),
    partSize: z.number().int().positive(),
    parts: z.array(uploadPartSchema).min(1),
  })
  .strict();

export const uploadDedupedResponseSchema = z
  .object({
    deduped: z.literal(true),
    photoId: uuidSchema,
  })
  .strict();

export const createUploadResponseSchema = z.discriminatedUnion("deduped", [
  uploadDedupedResponseSchema,
  uploadCreatedResponseSchema,
]);
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

export const completeUploadBodySchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().positive(),
            etag: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;

export const completeUploadResponseSchema = z
  .object({
    photoId: uuidSchema,
    status: z.literal("queued"),
  })
  .strict();
export type CompleteUploadResponse = z.infer<
  typeof completeUploadResponseSchema
>;

export const photoListItemSchema = z
  .object({
    photoId: uuidSchema,
    filename: z.string().min(1),
    status: photoStatusSchema,
    error: z.string().min(1).optional(),
  })
  .strict();
export type PhotoListItem = z.infer<typeof photoListItemSchema>;

export const photoListResponseSchema = z
  .object({
    photos: z.array(photoListItemSchema),
  })
  .strict();
export type PhotoListResponse = z.infer<typeof photoListResponseSchema>;

export const adminMetricsResponseSchema = z
  .object({
    photos: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    participants: z.number().int().nonnegative(),
    queueDepth: z.number().int().nonnegative(),
  })
  .strict();
export type AdminMetricsResponse = z.infer<typeof adminMetricsResponseSchema>;

export const invitePhotographerBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    eventSlug: eventSlugSchema,
  })
  .strict();
export type InvitePhotographerBody = z.infer<
  typeof invitePhotographerBodySchema
>;

export const invitePhotographerResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type InvitePhotographerResponse = z.infer<
  typeof invitePhotographerResponseSchema
>;

export const retentionBodySchema = z
  .object({
    eventSlug: eventSlugSchema,
  })
  .strict();
export type RetentionBody = z.infer<typeof retentionBodySchema>;

export const retentionResponseSchema = z
  .object({
    photosDeleted: z.number().int().nonnegative(),
    facesDeleted: z.number().int().nonnegative(),
    searchesDeleted: z.number().int().nonnegative(),
  })
  .strict();
export type RetentionResponse = z.infer<typeof retentionResponseSchema>;

export const deriveJobSchema = z
  .object({
    type: z.literal("derive"),
    photoId: uuidSchema,
  })
  .strict();

export const indexJobSchema = z
  .object({
    type: z.literal("index"),
    photoId: uuidSchema,
  })
  .strict();

export const searchJobSchema = z
  .object({
    type: z.literal("search"),
    searchId: uuidSchema,
  })
  .strict();

export const emailJobSchema = z
  .object({
    type: z.literal("email"),
    to: z.string().email(),
    template: z.literal("gallery_ready"),
    searchId: uuidSchema,
  })
  .strict();

export const jobEnvelopeSchema = z.discriminatedUnion("type", [
  deriveJobSchema,
  indexJobSchema,
  searchJobSchema,
  emailJobSchema,
]);
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export const mailMessageSchema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    text: z.string().min(1),
  })
  .strict();
export type MailMessage = z.infer<typeof mailMessageSchema>;

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_REGION: z.literal("eu-central-1"),
    MAIL_TRANSPORT: z.enum(["smtp", "ses"]),
    MAILPIT_SMTP_HOST: z.string().min(1).optional(),
    MAILPIT_SMTP_PORT: z.coerce.number().int().positive().optional(),
    MAILPIT_UI_URL: z.string().url().optional(),
    FACE_ENGINE: faceEngineNameSchema,
    REKOGNITION_COLLECTION_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9_.\-]+$/)
      .default("rephoto"),
    REKOGNITION_MIN_SIMILARITY: z.coerce.number().min(0).max(100).default(90),
    AWS_REGION: z.literal("eu-central-1"),
    SESSION_SECRET: z.string().min(16),
    EVENT_SLUG: eventSlugSchema,
    ADMIN_EMAIL: z.string().email(),
    PUBLIC_WEB_URL: z.string().url(),
    API_PORT: z.coerce.number().int().positive().default(3001),
  })
  .superRefine((value, ctx) => {
    if (value.MAIL_TRANSPORT === "smtp") {
      if (!value.MAILPIT_SMTP_HOST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MAILPIT_SMTP_HOST"],
          message: "MAILPIT_SMTP_HOST is required when MAIL_TRANSPORT=smtp",
        });
      }
      if (!value.MAILPIT_SMTP_PORT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MAILPIT_SMTP_PORT"],
          message: "MAILPIT_SMTP_PORT is required when MAIL_TRANSPORT=smtp",
        });
      }
    }
    if (!value.S3_ENDPOINT && value.FACE_ENGINE === "fake") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_ENDPOINT"],
        message: "S3_ENDPOINT is required when FACE_ENGINE=fake",
      });
    }
  });
export type Env = z.infer<typeof envSchema>;
