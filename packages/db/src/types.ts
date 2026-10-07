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

  // ---- tagging v6 (agent E): users.taggable / display_name, photo_tags -------------------
  /** The caller's own tagging profile (`users.taggable`, `users.display_name`). */
  findTagProfile(userId: string): Promise<TagProfileRow | null>;
  /**
   * The opt-in. `taggable = true` without a display name is refused here, not only in the
   * API: a taggable row with no name could never be found by the autocomplete anyway, and
   * leaving it possible invites a later "fall back to the e-mail" patch.
   *
   * `consentTextVersion` is the tagging consent text the participant accepted; it is stamped
   * with the time on an opt-in and nulled on an opt-out.
   */
  setTagProfile(
    userId: string,
    input: {
      taggable: boolean;
      displayName?: string | null;
      consentTextVersion?: string | null;
    },
  ): Promise<TagProfileRow | null>;
  /**
   * The username autocomplete. Deliberately narrow, and it must stay that way:
   * only `taggable = true` users with a display name, only a **prefix** match on
   * `lower(display_name)`, and the rows carry no e-mail address at all. `prefix` is never
   * allowed to be shorter than `TAG_SEARCH_MIN_CHARS`; the API refuses first, and this
   * method returns `[]` as a second line of defence rather than trusting the caller.
   *
   * It does NOT require a recognition consent for the event. `users.taggable` is the consent
   * for tagging; a crowd-album participant never grants recognition consent (decision 2) and
   * tagging is the only way they can find themselves in a non-biometric album.
   */
  searchTaggableUsers(input: {
    prefix: string;
    limit: number;
  }): Promise<TaggableUserRow[]>;
  /**
   * Creates an active tag in ONE statement whose `where` carries the opt-in, so a user who
   * is not taggable can never be tagged even under a concurrent opt-out. Returns null when
   * the target is not taggable, or when a row for (photoId, userId) already exists —
   * including one in state 'removed', which is how a refused tag stays refused.
   */
  insertPhotoTag(input: {
    photoId: string;
    userId: string;
    taggedBy: string;
  }): Promise<PhotoTagRow | null>;
  findPhotoTag(photoId: string, userId: string): Promise<PhotoTagRow | null>;
  /** Moves an active tag to 'removed'. Null when there was no active tag to remove. */
  removePhotoTag(photoId: string, userId: string): Promise<PhotoTagRow | null>;
  /** Every still-active tag of a user, for the audited cascade behind an opt-out. */
  listActivePhotoTagsForUser(userId: string): Promise<PhotoTagRow[]>;
  /** "The photos I am tagged in", for one event, newest first. Active tags only. */
  listTaggedPhotosForUser(userId: string, eventId: string): Promise<TaggedPhotoRow[]>;
  /** Active tags on one photo, display names only. */
  listPhotoTags(photoId: string): Promise<PhotoTagWithNameRow[]>;
  /** Reads `audit_log` back by target. Used by the tagging tests and by support. */
  listAuditForTarget(target: string): Promise<AuditEntryRow[]>;
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

// ---- tagging v6 (agent E) -----------------------------------------------------------------

/** `photo_tags.state` (migration 013). 'removed' is terminal. */
export type PhotoTagState = "active" | "removed";

/** The caller's own opt-in state. Carries no other user's data. */
export type TagProfileRow = {
  userId: string;
  taggable: boolean;
  displayName: string | null;
  /**
   * The tagging consent text accepted at opt-in (`users.taggable_consent_version`), and when.
   * Null while the user is not taggable. This is the tagging consent, NOT the recognition
   * consent in `consents` — tagging never requires a `consents` row (decision 2: a crowd
   * album is never biometric, so its participants never grant recognition consent).
   */
  consentTextVersion: string | null;
  consentAt: Date | null;
};

/**
 * One autocomplete suggestion. There is no `email` field and there must never be one: the
 * whole point of `display_name` is that this row can be handed to another participant.
 */
export type TaggableUserRow = {
  userId: string;
  displayName: string;
};

export type PhotoTagRow = {
  photoId: string;
  userId: string;
  taggedBy: string | null;
  state: PhotoTagState;
  createdAt: Date;
};

/** A tag on a photo as the other participants may see it: a display name, never an e-mail. */
export type PhotoTagWithNameRow = PhotoTagRow & { displayName: string | null };

/** A photo the caller is tagged in, with the keys the API presigns. */
export type TaggedPhotoRow = {
  photoId: string;
  eventId: string;
  thumbKey: string;
  webKey: string;
  taggedBy: string | null;
  createdAt: Date;
};

export type AuditEntryRow = {
  id: string;
  actorId: string | null;
  action: string;
  target: string;
  meta: Record<string, unknown>;
  createdAt: Date;
};

/**
 * The shortest prefix `searchTaggableUsers` will act on, in BOTH implementations. It mirrors
 * `TAG_SEARCH_MIN_CHARS` in `@rephoto/contracts`, and the duplication is deliberate: the
 * database layer refuses a short query on its own, so the guarantee does not rest on an
 * API-layer check that a later refactor could move or drop. With 6 000 participants a
 * one- or two-character query is a roster dump, not a search.
 */
export const TAG_SEARCH_MIN_PREFIX = 3;

/** Longest display name accepted; the API validates the same bound before it gets here. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

/** Collapses whitespace and turns an empty name into null, so `''` can never be stored. */
export function normalizeDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `users.taggable_consent_version` / `taggable_consent_at` after an opt-in or an opt-out, in
 * BOTH implementations. An opt-out clears the pair; an opt-in keeps the existing timestamp
 * while the accepted version is unchanged, and re-stamps it when the version moves (a new
 * Italian text is a new consent, with its own date).
 */
export function nextTagConsent(
  current: { consentTextVersion: string | null; consentAt: Date | null },
  input: { taggable: boolean; consentTextVersion?: string | null },
  now: Date = new Date(),
): { version: string | null; at: Date | null } {
  if (!input.taggable) return { version: null, at: null };
  const version = input.consentTextVersion ?? current.consentTextVersion;
  if (!version) return { version: null, at: null };
  const unchanged = version === current.consentTextVersion && current.consentAt !== null;
  return { version, at: unchanged ? current.consentAt : now };
}
