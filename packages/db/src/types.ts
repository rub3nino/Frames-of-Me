import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";

export type ImageContentType = "image/jpeg" | "image/png";

export class DuplicateKeyError extends Error {
  constructor() {
    super("duplicate key");
    this.name = "DuplicateKeyError";
  }
}

export type EventAccess = "open" | "list";

export type GalleryItemSource = "match" | "attach";

/** Whether the original bytes of a photo have arrived (`pending` while only the web stage is in). */
export type OriginalStatus = "pending" | "present";

export type UploadStage = "original" | "web";

export type UserRow = {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
};

export type EventRow = {
  id: string;
  slug: string;
  name: string;
  retentionDays: number;
  access: EventAccess;
  createdAt: Date;
};

export type PhotoRow = {
  id: string;
  eventId: string;
  photographerId: string;
  sha256: string;
  status: PhotoStatus;
  originalKey: string;
  contentType: ImageContentType;
  bytes: number;
  originalStatus: OriginalStatus;
  indexedAt: Date | null;
  error: string | null;
  createdAt: Date;
};

export type UploadSessionRow = {
  id: string;
  eventId: string;
  photographerId: string;
  s3UploadId: string | null;
  objectKey: string;
  sha256: string;
  contentType: ImageContentType;
  status: "open" | "completed" | "aborted";
  bytes: number | null;
  stage: UploadStage;
  /** Set on the original stage of a web-first photo (the photo already exists). */
  photoId: string | null;
  /** Web stage only: what the original will be (`photos.content_type` / `photos.bytes`). */
  originalContentType: ImageContentType | null;
  originalBytes: number | null;
  createdAt: Date;
};

export type GalleryItemRow = {
  photoId: string;
  faceId: string;
  score: number;
};

export type GalleryPageItem = {
  photoId: string;
  score: number;
  source: GalleryItemSource;
  createdAt: Date;
  thumbKey: string;
  webKey: string;
  /** False while `photos.original_status = 'pending'`. */
  originalReady: boolean;
};

export type GalleryCursor = { score: number; photoId: string };

export type GalleryPage = { total: number; items: GalleryPageItem[] };

export type AnchoredGallery = {
  id: string;
  userId: string;
  anchorFaceIds: string[];
  notifiedAt: Date | null;
};

export type UploadCursor = { createdAt: Date; id: string };

export type PhotosByStatus = Record<PhotoStatus, number>;

export type UploadSummary = {
  sessions: { open: number; completed: number; aborted: number };
  photos: PhotosByStatus & { originalsPending: number };
};

export type StaleUpload = { id: string; objectKey: string; s3UploadId: string | null };

export type Metrics = {
  events: number;
  photos: number;
  faces: number;
  users: number;
  jobsQueued: number;
  jobsRunning: number;
  jobsError: number;
  photosByStatus: PhotosByStatus;
  galleries: number;
  originalsPending: number;
};

export type EnqueueJobOptions = {
  priority?: number;
  dedupeKey?: string;
  runAfter?: Date;
};

export type ClaimedJob = {
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
};

export type BBox = { x: number; y: number; width: number; height: number };

export type FaceInsert = {
  externalId: string;
  bbox: BBox;
  confidence: number;
};

