import { z } from "zod";
import { photoStatusSchema } from "./jobs.ts";

export const roleSchema = z.enum(["participant", "photographer", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const imageContentTypeSchema = z.enum(["image/jpeg", "image/png"]);

/** Version of the consent text the API accepts. Bump together with the text shown by the web. */
export const CONSENT_TEXT_VERSION = "2026-10-06";
export const SESSION_COOKIE_NAME = "rephoto_session";
export const SELFIE_FIELD_NAME = "selfie";
/** Multipart field next to the selfie: how it was captured. Stored in audit_log, meta.liveness. */
export const SELFIE_LIVENESS_FIELD = "liveness";
export const selfieLivenessSchema = z.enum(["challenge", "file"]);
export type SelfieLiveness = z.infer<typeof selfieLivenessSchema>;
export const SELFIE_RATE_LIMIT = { max: 5, windowSeconds: 60 * 60 } as const;
/** 10 MiB: the largest body the api accepts (selfie multipart of 8 MiB plus overhead). */
export const API_BODY_MAX_BYTES = 10_485_760;
export const MAGIC_LINK_RATE_LIMIT = { perEmail: 3, perIp: 20, windowSeconds: 60 * 60 } as const;
export const MULTIPART_THRESHOLD_BYTES = 8_388_608;
/** 60 MiB. */
export const UPLOAD_MAX_BYTES = 62_914_560;
/** 8 MiB: the largest web-stage JPEG (1600 px long edge) the api accepts. Always a single PUT. */
export const WEB_STAGE_MAX_BYTES = 8_388_608;
export const SIGNED_URL_TTL_SECONDS = 30 * 60;
/** Presigned GET URLs are signed with a date rounded down to this window so they repeat (browser cache). */
export const SIGNED_URL_WINDOW_SECONDS = 10 * 60;
export const GALLERY_PAGE_DEFAULT = 60;
export const GALLERY_PAGE_MAX = 200;
export const DOWNLOAD_MAX_PHOTOS = 100;
export const ZIP_MAX_PHOTOS = 500;
export const UPLOAD_LIST_PAGE_DEFAULT = 50;
export const UPLOAD_LIST_PAGE_MAX = 200;
export const PARTICIPANTS_IMPORT_MAX = 5000;

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

export const acceptInviteBodySchema = z
  .object({ token: z.string().min(1) })
  .strict();

export const acceptInviteResponseSchema = z
  .object({ user: userSchema })
  .strict();

export const eventAccessSchema = z.enum(["open", "list"]);
export type EventAccess = z.infer<typeof eventAccessSchema>;

export const eventResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    retentionDays: z.number().int().positive(),
    access: eventAccessSchema,
  })
  .strict();

export const eventPatchBodySchema = z
  .object({
    access: eventAccessSchema.optional(),
    retentionDays: z.number().int().positive().optional(),
  })
  .strict();

export const consentBodySchema = z
  .object({
    textVersion: z.literal(CONSENT_TEXT_VERSION),
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

export const galleryItemSourceSchema = z.enum(["match", "attach"]);
export type GalleryItemSource = z.infer<typeof galleryItemSourceSchema>;

export const galleryQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(GALLERY_PAGE_MAX).default(GALLERY_PAGE_DEFAULT),
  })
  .strict();

export const galleryItemSchema = z
  .object({
    photoId: z.string().uuid(),
    thumbUrl: z.string().url(),
    webUrl: z.string().url(),
    score: z.number().min(0).max(1),
    source: galleryItemSourceSchema,
    createdAt: z.string().datetime(),
    /** False while only the web version is in: "Originali" downloads fall back to it. */
    originalReady: z.boolean(),
  })
  .strict();

