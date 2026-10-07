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
  /** v6: the album the photo belongs to (`photos.album_id`, migration 009). */
  albumId: string;
  /** v6 (agent C): `photos.moderation_state`, migration 010. Separate from `status`. */
  moderationState: ModerationState;
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
  /** v5: carried to the photo row at complete. */
  filename: string | null;
  tags: string[];
  createdAt: Date;
  /**
   * v6 (agent C): `upload_sessions.album_id`, migration 010 — the album chosen at `init` and
   * carried to `complete`. Null only for sessions written before that migration.
   */
  albumId: string | null;
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

/** `claimJob` filter: job types this claim must skip (circuit breaker on the face service). */
export type ClaimOptions = {
  excludeTypes?: readonly JobType[];
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
  /** Sets (or resets) the staff password hash for a user. */
  setUserPassword(userId: string, passwordHash: string): Promise<void>;
  /** Looks up a user for password login, returning the stored hash (null if unset). */
  findUserForLogin(
    email: string,
    role: Role,
  ): Promise<{ user: UserRow; passwordHash: string | null } | null>;
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
    /** v5: carried to the photo row at complete. */
    filename?: string | null;
    tags?: string[];
    /** v6 (agent C): the album the bytes are destined for; the official album when absent. */
    albumId?: string | null;
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
    /** v5: client filename and free tags (`photos.filename`, `photos.tags`). */
    filename?: string | null;
    tags?: string[];
    /** v6: the album; the event's official album (`ufficiale`) when absent. */
    albumId?: string;
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
  ): Promise<{
    id: string;
    anchorFaceIds: string[];
    matchedAt: Date | null;
    /** `galleries.last_match_reason` (v5): null after a successful match. */
    reason: string | null;
    /** `galleries.selfie_key` (v5): the kept selfie object when KEEP_SELFIES is on. */
    selfieKey: string | null;
    /** True when a selfie vector is stored (`query_embedding is not null`). */
    hasQueryVector: boolean;
  } | null>;
  /** Items ordered by `score desc, photo_id asc`, keyset from `cursor`. Items missing a derivative are skipped. */
  listGalleryPage(
    userId: string,
    eventId: string,
    input: { limit: number; cursor?: GalleryCursor },
  ): Promise<GalleryPage>;
  /** How many galleries of the event have anchors or a selfie vector (attach is a no-op when zero). */
  countAnchoredGalleries(eventId: string): Promise<number>;
  /** How many galleries of the event hold a selfie vector (attach skips the vector search when zero). */
  countGalleriesWithQueryVector(eventId: string): Promise<number>;
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
  claimJob(options?: ClaimOptions): Promise<ClaimedJob | null>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string): Promise<"queued" | "error">;
  /** Immediate terminal failure: `error`, `attempts = JOB_MAX_ATTEMPTS`. */
  failJobTerminal(id: string, error: string): Promise<void>;
  /** Return a job to queued without incrementing attempts. */
  requeueJob(id: string, error: string): Promise<void>;
  /** Deletes `done` jobs created before the cutoff; returns how many. */
  pruneJobs(input: { doneOlderThan: Date }): Promise<number>;

  // ---- recognition + robustness v5 (agent A) --------------------------------------------
  /**
   * Sets the match bookkeeping of a gallery (created empty when missing): the selfie vector
   * (`query_embedding`, null clears it), `last_match_reason` and `selfie_key`. Fields left
   * `undefined` are untouched.
   */
  updateGalleryMatch(userId: string, eventId: string, patch: GalleryMatchPatch): Promise<void>;
  /**
   * Galleries of the event whose stored selfie vector has cosine ≥ `minCosine` with
   * `embedding` (pgvector `<=>` over `galleries.query_embedding`), best first, at most 50.
   */
  findGalleriesByQueryVector(
    eventId: string,
    embedding: number[],
    minCosine: number,
  ): Promise<QueryVectorGallery[]>;
  /** MATCH_LOG: one row per `match` run; returns the run id. */
  insertMatchRun(input: MatchRunInsert): Promise<string>;
  /** MATCH_LOG: every engine hit of a run (kept = it made the gallery). */
  insertMatchHits(runId: string, hits: MatchHitInsert[]): Promise<void>;
  /** Heartbeat of an in-flight job: `claimed_at = now()` so the stale reclaim leaves it alone. */
  touchJob(id: string): Promise<void>;
  /** `reset` job: drops every gallery (and items) of the event; returns how many. */
  deleteGalleriesByEvent(eventId: string): Promise<number>;
  /** KEEP_SELFIES: the `selfie_key` of every gallery of the event, so `reset` deletes the objects. */
  listGallerySelfieKeys(eventId: string): Promise<string[]>;
  /** KEEP_SELFIES: the `selfie_key` of every gallery of the user, so deleting the participant deletes the objects. */
  listGallerySelfieKeysByUser(userId: string): Promise<string[]>;
  /**
   * Retention: galleries of the event with `matched_at < cutoff` lose `query_embedding`,
   * `anchor_face_ids` and `selfie_key` (the gallery row and its items stay). Returns the
   * selfie keys that were set, so the caller deletes the objects.
   */
  expireGalleryMatches(eventId: string, cutoff: Date): Promise<string[]>;
  /** `reset` job: drops the match log of the event; returns how many runs. */
  deleteMatchRunsByEvent(eventId: string): Promise<number>;
  /**
   * Admin requeue: photos of the event in `status` (and, when given, with `error ilike
   * '%errorLike%'`) go back to `uploaded`, or `processing` when both derivatives exist;
   * `error` is cleared. Returns the photos with whether their web derivative exists, so the
   * caller enqueues `index` (web present) or `derive`.
   */
  resetPhotosForRequeue(input: {
    eventId: string;
    status: PhotoStatus;
    errorLike?: string;
  }): Promise<Array<{ id: string; webReady: boolean }>>;

  // ---- admin and participant tooling v5 (agent D) ----------------------------------------
  /** Throws DuplicateKeyError when the slug exists. */
  createEvent(input: {
    slug: string;
    name: string;
    retentionDays?: number;
    access?: EventAccess;
  }): Promise<EventRow>;
  listEventsWithCounts(): Promise<EventWithCounts[]>;
  /** The user with this email and role (default `participant`). */
  findUserByEmail(email: string, role?: Role): Promise<UserRow | null>;
  /** Galleries of the event, newest match first (`matched_at desc nulls last, user_id`). */
  listGalleriesPage(
    eventId: string,
    input: { limit: number; cursor?: GalleryListCursor },
  ): Promise<{ galleries: GalleryListRow[]; nextCursor: GalleryListCursor | null }>;
  /** Null when no participant has this email. `gallery` is null before the first match. */
  findGalleryWithItemsByEmail(eventId: string, email: string): Promise<GalleryWithItems | null>;
  findPhotoDetail(id: string): Promise<PhotoDetail | null>;
  /** Newest first (`created_at desc, id desc`), filters AND-ed; `filename` is a prefix match. */
  listPhotosAdmin(
    filters: PhotoAdminFilters,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: PhotoAdminRow[]; nextCursor: UploadCursor | null }>;
  /** `galleries.selfie_key` (set by the worker with KEEP_SELFIES); null when absent. */
  findGallerySelfieKey(userId: string, eventId: string): Promise<string | null>;
  /** Removes the gallery and its items; false when there was none. */
  deleteGallery(userId: string, eventId: string): Promise<boolean>;
  upsertFeedback(input: {
    userId: string;
    eventId: string;
    photoId: string;
    verdict: FeedbackVerdict;
    scoreAtTime: number | null;
  }): Promise<void>;
  /**
   * `photoIds` restricts the read to the photos of one gallery page; without it the whole
   * event's feedback for that user is returned. Callers rendering a page must pass the ids —
   * the gallery route reads this on every request (v6 F4).
   */
  listFeedback(
    userId: string,
    eventId: string,
    photoIds?: readonly string[],
  ): Promise<Array<{ photoId: string; verdict: FeedbackVerdict }>>;
  /** Newest first; `email` narrows to one participant. Reads agent A's match_runs/match_hits (006). */
  listMatchRuns(
    eventId: string,
    input: { email?: string; limit: number; cursor?: UploadCursor },
  ): Promise<{ runs: MatchRunRow[]; nextCursor: UploadCursor | null }>;
  exportGalleries(eventId: string): AsyncIterable<GalleryExportRow>;
  exportMatchHits(eventId: string): AsyncIterable<MatchHitExportRow>;
  exportFeedback(eventId: string): AsyncIterable<FeedbackExportRow>;
  /** Queue view by type, age of the oldest queued job and the last failures. Separate from `metrics()`. */
  metricsExtras(): Promise<MetricsExtras>;

  // ---- albums and vector isolation v6 (agent A) -------------------------------------------
  /**
   * Throws `DuplicateKeyError` when `(eventId, slug)` exists and
   * `AlbumRecognitionNotAllowedError` for `kind = 'crowd'` with `recognition = true`
   * (the database `check` is the authority; this is the typed mapping of it).
   * With `recognition = true` the album's partial vector index is created too.
   */
  createAlbum(input: AlbumInsert): Promise<AlbumRow>;
  findAlbum(id: string): Promise<AlbumRow | null>;
  findAlbumBySlug(eventId: string, slug: string): Promise<AlbumRow | null>;
  /** Oldest first (`created_at, id`). */
  listAlbums(eventId: string): Promise<AlbumRow[]>;
  /** The event's official album (`slug = 'ufficiale'`), created with the event. */
  findDefaultAlbum(eventId: string): Promise<AlbumRow | null>;
  /** Albums of the event with `recognition = true`: the only ones that ever hold vectors. */
  listRecognitionAlbumIds(eventId: string): Promise<string[]>;
  /**
   * Fields left `undefined` are untouched. Throws `AlbumRecognitionLockedError` when
   * `recognition` would change after `first_upload_at` was set, and
   * `AlbumRecognitionNotAllowedError` when the result would be a recognising crowd album.
   */
  updateAlbum(id: string, patch: AlbumPatch): Promise<AlbumRow | null>;
  /** Sets `first_upload_at` if it is still null; a no-op afterwards. */
  markAlbumFirstUpload(albumId: string, at?: Date): Promise<void>;
  /** Album-scoped dedup: the same bytes in another album are a different photo. */
  findPhotoByAlbumSha(albumId: string, sha256: string): Promise<PhotoRow | null>;

  // ---- auth v6 (agent B): identities, event codes, lazy e-mail verification -------------
  /** The user behind an external identity (`user_identities`), or null when it is unknown. */
  findUserByIdentity(provider: IdentityProvider, subject: string): Promise<UserRow | null>;
  /** Links an external identity to a user. `email` is stored only when the provider verified it. */
  insertIdentity(input: {
    userId: string;
    provider: IdentityProvider;
    subject: string;
    email: string | null;
  }): Promise<void>;
  /** Throws DuplicateKeyError when the (eventId, code) pair exists. */
  createEventCode(input: {
    eventId: string;
    code: string;
    label?: string | null;
    maxUses?: number | null;
    expiresAt?: Date | null;
  }): Promise<EventCodeRow>;
  findEventCode(eventId: string, code: string): Promise<EventCodeRow | null>;
  /**
   * Atomically takes one use of a code that exists, has not expired and is below `max_uses`.
   * Null when there is no such code — expired, exhausted and absent are indistinguishable
   * on purpose, the caller answers with one generic message.
   */
  claimEventCode(code: string): Promise<EventCodeRow | null>;
  /** Stamps `users.email_verified_at` (idempotent: an already stamped row keeps its first date). */
  markEmailVerified(userId: string, at?: Date): Promise<void>;
  findEmailVerifiedAt(userId: string): Promise<Date | null>;

  // ---- admin console v6 (agent D) -------------------------------------------------------
  /** Event codes of one event, newest first (`created_at desc, code`). */
  listEventCodes(eventId: string): Promise<EventCodeRow[]>;
  /**
   * Fields left `undefined` are untouched, `null` clears them. Null when the pair is
   * unknown. Revoking a code is `expiresAt = now()`: `claimEventCode` already refuses an
   * expired code, so nothing has to learn about a third state.
   */
  updateEventCode(
    eventId: string,
    code: string,
    patch: EventCodePatch,
  ): Promise<EventCodeRow | null>;
  /**
   * Revoking: `expires_at = now()` evaluated by the DATABASE, so there is no window in
   * which an api clock running ahead of the server keeps a revoked code alive. Null when
   * the pair is unknown. `claimEventCode` refuses an expired code in the same statement
   * that would increment `uses`, so this is the whole of revocation.
   */
  revokeEventCode(eventId: string, code: string): Promise<EventCodeRow | null>;
  /** Per-album upload authorization (migration 017). Idempotent. */
  addAlbumPhotographer(albumId: string, userId: string): Promise<void>;
  /** False when there was no such grant. */
  removeAlbumPhotographer(albumId: string, userId: string): Promise<boolean>;
  listAlbumPhotographers(albumId: string): Promise<AlbumPhotographerRow[]>;
  /**
   * Whether a photographer may upload to this album. True when the album has no explicit
   * list — the event-level `event_photographers` grant stands, which is the v5 behaviour —
   * and otherwise only for the photographers on the list. This is the seam the upload route
   * calls after `isEventPhotographer`; it never widens that check, only narrows it.
   */
  isAlbumPhotographerAllowed(albumId: string, userId: string): Promise<boolean>;
  /** Everything the live status screen of one event reads, in one call. */
  eventStatus(eventId: string): Promise<EventStatus>;
  // ---- crowd upload and moderation v6 (agent C) -----------------------------------------
  /**
   * The per-user cap of C2: how many photos this uploader already holds in the album with
   * `moderation_state in ('approved', 'pending')`. A rejected photo frees a slot, an
   * `auto_rejected` one too; a pending one does not.
   */
  countAlbumPhotosByUploader(albumId: string, uploaderId: string): Promise<number>;
  /**
   * Writes `moderation_state` and, for a human ruling, `moderated_by` / `moderated_at`.
   * `moderatorId` null is the automatic path (the screening hook, the report threshold):
   * the state moves but the two audit columns stay empty, so a queue row still reads as
   * "nobody has ruled". Null when there is no such photo.
   */
  setPhotoModeration(input: {
    photoId: string;
    state: ModerationState;
    moderatorId?: string | null;
    at?: Date;
  }): Promise<PhotoRow | null>;
  /**
   * One report per (photo, reporter) — `reports unique (photo_id, reporter_id)`. A second
   * report from the same person is `created: false` and changes nothing, which is what makes
   * the threshold count distinct people.
   *
   * The one exception: a stored `not_me` is escalated to a counting reason (`created: true`),
   * one-way. Otherwise tapping "non sono io" would silently spend the person's only report on
   * that photo; a counting reason is never replaced, so this cannot un-report anything.
   */
  insertReport(input: {
    photoId: string;
    reporterId: string;
    reason: ReportReason;
    note?: string | null;
  }): Promise<{ created: boolean; report: ReportRow }>;
  /**
   * How many DISTINCT people have an open report on the photo **whose reason counts**
   * (`MODERATION_COUNTING_REASONS`). This is the number the auto-pending threshold compares
   * against, and `not_me` is deliberately not in it — see that constant for why.
   */
  countOpenReports(photoId: string): Promise<number>;
  /** How many DISTINCT people said `not_me`. Shown to moderators, never counted. */
  countOpenNotMeReports(photoId: string): Promise<number>;
  /** Reports filed by this user since `since` (the per-user report rate limit). */
  countReportsByUserSince(reporterId: string, since: Date): Promise<number>;
  /** A moderator ruled: every open report on the photo is closed. Returns how many. */
  closeReports(photoId: string): Promise<number>;
  /** Open reports of the photo, oldest first. */
  listOpenReports(photoId: string): Promise<ReportRow[]>;
  /**
   * The staff moderation queue: photos that are not `approved`, or that carry an open report
   * **whose reason counts**, newest first (`created_at desc, id desc`). `state` narrows to
   * one moderation state, `albumId` to one album, `includeNotMe` adds the wrong-match
   * reports that are otherwise kept out so they cannot bury the queue.
   */
  listModerationPage(input: {
    albumId?: string;
    state?: ModerationState;
    /** Also queue approved photos whose only open reports are `not_me`. Off by default. */
    includeNotMe?: boolean;
    limit: number;
    cursor?: UploadCursor;
  }): Promise<{ items: ModerationItem[]; nextCursor: UploadCursor | null }>;
  /**
   * A crowd album feed: `approved` photos with both derivatives, newest first. Nothing
   * pending, rejected or auto-rejected is ever returned — that is how a photo that reached
   * the report threshold leaves the gallery.
   */
  listAlbumPhotosPage(
    albumId: string,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: AlbumPhoto[]; nextCursor: UploadCursor | null }>;
  // ---- privacy and retention scheduling v6 (agent G) -------------------------------------
  /** What the participant sees on "I miei dati", and what an admin sees for them. */
  findConsentState(userId: string, eventId: string): Promise<ConsentState>;
  /**
   * Withdraws the consent of one participant for one event and removes the biometric
   * material that identifies them, in one transaction:
   *
   * - every active `consents` row of the pair gets `withdrawn_at = now()`;
   * - the personal match gallery goes, with its `gallery_items`, its anchors and its
   *   `galleries.query_embedding` (the selfie template) — `selfieKeys` comes back so the
   *   caller can delete the kept selfie objects as well;
   * - the `face_vectors` rows of the faces the system had *identified as this person*
   *   (the gallery's anchors plus the face behind every gallery item) are deleted, and
   *   those ids are removed from the anchor arrays of every other gallery of the event so
   *   no gallery is left pointing at a template that no longer exists;
   * - their `gallery_feedback` and `match_runs` (with `match_hits`) for the event go too.
   *
   * What deliberately stays: the photos themselves and their `faces` rows (bounding box
   * and confidence, no template), the `users` row, and the withdrawn `consents` rows —
   * see docs/DPIA.md §3 bis. Re-consent is a new `consents` row and never brings a
   * deleted vector back.
   *
   * Idempotent: a second call on the same pair returns zeroes.
   */
  withdrawConsent(input: { userId: string; eventId: string }): Promise<ConsentWithdrawal>;
  /**
   * Claims the retention run of `windowStart` for one event. True exactly once per
   * (event, window) even with several workers calling at the same moment; false when this
   * window was already claimed (migration 015 explains the statement).
   */
  claimRetentionWindow(input: {
    eventId: string;
    windowStart: Date;
    windowSeconds: number;
  }): Promise<boolean>;
  /** Outcome of the claimed run, for the admin status screen and the alarm. */
  recordRetentionRun(input: {
    eventId: string;
    outcome: RetentionOutcome;
    jobId?: string | null;
    error?: string | null;
  }): Promise<void>;
  /** One row per event: the scheduler state and the last `retention` job of that event. */
  listRetentionStatus(): Promise<RetentionStatusRow[]>;
  /**
   * Takes the right to send the alarm mail of `alarm` for `window`. True exactly once per
   * (event, window, alarm kind), so a failure that lasts a week is one message per window
   * and not one per tick, and two workers never both send. A different alarm kind inside the
   * same window is new information and gets its own message.
   *
   * False when the row does not exist yet: the `never` alarm has nothing to claim, and the
   * same tick that would report it also creates the row by claiming the window.
   */
  claimRetentionAlarmMail(input: {
    eventId: string;
    alarm: RetentionAlarmMail;
    window: Date;
  }): Promise<boolean>;
  /**
   * Clears the notified alarm of an event that is healthy again and returns what it was, so
   * the caller can send one "resolved" message. Null when there was nothing to clear, which
   * is the normal case on every tick.
   */
  clearRetentionAlarmMail(eventId: string): Promise<RetentionAlarmMail | null>;
  /** Oldest first. The album-scoped form of `listPhotosCreatedBefore` (albums.retention_days). */
  listAlbumPhotosCreatedBefore(albumId: string, cutoff: Date, limit?: number): Promise<PhotoRow[]>;
  /**
   * Photos of the event this user uploaded (`photos.photographer_id`, which since v6 also
   * holds participants). Shown on "I miei dati": those photos are their own uploads, not
   * biometric data about them, and a consent withdrawal does not delete them.
   */
  countPhotosByUploader(eventId: string, userId: string): Promise<number>;
}

