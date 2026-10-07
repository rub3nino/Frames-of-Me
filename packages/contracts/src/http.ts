import { z } from "zod";
import { photoStatusSchema } from "./jobs.ts";

export const roleSchema = z.enum(["participant", "photographer", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const imageContentTypeSchema = z.enum(["image/jpeg", "image/png"]);

/** Version of the consent text the API accepts. Bump together with the text shown by the web. */
export const CONSENT_TEXT_VERSION = "2026-10-08";
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

/** Staff roles can log in with a password; participants stay magic-link only. */
export const staffRoleSchema = z.enum(["photographer", "admin"]);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const loginBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(200),
    // v6 (agent B): participants self-register with a password, so they log in here too.
    // Staff accounts are unaffected; `findUserForLogin` already keys on (email, role).
    role: roleSchema,
  })
  .strict();

export const loginResponseSchema = z
  .object({ user: userSchema })
  .strict();

/** Admin-only: create or update a staff account with a password. */
export const adminStaffCreateBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: staffRoleSchema,
    password: z.string().min(8).max(200),
    /** With `photographer`: the user is attached to this event. */
    eventId: z.string().uuid().optional(),
  })
  .strict();

export const adminStaffCreateResponseSchema = z
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
    /** Participant verdict (v5). `not_me` items are still returned: the UI hides them. */
    feedback: z.enum(["me", "not_me"]).nullable(),
  })
  .strict();

/**
 * Why the last `match` left the gallery empty (`galleries.last_match_reason`); null after a
 * successful match. `no_photos_yet`: the selfie was fine but nothing matched; the selfie vector
 * is kept so later uploads attach. `liveness`: the engine judged the selfie not live.
 */
export const galleryReasonSchema = z.enum([
  "no_face",
  "face_too_small",
  "low_quality",
  "multiple_faces",
  "no_photos_yet",
  "liveness",
]);
export type GalleryReason = z.infer<typeof galleryReasonSchema>;

export const galleryResponseSchema = z
  .object({
    status: galleryStatusSchema,
    total: z.number().int().nonnegative(),
    items: z.array(galleryItemSchema),
    nextCursor: z.string().min(1).nullable(),
    reason: galleryReasonSchema.nullable(),
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
export const UPLOAD_TAG_MAX = 20;
const uploadTagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(UPLOAD_TAG_MAX)
  .optional();

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
    /** Free labels stored on the photo (v5 test tooling, e.g. `synth`, `round-2`). */
    tags: uploadTagsSchema,
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
    tags: uploadTagsSchema,
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
    /** v5 (agent D): per-type queue view, age of the oldest queued job, last failures, face-service probe. */
    jobsByType: z.array(
      z
        .object({
          type: z.string().min(1),
          queued: z.number().int().nonnegative(),
          running: z.number().int().nonnegative(),
          error: z.number().int().nonnegative(),
          oldestQueuedSeconds: z.number().nonnegative().nullable(),
        })
        .strict(),
    ),
    oldestQueuedSeconds: z.number().nonnegative().nullable(),
    lastErrors: z.array(
      z
        .object({
          id: z.string().uuid(),
          type: z.string().min(1),
          error: z.string(),
          at: z.string().datetime(),
        })
        .strict(),
    ),
    faceService: z
      .object({
        /** null when the engine is not the face service. */
        ok: z.boolean().nullable(),
        ms: z.number().nonnegative().nullable(),
      })
      .strict(),
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

/** `POST /v1/admin/photos/requeue`: photos of the event in `status` (only `error` today), optionally narrowed by `error ilike '%errorLike%'`. */
export const adminRequeueBodySchema = z
  .object({
    eventId: z.string().uuid(),
    status: z.literal("error").default("error"),
    errorLike: z.string().min(1).max(200).optional(),
  })
  .strict();

export const adminRequeueResponseSchema = z
  .object({ requeued: z.number().int().nonnegative() })
  .strict();

// ---- admin and participant tooling v5 (agent D) ------------------------------------------

export const ADMIN_PAGE_DEFAULT = 50;
export const ADMIN_PAGE_MAX = 200;
export const NEIGHBOURS_DEFAULT = 20;
export const NEIGHBOURS_MAX = 100;

export const eventSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const adminEventCreateBodySchema = z
  .object({
    slug: eventSlugSchema,
    name: z.string().trim().min(1).max(200),
    retentionDays: z.number().int().positive().optional(),
    access: eventAccessSchema.optional(),
  })
  .strict();

export const adminEventListItemSchema = eventResponseSchema
  .extend({
    createdAt: z.string().datetime(),
    photos: z.number().int().nonnegative(),
    galleries: z.number().int().nonnegative(),
    participants: z.number().int().nonnegative(),
    photographers: z.number().int().nonnegative(),
  })
  .strict();

export const adminEventsResponseSchema = z
  .object({ events: z.array(adminEventListItemSchema) })
  .strict();

/** A raw magic link for the room (QR / printed), never mailed. */
export const adminMagicLinkBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: roleSchema,
    /** With `photographer`: the user is created and attached to this event. */
    eventId: z.string().uuid().optional(),
  })
  .strict();