export interface Database {
  seedDemo(): Promise<void>;
  ping(): Promise<void>;
  findEventBySlug(slug: string): Promise<EventRow | null>;
  findEventById(id: string): Promise<EventRow | null>;
  updateEvent(
    id: string,
    patch: { access?: EventAccess; retentionDays?: number },
  ): Promise<EventRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  findUserByEmailRole(email: string, role: Role): Promise<UserRow | null>;
  createUser(input: { id?: string; email: string; role: Role }): Promise<UserRow>;
  insertUser(email: string, role: Role): Promise<UserRow>;
  insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
  }): Promise<void>;
  countMagicLinksSince(input: { email?: string; ip?: string; since: Date }): Promise<number>;
  consumeMagicLink(tokenHash: string): Promise<{ email: string; role: Role } | null>;
  insertSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  findUserBySession(tokenHash: string): Promise<UserRow | null>;
  deleteSession(tokenHash: string): Promise<void>;
  insertConsent(input: {
    userId: string;
    eventId: string;
    textVersion: string;
    ip: string;
    userAgent: string;
  }): Promise<{ id: string; grantedAt: Date }>;
  hasActiveConsent(userId: string, eventId: string): Promise<boolean>;
  countMatchJobsSince(userId: string, since: Date): Promise<number>;
  findPhotoBySha(eventId: string, sha256: string): Promise<PhotoRow | null>;
  /** Like `findPhotoBySha`, restricted to the caller's own photos. */
  findOwnPhotoBySha(photographerId: string, eventId: string, sha256: string): Promise<PhotoRow | null>;
  insertUploadSession(input: {
    id: string;
    eventId: string;
    photographerId: string;
    s3UploadId: string | null;
    objectKey: string;
    sha256: string;
    contentType: ImageContentType;
    bytes: number;
    /** Defaults to `original`. */
    stage?: UploadStage;
    photoId?: string | null;
    originalContentType?: ImageContentType | null;
    originalBytes?: number | null;
  }): Promise<void>;
  findUploadSession(id: string): Promise<UploadSessionRow | null>;
  markUploadSession(id: string, status: "completed" | "aborted"): Promise<boolean>;
  listUploadSessions(photographerId: string, eventId: string): Promise<UploadSessionRow[]>;
  /** Newest first (`created_at desc, id desc`). `nextCursor` is null on the last page. */
  listUploadSessionsPage(
    photographerId: string,
    eventId: string,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: UploadSessionRow[]; nextCursor: UploadCursor | null }>;
  uploadSummary(photographerId: string, eventId: string): Promise<UploadSummary>;
  /** Open sessions older than the cutoff become `aborted`; returns what was aborted. */
  abortStaleUploads(input: { olderThan: Date }): Promise<StaleUpload[]>;
  insertPhoto(input: {
    id: string;
    eventId: string;
    photographerId: string;
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
    /** Defaults to `present`. */
    originalStatus?: OriginalStatus;
  }): Promise<PhotoRow>;
  findPhoto(id: string): Promise<PhotoRow | null>;
  setOriginalStatus(photoId: string, status: OriginalStatus): Promise<void>;
  /** Sets or clears `photos.error` without touching the status. */
  setPhotoErrorText(photoId: string, error: string | null): Promise<void>;
  listPhotosByPhotographer(photographerId: string): Promise<PhotoRow[]>;
  setPhotoStatus(id: string, status: PhotoStatus): Promise<void>;
  /** `indexed` + `indexed_at = now()`. */
  setPhotoIndexed(id: string): Promise<void>;
  /** `error` + the reason. */
  setPhotoError(id: string, error: string): Promise<void>;
  listPhotosCreatedBefore(eventId: string, cutoff: Date, limit?: number): Promise<PhotoRow[]>;
  countPhotos(eventId: string): Promise<number>;
  listPhotosByIds(ids: string[]): Promise<PhotoRow[]>;
  /** Photos among `photoIds` that are in the caller's gallery for the event. One query. */
  listOwnedPhotos(userId: string, eventId: string, photoIds: string[]): Promise<PhotoRow[]>;
  upsertDerivative(input: {
    photoId: string;
    kind: "thumb" | "web";
    s3Key: string;
  }): Promise<void>;
  listDerivatives(photoId: string): Promise<Array<{ kind: "thumb" | "web"; s3Key: string }>>;
  listDerivativeKeys(photoIds: string[]): Promise<string[]>;
  replaceFaces(photoId: string, eventId: string, faces: FaceInsert[]): Promise<void>;
  listExternalIds(photoId: string): Promise<string[]>;
  listExternalIdsForPhotos(photoIds: string[]): Promise<string[]>;
  findFaceRowsByPhoto(photoId: string): Promise<Array<{ id: string; externalId: string }>>;
  findFaceByExternalId(
    eventId: string,
    externalId: string,
  ): Promise<{ id: string; photoId: string } | null>;
  findFacesByExternalIds(
    eventId: string,
    externalIds: string[],
  ): Promise<Array<{ id: string; photoId: string; externalId: string }>>;
  /** Rewrites the gallery with `source = 'match'` items; sets anchors, matched_at and notified_at to now. */
  replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
    anchors: string[],
  ): Promise<void>;
  listGallery(userId: string, eventId: string): Promise<GalleryItemRow[]>;
  findGalleryByUser(
    userId: string,
    eventId: string,
  ): Promise<{ id: string; anchorFaceIds: string[]; matchedAt: Date | null } | null>;
  /** Items ordered by `score desc, photo_id asc`, keyset from `cursor`. Items missing a derivative are skipped. */
  listGalleryPage(
    userId: string,
    eventId: string,
    input: { limit: number; cursor?: GalleryCursor },
  ): Promise<GalleryPage>;
  /** How many galleries of the event have at least one anchor (attach is a no-op when zero). */
  countAnchoredGalleries(eventId: string): Promise<number>;
  /** Galleries of the event whose anchors overlap `externalFaceIds`. */
  findGalleriesByAnchors(eventId: string, externalFaceIds: string[]): Promise<AnchoredGallery[]>;
  /** Upsert keeping the greatest score. Returns how many rows were new. */
  addGalleryItems(
    galleryId: string,
    items: Array<{ photoId: string; faceId: string; score: number; source: GalleryItemSource }>,
  ): Promise<number>;
  markGalleryNotified(galleryId: string, at: Date): Promise<void>;
  /** Drops the given external ids from every anchor array of the event. */
  removeAnchors(eventId: string, externalFaceIds: string[]): Promise<void>;
  latestMatchJob(
    userId: string,
    eventId: string,
  ): Promise<{ status: "queued" | "running" | "done" | "error" } | null>;
  deletePhoto(photoId: string): Promise<void>;
  deleteParticipant(userId: string): Promise<boolean>;
  insertInvite(input: {
    email: string;
    eventId: string;
    tokenHash: string;
    role: Role;
    expiresAt: Date;
  }): Promise<string>;
  /** Marks an unused, unexpired invite as used and returns it; null otherwise. */
  consumeInvite(tokenHash: string): Promise<{ email: string; role: Role; eventId: string } | null>;
  addEventPhotographer(eventId: string, userId: string): Promise<void>;
  isEventPhotographer(eventId: string, userId: string): Promise<boolean>;
  /** Returns how many emails were new for the event. */
  upsertEventParticipants(eventId: string, emails: string[]): Promise<number>;
  isEventParticipant(eventId: string, email: string): Promise<boolean>;
  insertAudit(input: {
    actorId: string | null;
    action: string;
    target: string;
    meta: Record<string, unknown>;
  }): Promise<void>;
  metrics(): Promise<Metrics>;
  /** With a `dedupeKey` that already has a queued/running job, returns that job's id and inserts nothing. */
  enqueueJob(type: JobType, payload: unknown, opts?: EnqueueJobOptions): Promise<string>;
  claimJob(): Promise<ClaimedJob | null>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string): Promise<"queued" | "error">;
  /** Immediate terminal failure: `error`, `attempts = JOB_MAX_ATTEMPTS`. */
  failJobTerminal(id: string, error: string): Promise<void>;
  /** Return a job to queued without incrementing attempts. */
  requeueJob(id: string, error: string): Promise<void>;
  /** Deletes `done` jobs created before the cutoff; returns how many. */
  pruneJobs(input: { doneOlderThan: Date }): Promise<number>;
}