// ---- albums and vector isolation v6 (agent A) ---------------------------------------------

export type AlbumKind = "official" | "crowd";
/** `pre` and `post` are the moderation modes of v6 C; `off` is the v5 behaviour. */
export type AlbumModeration = "pre" | "post" | "off";
export type AlbumVisibility = "participants" | "link" | "staff";

export type AlbumRow = {
  id: string;
  eventId: string;
  slug: string;
  name: string;
  kind: AlbumKind;
  /** Face recognition applies to this album. Always false for `crowd` (database `check`). */
  recognition: boolean;
  moderation: AlbumModeration;
  visibility: AlbumVisibility;
  maxPhotosPerUser: number | null;
  uploadsOpen: boolean;
  retentionDays: number | null;
  /** Set by the first photo of the album; `recognition` is immutable from then on. */
  firstUploadAt: Date | null;
  createdAt: Date;
};

export type AlbumInsert = {
  id?: string;
  eventId: string;
  slug: string;
  name: string;
  kind: AlbumKind;
  recognition?: boolean;
  moderation?: AlbumModeration;
  visibility?: AlbumVisibility;
  maxPhotosPerUser?: number | null;
  uploadsOpen?: boolean;
  retentionDays?: number | null;
};

export type AlbumPatch = {
  name?: string;
  recognition?: boolean;
  moderation?: AlbumModeration;
  visibility?: AlbumVisibility;
  maxPhotosPerUser?: number | null;
  uploadsOpen?: boolean;
  retentionDays?: number | null;
};

