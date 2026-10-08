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
// ---- admin console v6 (agent D) ------------------------------------------------------------
//
// Everything the admin console needs that no other area owns: event codes (minted, listed,
// labelled, capped, expired, revoked), per-album photographer authorization, the live event
// status screen and the operations link page. The album schemas above (agent A) are reused
// as they are — the console adds no second shape for them.

/**
 * Alphabet of a generated event code: no `I`, `O`, `0`, `1`, so a code read off a badge is
 * never mistyped into another code. Codes are compared uppercase (`routes.ts` uppercases
 * what the registration form sends), so they are stored uppercase too.
 */
export const EVENT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Characters per group of a generated code; two groups are printed as `ABCD-EFGH`. */
export const EVENT_CODE_GROUP = 4;

export const eventCodeStatusSchema = z.enum(["active", "expired", "exhausted"]);
export type EventCodeStatus = z.infer<typeof eventCodeStatusSchema>;

export const adminEventCodeSchema = z
  .object({
    eventId: z.string().uuid(),
    code: eventCodeSchema,
    label: z.string().nullable(),
    maxUses: z.number().int().positive().nullable(),
    uses: z.number().int().nonnegative(),
    expiresAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    /** Derived, not stored: what `claimEventCode` would do with it right now. */
    status: eventCodeStatusSchema,
  })
  .strict();

export type AdminEventCode = z.infer<typeof adminEventCodeSchema>;