export const galleryResponseSchema = z
  .object({
    status: galleryStatusSchema,
    total: z.number().int().nonnegative(),
    items: z.array(galleryItemSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const downloadVariantSchema = z.enum(["original", "web"]);
export type DownloadVariant = z.infer<typeof downloadVariantSchema>;

export const galleryDownloadBodySchema = z
  .object({
    photoIds: z.array(z.string().uuid()).min(1).max(DOWNLOAD_MAX_PHOTOS),
    variant: downloadVariantSchema.default("original"),
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

export const galleryZipBodySchema = z
  .object({
    photoIds: z.array(z.string().uuid()).min(1).max(ZIP_MAX_PHOTOS),
    variant: downloadVariantSchema.default("original"),
  })
  .strict();

/** Gallery cursors are opaque to clients: base64url of `score|photoId`. */
export function encodeGalleryCursor(cursor: { score: number; photoId: string }): string {
  return Buffer.from(`${cursor.score}|${cursor.photoId}`, "utf8").toString("base64url");
}

export function decodeGalleryCursor(
  raw: string,
): { score: number; photoId: string } | null {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = text.indexOf("|");
  if (separator <= 0) return null;
  const score = Number(text.slice(0, separator));
  const photoId = text.slice(separator + 1);
  if (!Number.isFinite(score) || score < 0 || score > 1) return null;
  if (!z.string().uuid().safeParse(photoId).success) return null;
  return { score, photoId };
}

export const uploadStageSchema = z.enum(["original", "web"]);
export type UploadStage = z.infer<typeof uploadStageSchema>;

export const originalStatusSchema = z.enum(["pending", "present"]);
export type OriginalStatus = z.infer<typeof originalStatusSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Original stage: `sha256`/`bytes` describe the original. With `photoId` the photo was
 * created by an earlier web stage and is still `original_status = 'pending'`.
 */
export const uploadInitOriginalBodySchema = z
  .object({
    eventId: z.string().uuid(),
    filename: z.string().min(1).max(200),
    contentType: imageContentTypeSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
    stage: z.literal("original").default("original"),
    photoId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Web stage: `contentType`/`bytes` describe the 1600 px JPEG being uploaded now;
 * `sha256`/`originalContentType`/`originalBytes` describe the original that follows.
 */
export const uploadInitWebBodySchema = z
  .object({
    eventId: z.string().uuid(),
    filename: z.string().min(1).max(200),
    contentType: z.literal("image/jpeg"),
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(WEB_STAGE_MAX_BYTES),
    stage: z.literal("web"),
    originalContentType: imageContentTypeSchema,
    originalBytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
  })
  .strict();

/** Discriminated on `stage`; a body without `stage` is the original stage (v2 behaviour). */
export const uploadInitBodySchema = z.union([uploadInitWebBodySchema, uploadInitOriginalBodySchema]);
export type UploadInitBody = z.infer<typeof uploadInitBodySchema>;

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
    /** `original_received`: the original of a web-first photo arrived (no re-derive). */
    status: z.enum(["uploaded", "original_received"]),
  })
  .strict();

export const uploadLookupQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    sha256: sha256Schema,
  })
  .strict();

export const uploadLookupResponseSchema = z
  .object({
    photoId: z.string().uuid(),
    originalStatus: originalStatusSchema,
    status: photoStatusSchema,
  })
  .strict();

export const uploadListQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(UPLOAD_LIST_PAGE_MAX)
      .default(UPLOAD_LIST_PAGE_DEFAULT),
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
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const uploadSummaryQuerySchema = z
  .object({ eventId: z.string().uuid() })
  .strict();

const photosByStatusSchema = z
  .object({
    uploaded: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict();

export const uploadSummaryResponseSchema = z
  .object({
    sessions: z
      .object({
        open: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        aborted: z.number().int().nonnegative(),
      })
      .strict(),
    photos: photosByStatusSchema
      .extend({
        /** Photos whose original has not arrived yet (web stage only). */
        originalsPending: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const adminMetricsResponseSchema = z
  .object({
    events: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
    faces: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    jobsQueued: z.number().int().nonnegative(),
    jobsRunning: z.number().int().nonnegative(),
    jobsError: z.number().int().nonnegative(),
    photosByStatus: photosByStatusSchema,
    galleries: z.number().int().nonnegative(),
    originalsPending: z.number().int().nonnegative(),
  })
  .strict();

export const healthResponseSchema = z
  .object({ ok: z.boolean() })
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

export const participantsImportBodySchema = z
  .object({
    eventId: z.string().uuid(),
    emails: z
      .array(z.string().trim().toLowerCase().email().max(320))
      .min(1)
      .max(PARTICIPANTS_IMPORT_MAX),
  })
  .strict();

export const participantsImportResponseSchema = z
  .object({ inserted: z.number().int().nonnegative() })
  .strict();

export const retentionBodySchema = z
  .object({ eventId: z.string().uuid() })
  .strict();

export const retentionResponseSchema = z
  .object({ jobId: z.string().uuid() })
  .strict();