/** `kind = 'crowd'` with `recognition = true`: refused by `albums_crowd_never_recognizes`. */
export class AlbumRecognitionNotAllowedError extends Error {
  constructor() {
    super("a crowd album cannot use face recognition");
    this.name = "AlbumRecognitionNotAllowedError";
  }
}

/** `recognition` changed after `albums.first_upload_at` was set (decision 3, frozen). */
export class AlbumRecognitionLockedError extends Error {
  constructor() {
    super("recognition cannot change once the album has its first upload");
    this.name = "AlbumRecognitionLockedError";
  }
}

// ---- admin and participant tooling v5 (agent D) --------------------------------------------

export type FeedbackVerdict = "me" | "not_me";

export type EventWithCounts = EventRow & {
  photos: number;
  galleries: number;
  participants: number;
  photographers: number;
};

export type GalleryListCursor = { matchedAt: Date; userId: string };

export type GalleryListRow = {
  userId: string;
  email: string;
  total: number;
  matchedAt: Date | null;
  reason: string | null;
};

export type GalleryAdminItem = GalleryPageItem & {
  faceId: string;
  sha256: string;
  filename: string | null;
  feedback: FeedbackVerdict | null;
};

export type GalleryWithItems = {
  user: UserRow;
  gallery: {
    id: string;
    matchedAt: Date | null;
    anchorFaceIds: string[];
    reason: string | null;
    total: number;
  } | null;
  items: GalleryAdminItem[];
};