export const adminMagicLinkResponseSchema = z
  .object({ url: z.string().url() })
  .strict();

export const adminGalleriesQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    email: z.string().trim().email().max(320).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
  })
  .strict();

export const feedbackVerdictSchema = z.enum(["me", "not_me"]);
export type FeedbackVerdict = z.infer<typeof feedbackVerdictSchema>;

export const adminGalleryItemSchema = z
  .object({
    photoId: z.string().uuid(),
    faceId: z.string().uuid(),
    thumbUrl: z.string().url(),
    webUrl: z.string().url(),
    score: z.number().min(0).max(1),
    source: galleryItemSourceSchema,
    createdAt: z.string().datetime(),
    originalReady: z.boolean(),
    feedback: feedbackVerdictSchema.nullable(),
    photo: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        filename: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const adminGalleryByEmailResponseSchema = z
  .object({
    user: userSchema,
    gallery: z
      .object({
        id: z.string().uuid(),
        matchedAt: z.string().datetime().nullable(),
        anchorFaceIds: z.array(z.string()),
        reason: galleryReasonSchema.nullable(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    items: z.array(adminGalleryItemSchema),
  })
  .strict();

export const adminGalleriesListResponseSchema = z
  .object({
    galleries: z.array(
      z
        .object({
          userId: z.string().uuid(),
          email: z.string().email(),
          total: z.number().int().nonnegative(),
          matchedAt: z.string().datetime().nullable(),
          reason: galleryReasonSchema.nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const bboxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

export const adminPhotoSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    photographerId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: photoStatusSchema,
    contentType: imageContentTypeSchema,
    bytes: z.number().int().nonnegative(),
    originalStatus: originalStatusSchema,
    indexedAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
    filename: z.string().nullable(),
    tags: z.array(z.string()),
  })
  .strict();

export const adminPhotoDetailResponseSchema = z
  .object({
    photo: adminPhotoSchema,
    webUrl: z.string().url().nullable(),
    thumbUrl: z.string().url().nullable(),
    faces: z.array(
      z
        .object({
          id: z.string().uuid(),
          externalId: z.string().min(1),
          bbox: bboxSchema,
          confidence: z.number(),
        })
        .strict(),
    ),
    galleries: z.array(
      z
        .object({
          userId: z.string().uuid(),
          email: z.string().email(),
          score: z.number().min(0).max(1),
          source: galleryItemSourceSchema,
          faceId: z.string().uuid(),
          feedback: feedbackVerdictSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const adminNeighboursQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(NEIGHBOURS_MAX).default(NEIGHBOURS_DEFAULT),
  })
  .strict();

export const adminNeighbourSchema = z
  .object({
    externalFaceId: z.string().min(1),
    photoId: z.string().uuid(),
    /** From the engine when it reports one, else the inverse of the similarity mapping. */
    cosine: z.number(),
    similarity: z.number(),
  })
  .strict();

export const adminNeighboursResponseSchema = z.array(adminNeighbourSchema);

export const adminPhotosQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{1,64}$/).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    status: photoStatusSchema.optional(),
    photographerId: z.string().uuid().optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
  })
  .strict();

export const adminPhotosResponseSchema = z
  .object({
    photos: z.array(adminPhotoSchema.extend({ thumbUrl: z.string().url().nullable() }).strict()),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const adminRematchResponseSchema = z
  .object({ jobId: z.string().uuid() })
  .strict();

export const adminResetBodySchema = z
  .object({ confirm: eventSlugSchema })
  .strict();

export const adminResetResponseSchema = z
  .object({ jobId: z.string().uuid() })
  .strict();

export const adminMatchRunsQuerySchema = z
  .object({
    eventId: z.string().uuid(),
    email: z.string().trim().email().max(320).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
  })
  .strict();

export const adminMatchRunSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    email: z.string().email(),
    liveness: z.string().nullable(),
    reason: z.string().nullable(),
    selfieSha256: z.string().nullable(),
    selfieFaces: z.number().int().nullable(),
    engineMs: z.number().int().nullable(),
    hits: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    /** Summary of match_hits: how many were kept and the best cosine seen. */
    kept: z.number().int().nonnegative(),
    maxCosine: z.number().nullable(),
  })
  .strict();

export const adminMatchRunsResponseSchema = z
  .object({
    runs: z.array(adminMatchRunSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const adminExportQuerySchema = z
  .object({ eventId: z.string().uuid() })
  .strict();

export const galleryFeedbackBodySchema = z
  .object({
    photoId: z.string().uuid(),
    verdict: feedbackVerdictSchema,
  })
  .strict();

export const galleryFeedbackResponseSchema = z
  .object({
    photoId: z.string().uuid(),
    verdict: feedbackVerdictSchema,
  })
  .strict();

/** `{ eventSlug }` served by the web at `/api/config` so the slug is a runtime setting. */
export const webConfigResponseSchema = z
  .object({ eventSlug: eventSlugSchema })
  .strict();

// ---- albums (v6, agent A) -------------------------------------------------------------
//
// `albums` is the new admin-created entity (migration 009). It is not `galleries` (the
// per-user personal match gallery) and not a Rekognition `collection`. Italian UI:
// "Album ufficiale" / "Album di tutti".

export const albumKindSchema = z.enum(["official", "crowd"]);
export type AlbumKind = z.infer<typeof albumKindSchema>;

export const albumModerationSchema = z.enum(["pre", "post", "off"]);
export type AlbumModeration = z.infer<typeof albumModerationSchema>;

export const albumVisibilitySchema = z.enum(["participants", "link", "staff"]);
export type AlbumVisibility = z.infer<typeof albumVisibilitySchema>;

/** Same shape as an event slug: lowercase, hyphen-separated. Unique within the event. */
export const albumSlugSchema = eventSlugSchema;

/** Slug of the official album every event gets (migration 009). */
export const DEFAULT_ALBUM_SLUG = "ufficiale";

export const ALBUM_MAX_PHOTOS_PER_USER_MAX = 1000;

export const albumSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    slug: albumSlugSchema,
    name: z.string().min(1).max(120),
    kind: albumKindSchema,
    /** Always false for `kind = 'crowd'`: a database `check` refuses the pair. */
    recognition: z.boolean(),
    moderation: albumModerationSchema,
    visibility: albumVisibilitySchema,
    maxPhotosPerUser: z.number().int().positive().nullable(),
    uploadsOpen: z.boolean(),
    retentionDays: z.number().int().positive().nullable(),
    /** Set by the album's first photo; `recognition` is read-only from then on. */
    firstUploadAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type Album = z.infer<typeof albumSchema>;

/**
 * A crowd album never recognises faces (decision 2, frozen): the body is refused here as
 * well as by the `crowd_never_recognizes` database constraint.
 */
export const createAlbumBodySchema = z
  .object({
    slug: albumSlugSchema,
    name: z.string().trim().min(1).max(120),
    kind: albumKindSchema,
    recognition: z.boolean().default(false),
    moderation: albumModerationSchema.default("post"),
    visibility: albumVisibilitySchema.default("participants"),
    maxPhotosPerUser: z.number().int().positive().max(ALBUM_MAX_PHOTOS_PER_USER_MAX).nullable().default(null),
    uploadsOpen: z.boolean().default(true),
    retentionDays: z.number().int().positive().max(3650).nullable().default(null),
  })
  .strict()
  .refine((body) => !(body.kind === "crowd" && body.recognition), {
    message: "a crowd album cannot use face recognition",
    path: ["recognition"],
  });

/** Every field optional; `recognition` is refused once the album has its first upload. */
export const updateAlbumBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    recognition: z.boolean().optional(),
    moderation: albumModerationSchema.optional(),
    visibility: albumVisibilitySchema.optional(),
    maxPhotosPerUser: z.number().int().positive().max(ALBUM_MAX_PHOTOS_PER_USER_MAX).nullable().optional(),
    uploadsOpen: z.boolean().optional(),
    retentionDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .strict();

export const albumsResponseSchema = z.object({ albums: z.array(albumSchema) }).strict();

export const albumResponseSchema = z.object({ album: albumSchema }).strict();

/**
 * Album-scoped dedup (migration 009 replaces `photos unique (event_id, sha256)` with
 * `unique (album_id, sha256)`): the same bytes in another album are a new photo, the same
 * bytes in the same album are already uploaded — an answer, not an error.
 */
export const albumUploadDedupeResponseSchema = z
  .object({
    status: z.literal("already-uploaded"),
    photoId: z.string().uuid(),
    albumId: z.string().uuid(),
  })
  .strict();
// ---- auth v6 (agent B): Google OIDC + participant self-registration ------------------------

export const identityProviderSchema = z.enum(["google"]);
export type IdentityProvider = z.infer<typeof identityProviderSchema>;

/** Minimum password length for self-registration and password resets. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
/** Short-lived cookie holding the signed state + PKCE verifier during the Google round-trip. */
export const OAUTH_STATE_COOKIE_NAME = "rephoto_oauth";
/** The signed state is only valid this long: long enough for a Google consent screen. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
/** Self-registrations per IP / per event code, counted over this window. */
export const REGISTER_RATE_LIMIT = { windowSeconds: 60 * 60 } as const;

/** Printed on the badge/QR. Case and surrounding spaces are normalised by the api. */
export const eventCodeSchema = z
  .string()
  .trim()
  .min(4)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);

export const registerBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    eventCode: eventCodeSchema,
  })
  .strict();

export const registerResponseSchema = z
  .object({ user: userSchema })
  .strict();

/** The only e-mail a self-registered participant ever triggers (lazy verification). */
export const passwordResetBodySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

export const passwordResetResponseSchema = z
  .object({ status: z.literal("sent") })
  .strict();

export const passwordResetConfirmBodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const passwordResetConfirmResponseSchema = z
  .object({ user: userSchema })
  .strict();

/**
 * Google appends `scope`, `authuser`, `prompt` and friends to the callback, so this is
 * deliberately not `.strict()`. `error` arrives when the user refuses consent.
 */
export const googleCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(200).optional(),
});

// ---- tagging v6 (agent E) -----------------------------------------------------------------
//
// Tagging makes the same person<->photo link that face recognition makes, minus the
// biometrics, so the contract is written tight on purpose. Three rules live here and must
// not be relaxed without re-reading section E of docs/v6-spec.md:
//
//   1. `tagSearchQuerySchema` has `.min(TAG_SEARCH_MIN_CHARS)`. With 6 000 participants a
//      loose autocomplete is a searchable roster of everyone at the event. An empty or
//      1-2 character query is not a short search, it is a directory dump.
//   2. `taggableUserSchema` is `.strict()` and has no `email`. Adding one would hand every
//      participant's address to anyone who can type three letters.
//   3. The search is rate limited per session (`TAG_SEARCH_RATE_LIMIT`), because 3 characters
//      times a loop is still an enumeration.

/** Minimum length of an autocomplete query. See rule 1 above. */
export const TAG_SEARCH_MIN_CHARS = 3;
/** Longest autocomplete query accepted (a display name is at most 60 characters). */
export const TAG_SEARCH_MAX_CHARS = 60;
/** Suggestions returned at most. Short enough that the list is a pick, not a browse. */
export const TAG_SEARCH_LIMIT = 8;
/** Autocomplete calls allowed per session per window. See rule 3 above. */
export const TAG_SEARCH_RATE_LIMIT = { windowSeconds: 60, max: 20 } as const;
/** Tags a session may create per window: tagging is also an abuse vector, not just a read. */
export const TAG_WRITE_RATE_LIMIT = { windowSeconds: 60 * 60, max: 60 } as const;
/** Bounds of `users.display_name`. */
export const DISPLAY_NAME_MIN_CHARS = 2;
export const DISPLAY_NAME_MAX_CHARS = 60;

/**
 * The consent for tagging, and its own legal basis.
 *
 * It is deliberately NOT `CONSENT_TEXT` / `CONSENT_TEXT_VERSION`, which cover the biometric
 * comparison of a face against the event's photos. Those are two different things:
 * consenting to be named in a photo is not consenting to be recognised in one. Decision 2
 * freezes that a `crowd` album is never biometric, so a participant whose only involvement
 * is the crowd album never grants recognition consent — and tagging is the only way they can
 * find themselves there. Tagging therefore must never require a `consents` row.
 *
 * Bump the version whenever the text changes: a stored version older than this one means the
 * participant consented to different words and has to be asked again.
 */
export const TAG_CONSENT_TEXT_VERSION = "2026-10-08";
export const TAG_CONSENT_TEXT =
  "Acconsento che gli altri partecipanti associno il nome che ho scelto alle foto dell'evento in cui compaio. Posso rimuovere ogni tag e disattivare i tag in qualsiasi momento: disattivandoli, i tag che ho già vengono rimossi. Questo consenso è separato dal riconoscimento del volto e non lo richiede.";

/** The participant's own opt-in state. Their own e-mail is theirs, so it is not here either. */
export const tagProfileSchema = z
  .object({
    taggable: z.boolean(),
    displayName: z.string().nullable(),
    /** The tagging consent text the participant accepted; null when they are not taggable. */
    consentTextVersion: z.string().nullable(),
    consentAt: z.string().datetime().nullable(),
  })
  .strict();

const displayNameField = z
  .string()
  .trim()
  .min(DISPLAY_NAME_MIN_CHARS)
  .max(DISPLAY_NAME_MAX_CHARS)
  .nullable()
  .optional();

/**
 * The opt-in and the opt-out.
 *
 * `taggable` is required and never defaulted: a body that forgets it is a validation error,
 * not an implicit "yes". Opting IN additionally requires `consentTextVersion`, pinned to the
 * current text, so a client cannot turn the flag on without having been shown what it means.
 * As with the selfie's liveness flag, the server cannot prove the text was read — this is a
 * deterrent plus a record, and the record is what the audit trail needs.
 */
export const tagProfileBodySchema = z.union([
  z
    .object({
      taggable: z.literal(true),
      displayName: displayNameField,
      consentTextVersion: z.literal(TAG_CONSENT_TEXT_VERSION),
    })
    .strict(),
  z
    .object({
      taggable: z.literal(false),
      displayName: displayNameField,
    })
    .strict(),
]);

/**
 * `q` is `.min(TAG_SEARCH_MIN_CHARS)` after trimming, so "", "a" and "ab" are rejected by the
 * schema itself — before any query runs. Do not add `.optional()` and do not lower the bound.
 */
export const tagSearchQuerySchema = z
  .object({
    q: z.string().trim().min(TAG_SEARCH_MIN_CHARS).max(TAG_SEARCH_MAX_CHARS),
  })
  .strict();

/** One suggestion: an opaque id and a display name. No e-mail, ever. See rule 2 above. */
export const taggableUserSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().min(1),
  })
  .strict();

export const tagSearchResponseSchema = z
  .object({ items: z.array(taggableUserSchema) })
  .strict();

export const tagCreateBodySchema = z
  .object({
    photoId: z.string().uuid(),
    userId: z.string().uuid(),
  })
  .strict();

export const tagSchema = z
  .object({
    photoId: z.string().uuid(),
    userId: z.string().uuid(),
    displayName: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** A photo the caller is tagged in. Separate from the personal match gallery, which is untouched. */
export const taggedPhotoSchema = z
  .object({
    photoId: z.string().uuid(),
    thumbUrl: z.string().url(),
    webUrl: z.string().url(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const tagsMeResponseSchema = z
  .object({
    profile: tagProfileSchema,
    items: z.array(taggedPhotoSchema),
  })
  .strict();

export const photoTagsResponseSchema = z
  .object({ items: z.array(tagSchema) })
  .strict();

export type TagProfile = z.infer<typeof tagProfileSchema>;
export type TaggableUser = z.infer<typeof taggableUserSchema>;
export type TagSearchResponse = z.infer<typeof tagSearchResponseSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type TaggedPhoto = z.infer<typeof taggedPhotoSchema>;
export type TagsMeResponse = z.infer<typeof tagsMeResponseSchema>;
export type PhotoTagsResponse = z.infer<typeof photoTagsResponseSchema>;
