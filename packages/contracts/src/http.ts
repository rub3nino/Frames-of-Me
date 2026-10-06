import { z } from "zod";

export const roleSchema = z.enum(["participant", "photographer", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const imageContentTypeSchema = z.enum(["image/jpeg", "image/png"]);

export const SESSION_COOKIE_NAME = "rephoto_session";
export const SELFIE_FIELD_NAME = "selfie";
export const SELFIE_RATE_LIMIT = { max: 5, windowSeconds: 60 * 60 } as const;
export const MULTIPART_THRESHOLD_BYTES = 8_388_608;
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export const errorBodySchema = z
  .object({ error: z.string().min(1) })
  .strict();

export const requestLinkBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: roleSchema,
  })
  .strict();

export const requestLinkResponseSchema = z
  .object({ status: z.literal("sent") })
  .strict();

export const verifyBodySchema = z
  .object({ token: z.string().min(1) })
  .strict();

export const userSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: roleSchema,
  })
  .strict();

export const verifyResponseSchema = z
  .object({ user: userSchema })
  .strict();

export const eventResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    retentionDays: z.number().int().positive(),
  })
  .strict();

export const consentBodySchema = z
  .object({
    textVersion: z.string().min(1),
    accepted: z.literal(true),
  })
  .strict();

export const consentResponseSchema = z
  .object({
    id: z.string().uuid(),
    grantedAt: z.string().datetime(),
  })
  .strict();

export const selfieResponseSchema = z
  .object({ status: z.literal("queued") })
  .strict();

export const galleryStatusSchema = z.enum(["empty", "queued", "ready"]);

export const galleryItemSchema = z
  .object({
    photoId: z.string().uuid(),
    thumbUrl: z.string().url(),
    webUrl: z.string().url(),
    score: z.number().min(0).max(1),
  })
  .strict();

export const galleryResponseSchema = z
  .object({
    status: galleryStatusSchema,
    items: z.array(galleryItemSchema),
  })
  .strict();

export const galleryDownloadBodySchema = z
  .object({
    photoIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export const galleryDownloadResponseSchema = z
  .object({
    urls: z.array(
      z
        .object({
          photoId: z.string().uuid(),
          url: z.string().url(),
        })
        .strict(),
    ),
  })
  .strict();

export const uploadInitBodySchema = z
  .object({
    eventId: z.string().uuid(),
    filename: z.string().min(1).max(200),
    contentType: imageContentTypeSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  })
  .strict();

export const uploadInitResponseSchema = z
  .object({
    id: z.string().uuid(),
    objectKey: z.string().min(1),
    mode: z.enum(["single", "multipart"]),
    url: z.string().url().optional(),
    partSize: z.number().int().positive().optional(),
  })
  .strict();

export const uploadPartBodySchema = z
  .object({ partNumber: z.number().int().positive() })
  .strict();

export const uploadPartResponseSchema = z
  .object({
    url: z.string().url(),
    partNumber: z.number().int().positive(),
  })
  .strict();

export const uploadCompleteBodySchema = z
  .object({
    parts: z.array(
      z
        .object({
          partNumber: z.number().int().positive(),
          etag: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const uploadCompleteResponseSchema = z
  .object({
    photoId: z.string().uuid(),
    status: z.literal("uploaded"),
  })
  .strict();

export const uploadListResponseSchema = z
  .object({
    uploads: z.array(
      z
        .object({
          id: z.string().uuid(),
          objectKey: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          contentType: imageContentTypeSchema,
          status: z.enum(["open", "completed", "aborted"]),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const adminMetricsResponseSchema = z
  .object({
    events: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
    faces: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    jobsQueued: z.number().int().nonnegative(),
  })
  .strict();

export const invitePhotographerBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    eventId: z.string().uuid(),
  })
  .strict();

export const invitePhotographerResponseSchema = z
  .object({ inviteId: z.string().uuid() })
  .strict();

export const retentionBodySchema = z
  .object({ eventId: z.string().uuid() })
  .strict();

export const retentionResponseSchema = z
  .object({ deletedPhotoIds: z.array(z.string().uuid()) })
  .strict();