export type PhotoAdminRow = PhotoRow & { filename: string | null; tags: string[] };

export type PhotoAdminFilters = {
  eventId: string;
  sha256?: string;
  filename?: string;
  status?: PhotoStatus;
  photographerId?: string;
  tag?: string;
};

export type PhotoDetail = {
  photo: PhotoAdminRow;
  faces: Array<{ id: string; externalId: string; bbox: BBox; confidence: number }>;
  galleries: Array<{
    userId: string;
    email: string;
    score: number;
    source: GalleryItemSource;
    faceId: string;
    feedback: FeedbackVerdict | null;
  }>;
};

export type MatchRunRow = {
  id: string;
  userId: string;
  email: string;
  liveness: string | null;
  reason: string | null;
  selfieSha256: string | null;
  selfieFaces: number | null;
  engineMs: number | null;
  hits: number;
  createdAt: Date;
  kept: number;
  maxCosine: number | null;
};

export type GalleryExportRow = {
  email: string;
  userId: string;
  photoId: string;
  sha256: string;
  filename: string | null;
  score: number;
  source: GalleryItemSource;
  faceId: string;
  createdAt: Date;
  feedback: FeedbackVerdict | null;
};

export type MatchHitExportRow = {
  runId: string;
  email: string;
  userId: string;
  runCreatedAt: Date;
  photoId: string;
  externalFaceId: string;
  cosine: number;
  similarity: number;
  kept: boolean;
};