/** `code` absent → the api mints one. `maxUses`/`expiresAt` null → uncapped / no expiry. */
export const createEventCodeBodySchema = z
  .object({
    code: eventCodeSchema.optional(),
    label: z.string().trim().min(1).max(120).nullable().default(null),
    maxUses: z.number().int().positive().max(100_000).nullable().default(null),
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();

/** Every field optional; `maxUses: <uses>` caps a code where it stands. */
export const updateEventCodeBodySchema = z
  .object({
    label: z.string().trim().min(1).max(120).nullable().optional(),
    maxUses: z.number().int().positive().max(100_000).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export const adminEventCodesResponseSchema = z
  .object({ codes: z.array(adminEventCodeSchema) })
  .strict();

export const adminEventCodeResponseSchema = z.object({ code: adminEventCodeSchema }).strict();

/** Per-album upload authorization (migration 017). */
export const adminAlbumPhotographerSchema = z
  .object({
    userId: z.string().uuid(),
    email: z.string().email(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const adminAlbumPhotographersResponseSchema = z
  .object({
    photographers: z.array(adminAlbumPhotographerSchema),
    /**
     * False while the album has no explicit list: the event-level `event_photographers`
     * grant still stands and every photographer of the event may upload.
     */
    restricted: z.boolean(),
  })
  .strict();

export const adminAlbumPhotographerBodySchema = z
  .object({ email: z.string().trim().email().max(320) })
  .strict();

/** One auto-refreshing screen for the event day. */
export const adminEventStatusResponseSchema = z
  .object({
    event: z.object({ id: z.string().uuid(), slug: eventSlugSchema, name: z.string() }).strict(),
    photos: z.number().int().nonnegative(),
    photosByStatus: photosByStatusSchema,
    originalsPending: z.number().int().nonnegative(),
    faces: z.number().int().nonnegative(),
    galleries: z.number().int().nonnegative(),
    galleriesMatched: z.number().int().nonnegative(),
    /** Galleries holding a selfie vector that have not matched yet. */
    selfiesWaiting: z.number().int().nonnegative(),
    /** Queued + running `match` jobs, the other half of "selfies waiting". */
    matchJobsPending: z.number().int().nonnegative(),
    albums: z.array(
      z
        .object({
          id: z.string().uuid(),
          slug: albumSlugSchema,
          name: z.string(),
          kind: albumKindSchema,
          recognition: z.boolean(),
          moderation: albumModerationSchema,
          uploadsOpen: z.boolean(),
          photos: z.number().int().nonnegative(),
          firstUploadAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    jobsByType: z.array(
      z
        .object({
          type: z.string(),
          queued: z.number().int().nonnegative(),
          running: z.number().int().nonnegative(),
          error: z.number().int().nonnegative(),
          oldestQueuedSeconds: z.number().nullable(),
        })
        .strict(),
    ),
    oldestQueuedSeconds: z.number().nullable(),
    lastErrors: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          error: z.string(),
          at: z.string().datetime(),
        })
        .strict(),
    ),
    faceService: z.object({ ok: z.boolean().nullable(), ms: z.number().nullable() }).strict(),
    at: z.string().datetime(),
  })
  .strict();

/** How often the live status screen re-reads itself. */
export const ADMIN_STATUS_REFRESH_MS = 5_000;

/**
 * Operations links come from `OPS_LINK_*` (`env.ts`). Links only: the console never mirrors
 * those dashboards through their APIs.
 */
export const opsLinkKeySchema = z.enum(["resend", "posthog", "sentry", "coolify", "authentik", "r2"]);
export type OpsLinkKey = z.infer<typeof opsLinkKeySchema>;

export const adminOpsLinksResponseSchema = z
  .object({
    links: z.array(
      z.object({ key: opsLinkKeySchema, label: z.string(), url: z.string().url() }).strict(),
    ),
  })
  .strict();

// ---- crowd upload and moderation v6 (agent C) ---------------------------------------------

/**
 * `photos.moderation_state` (migration 010). A column SEPARATE from `photos.status`:
 * `status` is the processing pipeline, this is the moderation state machine. Never merged.
 */
export const moderationStateSchema = z.enum(["pending", "approved", "rejected", "auto_rejected"]);
export type ModerationState = z.infer<typeof moderationStateSchema>;

export const reportReasonSchema = z.enum(["inappropriate", "not_me", "copyright", "other"]);
export type ReportReason = z.infer<typeof reportReasonSchema>;

/**
 * The ONLY reasons that count toward the auto-pending threshold, and the only ones that put
 * an otherwise approved photo in the moderation queue.
 *
 * `not_me` is deliberately NOT here, and must not be "simplified" back in. It is not an abuse
 * signal: it is the expected output of face matching. One group photo gets matched to several
 * people and each of them correctly rejects it — the system working as designed. At 6,000
 * participants that happens constantly, so counting it would turn the recognition system's
 * normal error mode into global takedowns: three people tapping "non sono io" would pull a
 * correctly-uploaded photo out of EVERYONE's gallery (because a non-approved photo leaves
 * every gallery, see `listGalleryPage`) and would fill a two-person moderation queue with
 * false positives.
 *
 * `not_me` has a home already: `gallery_feedback`, which the gallery's own "Non sono io"
 * button writes and which agent E's tag removal reuses. It is a PER-USER correctness signal,
 * so it hides the photo for that one person and for nobody else. The report row is still
 * recorded (someone may genuinely want a wrong match looked at) and a moderator can ask for
 * those rows explicitly, but it never counts.
 */
export const MODERATION_COUNTING_REASONS = ["inappropriate", "copyright", "other"] as const;
export type ModerationCountingReason = (typeof MODERATION_COUNTING_REASONS)[number];

export function countsTowardModeration(reason: ReportReason): boolean {
  return (MODERATION_COUNTING_REASONS as readonly string[]).includes(reason);
}

/** How many DISTINCT open reports flip a photo to `pending` when the env var is unset. */
export const REPORT_AUTO_PENDING_DEFAULT = 3;

export const REPORT_NOTE_MAX = 500;

/** Reports per participant are counted over this window (REPORT_PER_USER). */
export const REPORT_RATE_LIMIT = { windowSeconds: 60 * 60 } as const;

/**
 * Crowd-album uploads per participant are counted over this window
 * (`ALBUM_UPLOAD_MAX_PER_HOUR`, ported from main's `PUBLIC_UPLOAD_RATE_LIMIT`).
 *
 * Counted per `(album, uploader)`, which under this model means
 * `(upload_sessions.album_id, upload_sessions.photographer_id)`: since migration 009
 * `photographer_id` IS the uploader, and for a crowd album it is the participant (the
 * schema says so in a `comment on column`). There is no `uploader_id` here.
 *
 * Why an album and not an event: an event can hold several crowd albums with different
 * `uploads_open` and `max_photos_per_user` settings, and the gate belongs where those live.
 * It is deliberately NOT a substitute for `albums.max_photos_per_user`: that is an absolute
 * cap on the album (and defaults to `null`, unlimited), this bounds the burst.
 */
export const ALBUM_UPLOAD_RATE_LIMIT = { windowSeconds: 60 * 60 } as const;

export const reportBodySchema = z
  .object({
    reason: reportReasonSchema,
    note: z.string().trim().min(1).max(REPORT_NOTE_MAX).optional(),
  })
  .strict();

/**
 * `state` is the photo's moderation state after the report. `status` lets the client tell
 * "recorded" from "you already reported this" without leaking who else reported.
 */
export const reportResponseSchema = z
  .object({
    status: z.enum(["recorded", "already-reported"]),
    state: moderationStateSchema,
    /**
     * Distinct people with an open report whose reason is in
     * {@link MODERATION_COUNTING_REASONS}. `not_me` reports are excluded, so this is the
     * number the threshold actually compares against.
     */
    openReports: z.number().int().nonnegative(),
    /** False for `not_me`: recorded, never counted toward the threshold. */
    counts: z.boolean(),
    /**
     * True when the report also wrote the caller's `gallery_feedback` row, which is what
     * hides the photo in THEIR gallery and nobody else's (a `not_me` on a photo of their
     * own match gallery).
     */
    hiddenForYou: z.boolean(),
  })
  .strict();

/** A participant upload into a crowd album: the album comes from the path, not the body. */
export const albumUploadInitBodySchema = z
  .object({
    filename: z.string().min(1).max(200),
    contentType: imageContentTypeSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
  })
  .strict();

export const albumPhotosQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const albumPhotoSchema = z
  .object({
    id: z.string().uuid(),
    albumId: z.string().uuid(),
    uploaderId: z.string().uuid(),
    createdAt: z.string().datetime(),
    thumbUrl: z.string().min(1),
    webUrl: z.string().min(1),
    /** True when the caller uploaded it: the only photo they may see reported counts for. */
    mine: z.boolean(),
  })
  .strict();

export const albumPhotosResponseSchema = z
  .object({
    photos: z.array(albumPhotoSchema),
    nextCursor: z.string().min(1).nullable(),
    /** The caller's own approved + pending count and the album cap, for the upload button. */
    quota: z
      .object({ used: z.number().int().nonnegative(), max: z.number().int().positive().nullable() })
      .strict(),
  })
  .strict();

/**
 * Which rendition a crowd-album photo may be downloaded as, and the answer is: a derivative,
 * never the original.
 *
 * Main offered `original` here (its `galleryDownloadBodySchema` is shared with the personal
 * match gallery, where `original` is the whole point — those are the photographer's own
 * photos of you, and the download is the product). A crowd album is different in kind: the
 * photos are other participants' camera originals, carrying full-resolution faces and
 * whatever EXIF the phone wrote, uploaded by someone who was sharing a moment with the room
 * and not publishing a master. Handing the original to every other participant is a decision
 * nobody has taken, so the conservative answer is encoded here rather than assumed.
 *
 * It is a one-value enum and not an omitted field on purpose: `{"variant":"original"}` gets a
 * 400 that says the request was understood and refused, instead of silently receiving the
 * 1600 px web derivative and believing it is the original. Widening it is a one-line change
 * IF someone decides the product wants it — and it is a product decision, not a code one.
 */
export const crowdDownloadVariantSchema = z.enum(["web"]);
export type CrowdDownloadVariant = z.infer<typeof crowdDownloadVariantSchema>;

export const albumDownloadBodySchema = z
  .object({
    photoIds: z.array(z.string().uuid()).min(1).max(DOWNLOAD_MAX_PHOTOS),
    variant: crowdDownloadVariantSchema.default("web"),
  })
  .strict();

export const albumDownloadResponseSchema = z
  .object({
    urls: z.array(
      z.object({ photoId: z.string().uuid(), url: z.string().min(1) }).strict(),
    ),
  })
  .strict();

export const moderationQuerySchema = z
  .object({
    albumId: z.string().uuid().optional(),
    state: moderationStateSchema.optional(),
    /**
     * Opt-in: also return approved photos whose only open reports are `not_me`. Off by
     * default, because at 6,000 participants wrong matches are the common case and they
     * would bury the queue. A moderator who wants to look at them asks for them.
     */
    includeNotMe: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const moderationItemSchema = z
  .object({
    photoId: z.string().uuid(),
    albumId: z.string().uuid(),
    eventId: z.string().uuid(),
    uploaderId: z.string().uuid(),
    moderationState: moderationStateSchema,
    createdAt: z.string().datetime(),
    /** Counting reasons only (see {@link MODERATION_COUNTING_REASONS}). */
    openReports: z.number().int().nonnegative(),
    /** Distinct reasons of every open report, `not_me` included: the moderator sees it all. */
    reasons: z.array(reportReasonSchema),
    /** Distinct people who said "non sono io". Shown, never counted. */
    notMeReports: z.number().int().nonnegative(),
    thumbUrl: z.string().min(1).nullable(),
    webUrl: z.string().min(1).nullable(),
  })
  .strict();

export const moderationResponseSchema = z
  .object({
    items: z.array(moderationItemSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

/** A moderator rules on a photo. `auto_rejected` is the screening hook's verdict, never a human's. */
export const moderateBodySchema = z
  .object({ state: z.enum(["approved", "pending", "rejected"]) })
  .strict();

export const moderateResponseSchema = z
  .object({
    photoId: z.string().uuid(),
    state: moderationStateSchema,
    /** True when the ruling purged the object through `purgePhoto` (a rejection). */
    purged: z.boolean(),
  })
  .strict();

// ---- privacy: consent withdrawal and retention schedule v6 (agent G) ----------------------

/**
 * `GET /v1/events/:slug/privacy` — what the participant area ("I miei dati") shows: the state
 * of their own consent and what of theirs is stored. Never anybody else's data.
 */
export const privacyStateResponseSchema = z
  .object({
    event: z.object({ slug: z.string().min(1), name: z.string().min(1) }).strict(),
    /** The active consent, or null when there is none (never given, or withdrawn). */
    consent: z
      .object({
        grantedAt: z.string().datetime(),
        textVersion: z.string().min(1),
      })
      .strict()
      .nullable(),
    /** When the consent was last withdrawn; null when it never was. */
    withdrawnAt: z.string().datetime().nullable(),
    /** The personal match gallery, or null when there is none (no selfie yet, or withdrawn). */
    gallery: z
      .object({
        photos: z.number().int().nonnegative(),
        /** The selfie template (`galleries.query_embedding`) is stored. */
        selfieVector: z.boolean(),
        anchors: z.number().int().nonnegative(),
        matchedAt: z.string().datetime().nullable(),
      })
      .strict()
      .nullable(),
    /** Photos of the event the participant uploaded themselves (crowd albums). Not biometric. */
    uploads: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `POST /v1/events/:slug/consent/withdraw` (the participant, for themselves).
 * `confirm` must be the literal true: a withdrawal deletes data and is never a side effect
 * of a stray request.
 */
export const consentWithdrawBodySchema = z
  .object({ confirm: z.literal(true) })
  .strict();

/** `POST /v1/admin/participants/:id/consent/withdraw` (an admin, on request of the person). */
export const adminConsentWithdrawBodySchema = z
  .object({
    eventId: z.string().uuid(),
    /** Free text kept in the audit row: how the request arrived (e-mail, help desk, phone). */
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

/** What was removed. The same shape for the participant route and the admin one. */
export const consentWithdrawResponseSchema = z
  .object({
    withdrawnAt: z.string().datetime(),
    deleted: z
      .object({
        consents: z.number().int().nonnegative(),
        gallery: z.boolean(),
        galleryItems: z.number().int().nonnegative(),
        selfieVector: z.boolean(),
        anchors: z.number().int().nonnegative(),
        faceVectors: z.number().int().nonnegative(),
        selfieObjects: z.number().int().nonnegative(),
        feedback: z.number().int().nonnegative(),
        matchRuns: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const retentionOutcomeSchema = z.enum(["enqueued", "failed"]);

/**
 * `GET /v1/admin/retention/schedule` — one row per event for the admin status screen:
 * when the scheduler last enqueued a run, when the next window opens, how the last job
 * ended, and whether anything deserves an alarm.
 */
export const adminRetentionScheduleResponseSchema = z
  .object({
    /** The scheduler runs inside the worker; false = RETENTION_SCHEDULER is off. */
    enabled: z.boolean(),
    windowSeconds: z.number().int().positive(),
    events: z.array(
      z
        .object({
          eventId: z.string().uuid(),
          slug: z.string().min(1),
          retentionDays: z.number().int().positive(),
          lastRunAt: z.string().datetime().nullable(),
          /** Start of the window the last run belonged to. */
          windowStart: z.string().datetime().nullable(),
          nextRunAt: z.string().datetime(),
          runs: z.number().int().nonnegative(),
          outcome: retentionOutcomeSchema.nullable(),
          jobId: z.string().uuid().nullable(),
          jobStatus: z.enum(["queued", "running", "done", "error"]).nullable(),
          jobError: z.string().nullable(),
          jobFinishedAt: z.string().datetime().nullable(),
          /** Null when nothing is wrong; otherwise why (`failed`, `job_error`, `skipped`, `never`). */
          alarm: z.enum(["failed", "job_error", "skipped", "never"]).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- hardening v6 (agent H) ---------------------------------------------------------------

/**
 * A password-reset token is NOT a magic link (migration 016). It is single use, bound to one
 * account and deliberately shorter-lived than a login link (20 min): it is the one token
 * whose holder can take the account for good, so the window in which an intercepted mail is
 * still worth something is the first thing to shrink.
 */
export const PASSWORD_RESET_TTL_SECONDS = 15 * 60;
/** Reset links per account / per IP, counted over this window (`PASSWORD_RESET_PER_*`). */
export const PASSWORD_RESET_RATE_LIMIT = { windowSeconds: 60 * 60 } as const;

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
 * It is also PER EVENT, and the text says so. The opt-in lives on `event_members.taggable`,
 * not on `users`: a global flag would mean consenting once, at one event, to being nameable
 * at every event the deployment ever runs, which would make the words below a false
 * statement the day a second event exists.
 *
 * Bump the version whenever the text changes: a stored version older than this one means the
 * participant consented to different words and has to be asked again.
 */
export const TAG_CONSENT_TEXT_VERSION = "2026-10-09";
export const TAG_CONSENT_TEXT =
  "Acconsento che gli altri partecipanti di questo evento associno il nome che ho scelto alle foto in cui compaio. Vale solo per questo evento. Posso rimuovere ogni tag e disattivare i tag in qualsiasi momento: disattivandoli, i tag che ho già in questo evento vengono rimossi. Questo consenso è separato dal riconoscimento del volto e non lo richiede.";

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