export type FeedbackExportRow = {
  email: string;
  userId: string;
  photoId: string;
  sha256: string;
  filename: string | null;
  verdict: FeedbackVerdict;
  scoreAtTime: number | null;
  createdAt: Date;
};

export type MetricsExtras = {
  jobsByType: Array<{
    type: string;
    queued: number;
    running: number;
    error: number;
    oldestQueuedSeconds: number | null;
  }>;
  oldestQueuedSeconds: number | null;
  lastErrors: Array<{ id: string; type: string; error: string; at: Date }>;
};

// ---- recognition + robustness v5 (agent A) ------------------------------------------------

export type GalleryMatchPatch = {
  queryEmbedding?: number[] | null;
  lastMatchReason?: string | null;
  selfieKey?: string | null;
};

export type QueryVectorGallery = AnchoredGallery & { cosine: number };

export type MatchRunInsert = {
  userId: string;
  eventId: string;
  liveness: string | null;
  reason: string | null;
  selfieSha256: string | null;
  selfieFaces: number | null;
  engineMs: number | null;
  hits: number;
};

export type MatchHitInsert = {
  photoId: string;
  externalFaceId: string;
  cosine: number;
  similarity: number;
  kept: boolean;
};

// ---- auth v6 (agent B) --------------------------------------------------------------------

/** One provider today (`user_identities.provider` check constraint, migration 012). */
export type IdentityProvider = "google";

export type EventCodeRow = {
  eventId: string;
  code: string;
  label: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  createdAt: Date;
};

// ---- admin console v6 (agent D) -----------------------------------------------------------

export type EventCodePatch = {
  label?: string | null;
  maxUses?: number | null;
  expiresAt?: Date | null;
};

export type AlbumPhotographerRow = {
  albumId: string;
  userId: string;
  email: string;
  createdAt: Date;
};

export type EventStatusAlbum = {
  id: string;
  slug: string;
  name: string;
  kind: AlbumKind;
  recognition: boolean;
  moderation: AlbumModeration;
  uploadsOpen: boolean;
  photos: number;
  firstUploadAt: Date | null;
};

/** Per-event counters of the live status screen. Queue and job errors come from `metricsExtras`. */
export type EventStatus = {
  photos: number;
  photosByStatus: PhotosByStatus;
  originalsPending: number;
  faces: number;
  galleries: number;
  galleriesMatched: number;
  /** Galleries holding a selfie vector that have not matched yet. */
  selfiesWaiting: number;
  albums: EventStatusAlbum[];
};

// ---- crowd upload and moderation v6 (agent C) ---------------------------------------------

/**
 * `photos.moderation_state` (migration 010). SEPARATE from {@link PhotoRow.status}, which is
 * the processing pipeline: a photo can be `indexed` and `rejected`, or `error` and `approved`.
 * The two state machines are never merged.
 */
export type ModerationState = "pending" | "approved" | "rejected" | "auto_rejected";

export type ReportReason = "inappropriate" | "not_me" | "copyright" | "other";

export type ReportRow = {
  id: string;
  photoId: string;
  reporterId: string;
  reason: ReportReason;
  note: string | null;
  state: "open" | "closed";
  createdAt: Date;
};

/** One row of the staff moderation queue, with the open reports already counted. */
export type ModerationItem = {
  photoId: string;
  albumId: string;
  eventId: string;
  uploaderId: string;
  moderationState: ModerationState;
  createdAt: Date;
  /** Counting reasons only (`MODERATION_COUNTING_REASONS`): `not_me` is not in here. */
  openReports: number;
  /** Distinct reasons of every open report, `not_me` included: the moderator sees it all. */
  reasons: ReportReason[];
  /** Distinct people who said `not_me`. Shown, never counted. */
  notMeReports: number;
  thumbKey: string | null;
  webKey: string | null;
};

/** One row of a crowd album feed: only `approved` photos with both derivatives are returned. */
export type AlbumPhoto = {
  id: string;
  albumId: string;
  uploaderId: string;
  createdAt: Date;
  thumbKey: string;
  webKey: string;
};
// ---- privacy and retention scheduling v6 (agent G) ----------------------------------------

export type ConsentState = {
  /** When the still-active consent was granted; null when there is none (never given, or withdrawn). */
  grantedAt: Date | null;
  /** `consents.text_version` of the active consent. */
  textVersion: string | null;
  /** The most recent withdrawal of this pair, when there is one. */
  withdrawnAt: Date | null;
  /** The personal match gallery as it stands, or null when there is none. */
  gallery: {
    photos: number;
    /** `galleries.query_embedding is not null`: the selfie template is stored. */
    selfieVector: boolean;
    anchors: number;
    matchedAt: Date | null;
  } | null;
};

/** Counts of everything one withdrawal removed. Every field is zero on a repeated call. */
export type ConsentWithdrawal = {
  consents: number;
  galleryDeleted: boolean;
  galleryItems: number;
  /** The gallery held `query_embedding` and it was deleted with it. */
  selfieVector: boolean;
  anchors: number;
  /** Rows deleted from `face_vectors` (0 on a server without pgvector). */
  faceVectors: number;
  /**
   * The identified faces of this person, as engine ids. The caller passes them to
   * `FaceEngine.deleteFaces` as well, which is what removes them from a Rekognition
   * collection or the `face_index` of the fake engine.
   */
  externalFaceIds: string[];
  /** `galleries.selfie_key` values to delete from the object store (KEEP_SELFIES only). */
  selfieKeys: string[];
  feedback: number;
  matchRuns: number;
};

export type RetentionOutcome = "enqueued" | "failed";

export type RetentionStatusRow = {
  eventId: string;
  slug: string;
  retentionDays: number;
  /** Start of the last window the scheduler claimed for this event; null = never run. */
  windowStart: Date | null;
  windowSeconds: number | null;
  claimedAt: Date | null;
  runs: number;
  lastOutcome: RetentionOutcome | null;
  lastJobId: string | null;
  lastError: string | null;
  /** The last `retention` job of the event, whatever enqueued it (scheduler or admin). */
  lastJob: {
    id: string;
    status: "queued" | "running" | "done" | "error";
    error: string | null;
    finishedAt: Date | null;
  } | null;
};

/**
 * The alarm kinds that get an e-mail. `never` is deliberately absent: it is a screen state
 * for an event the scheduler has not reached yet, and the tick that would report it claims
 * the window anyway. It is `RetentionAlarm` of `@rephoto/contracts` minus `never`.
 */
export type RetentionAlarmMail = "failed" | "job_error" | "skipped";
