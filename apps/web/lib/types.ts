export type Role = "participant" | "photographer" | "admin";

export type User = {
  id: string;
  email: string;
  role: Role;
};

export type EventAccess = "open" | "list";

export type EventInfo = {
  id: string;
  slug: string;
  name: string;
  retentionDays: number;
  access: EventAccess;
};

export type EventPatchBody = {
  access?: EventAccess;
  retentionDays?: number;
};

export type GalleryStatus = "empty" | "queued" | "ready";

export type GalleryItemSource = "match" | "attach";

export type GalleryItem = {
  photoId: string;
  thumbUrl: string;
  webUrl: string;
  score: number;
  source: GalleryItemSource;
  createdAt: string;
  /** False while only the 1600 px web version is on the server (two-stage upload). */
  originalReady?: boolean;
  /** v5: the participant's verdict; `not_me` items are shown under "Nascoste". */
  feedback?: FeedbackVerdict | null;
};

export type GalleryResponse = {
  status: GalleryStatus;
  total: number;
  items: GalleryItem[];
  nextCursor: string | null;
  /** v5: why the last match left the gallery empty (absent on v4 servers). */
  reason?: GalleryReason | null;
};

export type DownloadVariant = "original" | "web";

export type GalleryDownloadBody = {
  photoIds: string[];
  variant: DownloadVariant;
};

export type GalleryDownloadResponse = {
  urls: { photoId: string; url: string }[];
};

export type PublicGalleryItem = {
  photoId: string;
  thumbUrl: string;
  webUrl: string;
  createdAt: string;
  originalReady: boolean;
};

export type PublicGalleryResponse = {
  items: PublicGalleryItem[];
  nextCursor: string | null;
};

export type UploadMode = "single" | "multipart";

export type UploadInitResponse = {
  id: string;
  objectKey: string;
  mode: UploadMode;
  url?: string;
  partSize?: number;
};

export type UploadCompleteResponse = {
  photoId: string;
  status: "uploaded" | "original_received";
};

export type OriginalStatus = "pending" | "present";

/** GET /v1/uploads/lookup?eventId=&sha256= (404 when unknown). */
export type UploadLookupResponse = {
  photoId: string;
  originalStatus: OriginalStatus;
  status: "uploaded" | "processing" | "indexed" | "error";
};

export type UploadListItem = {
  id: string;
  objectKey: string;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
  status: "open" | "completed" | "aborted";
  createdAt: string;
};

export type UploadListResponse = {
  uploads: UploadListItem[];
  nextCursor: string | null;
};

export type PhotosByStatus = {
  uploaded: number;
  processing: number;
  indexed: number;
  error: number;
};

export type UploadSummary = {
  sessions: { open: number; completed: number; aborted: number };
  /** `originalsPending`: web-first photos whose original has not arrived yet (v3). */
  photos: PhotosByStatus & { originalsPending?: number };
};

export type AdminMetrics = {
  events: number;
  photos: number;
  faces: number;
  users: number;
  jobsQueued: number;
  jobsRunning: number;
  jobsError: number;
  photosByStatus: PhotosByStatus;
  galleries: number;
};

export type ParticipantsImportResponse = {
  inserted: number;
};

// ---- admin and participant tooling v5 (agent D) ------------------------------------------

export type FeedbackVerdict = "me" | "not_me";

/** Why the last match left the gallery empty; null after a successful match. */
export type GalleryReason =
  | "no_face"
  | "face_too_small"
  | "low_quality"
  | "multiple_faces"
  | "no_photos_yet"
  | "liveness";

export type GalleryFeedbackResponse = {
  photoId: string;
  verdict: FeedbackVerdict;
};

export type AdminEvent = EventInfo & {
  createdAt: string;
  photos: number;
  galleries: number;
  participants: number;
  photographers: number;
};

export type AdminEventsResponse = { events: AdminEvent[] };

export type AdminMagicLinkResponse = { url: string };

export type AdminGalleryItem = {
  photoId: string;
  faceId: string;
  thumbUrl: string;
  webUrl: string;
  score: number;
  source: GalleryItemSource;
  createdAt: string;
  originalReady: boolean;
  feedback: FeedbackVerdict | null;
  photo: { sha256: string; filename: string | null };
};

export type AdminGalleryByEmail = {
  user: User;
  gallery: {
    id: string;
    matchedAt: string | null;
    anchorFaceIds: string[];
    reason: GalleryReason | null;
    total: number;
  } | null;
  items: AdminGalleryItem[];
};

export type AdminGalleryListRow = {
  userId: string;
  email: string;
  total: number;
  matchedAt: string | null;
  reason: GalleryReason | null;
};

export type AdminGalleriesList = {
  galleries: AdminGalleryListRow[];
  nextCursor: string | null;
};

export type BBox = { x: number; y: number; width: number; height: number };

export type AdminPhoto = {
  id: string;
  eventId: string;
  photographerId: string;
  sha256: string;
  status: "uploaded" | "processing" | "indexed" | "error";
  contentType: "image/jpeg" | "image/png";
  bytes: number;
  originalStatus: OriginalStatus;
  indexedAt: string | null;
  error: string | null;
  createdAt: string;
  filename: string | null;
  tags: string[];
};

export type AdminPhotoDetail = {
  photo: AdminPhoto;
  webUrl: string | null;
  thumbUrl: string | null;
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

export type AdminNeighbour = {
  externalFaceId: string;
  photoId: string;
  cosine: number;
  similarity: number;
};

export type AdminPhotosResponse = {
  photos: Array<AdminPhoto & { thumbUrl: string | null }>;
  nextCursor: string | null;
};

export type AdminMatchRun = {
  id: string;
  userId: string;
  email: string;
  liveness: string | null;
  reason: string | null;
  selfieSha256: string | null;
  selfieFaces: number | null;
  engineMs: number | null;
  hits: number;
  createdAt: string;
  kept: number;
  maxCosine: number | null;
};

export type AdminMatchRunsResponse = {
  runs: AdminMatchRun[];
  nextCursor: string | null;
};

export type AdminMetricsV5 = AdminMetrics & {
  originalsPending?: number;
  jobsByType: Array<{
    type: string;
    queued: number;
    running: number;
    error: number;
    oldestQueuedSeconds: number | null;
  }>;
  oldestQueuedSeconds: number | null;
  lastErrors: Array<{ id: string; type: string; error: string; at: string }>;
  faceService: { ok: boolean | null; ms: number | null };
};
// ---- admin console v6 (agent D) -----------------------------------------------------------

export type AlbumKind = "official" | "crowd";
export type AlbumModeration = "pre" | "post" | "off";
export type AlbumVisibility = "participants" | "link" | "staff";

export type Album = {
  id: string;
  eventId: string;
  slug: string;
  name: string;
  kind: AlbumKind;
  recognition: boolean;
  moderation: AlbumModeration;
  visibility: AlbumVisibility;
  maxPhotosPerUser: number | null;
  uploadsOpen: boolean;
  retentionDays: number | null;
  /** Set by the album's first photo: `recognition` is read-only from then on. */
  firstUploadAt: string | null;
  createdAt: string;
};

export type AlbumsResponse = { albums: Album[] };
export type AlbumResponse = { album: Album };

export type EventCodeStatus = "active" | "expired" | "exhausted";

export type AdminEventCode = {
  eventId: string;
  code: string;
  label: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  status: EventCodeStatus;
};

export type AdminEventCodesResponse = { codes: AdminEventCode[] };
export type AdminEventCodeResponse = { code: AdminEventCode };

export type AlbumPhotographer = { userId: string; email: string; createdAt: string };

export type AlbumPhotographersResponse = {
  photographers: AlbumPhotographer[];
  /** False while the album has no list: every photographer of the event may upload. */
  restricted: boolean;
};

export type AdminEventStatus = {
  event: { id: string; slug: string; name: string };
  photos: number;
  photosByStatus: PhotosByStatus;
  originalsPending: number;
  faces: number;
  galleries: number;
  galleriesMatched: number;
  selfiesWaiting: number;
  matchJobsPending: number;
  albums: Array<{
    id: string;
    slug: string;
    name: string;
    kind: AlbumKind;
    recognition: boolean;
    moderation: AlbumModeration;
    uploadsOpen: boolean;
    photos: number;
    firstUploadAt: string | null;
  }>;
  jobsByType: Array<{
    type: string;
    queued: number;
    running: number;
    error: number;
    oldestQueuedSeconds: number | null;
  }>;
  oldestQueuedSeconds: number | null;
  lastErrors: Array<{ id: string; type: string; error: string; at: string }>;
  faceService: { ok: boolean | null; ms: number | null };
  at: string;
};

export type AdminParticipantLookup = {
  user: User & { createdAt: string };
  consent: { active: boolean; canRevoke: boolean };
  onParticipantList: boolean;
  emailVerifiedAt: string | null;
  gallery: {
    id: string;
    matchedAt: string | null;
    reason: string | null;
    hasQueryVector: boolean;
    anchors: number;
  } | null;
};

export type OpsLink = { key: string; label: string; url: string };
export type AdminOpsLinksResponse = { links: OpsLink[] };

/**
 * Moderation queue — ASSUMED shape of agent C's API (spec section C2):
 * `GET /v1/admin/moderation?albumId=&state=&cursor=` and
 * `POST /v1/admin/photos/:id/moderate { state }`. Every field but `id` is read defensively
 * by the console (see components/admin/moderation.tsx), so a different field name from C
 * degrades the screen instead of breaking it.
 */
export type ModerationState = "pending" | "approved" | "rejected" | "auto_rejected";

export type ModerationQueueItem = {
  id: string;
  /**
   * What the shipped route actually calls the id (`GET /v1/admin/moderation` answers
   * `{ items: [{ photoId, ... }] }`). `itemsOf` in components/admin/moderation.tsx
   * normalises it onto `id`, so both spellings work.
   */
  photoId?: string;
  uploaderId?: string;
  /** Distinct open reports whose reason COUNTS: the api's own number. */
  openReports?: number;
  /** Open `not_me` reports, reported but never counted. */
  notMeReports?: number;
  /** The distinct reasons behind those reports, when the api sends no per-report rows. */
  reasons?: string[];
  albumId?: string;
  moderationState?: ModerationState;
  createdAt?: string;
  thumbUrl?: string | null;
  webUrl?: string | null;
  filename?: string | null;
  photographerId?: string;
  reports?: Array<{ reason: string; note?: string | null; createdAt?: string }>;
  reportCount?: number;
};

export type ModerationQueueResponse = {
  photos?: ModerationQueueItem[];
  items?: ModerationQueueItem[];
  nextCursor?: string | null;
};

// ---- crowd upload and moderation v6 (agent C) --------------------------------------------

/**
 * `POST /v1/uploads/init` and `POST /v1/albums/:id/uploads/init` answer this with 200 when
 * the same sha256 is already in the target album. Dedup is per album since migration 009,
 * and a re-forwarded WhatsApp image is an answer, not an error.
 */
export type AlbumUploadDedupeResponse = {
  status: "already-uploaded";
  photoId: string;
  albumId: string;
};

export type ReportReason = "inappropriate" | "not_me" | "copyright" | "other";

export type AlbumPhoto = {
  id: string;
  albumId: string;
  uploaderId: string;
  createdAt: string;
  thumbUrl: string;
  webUrl: string;
  mine: boolean;
};

export type AlbumPhotosResponse = {
  photos: AlbumPhoto[];
  nextCursor: string | null;
  quota: { used: number; max: number | null };
};

export type CrowdUploadCompleteResponse = {
  photoId: string;
  status: "uploaded" | "auto_rejected";
  moderationState?: ModerationState;
};

export type ReportResponse = {
  status: "recorded" | "already-reported";
  state: ModerationState;
  /** Counting reasons only: a `not_me` report never moves this number. */
  openReports: number;
  /** False for `not_me`: recorded and shown to moderators, never counted. */
  counts: boolean;
  /** True when the report hid the photo in the caller's own match gallery. */
  hiddenForYou: boolean;
};

export type ModerationItem = {
  photoId: string;
  albumId: string;
  eventId: string;
  uploaderId: string;
  moderationState: ModerationState;
  createdAt: string;
  openReports: number;
  reasons: ReportReason[];
  notMeReports: number;
  thumbUrl: string | null;
  webUrl: string | null;
};

export type ModerationResponse = {
  items: ModerationItem[];
  nextCursor: string | null;
};

export type ModerateResponse = {
  photoId: string;
  state: ModerationState;
  purged: boolean;
};

// ---- privacy and retention v6 (agent G) ---------------------------------------------------

/** GET /v1/events/:slug/privacy (privacyStateResponseSchema). */
export type PrivacyState = {
  event: { slug: string; name: string };
  consent: { grantedAt: string; textVersion: string } | null;
  withdrawnAt: string | null;
  gallery: {
    photos: number;
    selfieVector: boolean;
    anchors: number;
    matchedAt: string | null;
  } | null;
  uploads: number;
};

/** POST /v1/events/:slug/consent/withdraw and the admin twin (consentWithdrawResponseSchema). */
export type ConsentWithdrawResponse = {
  withdrawnAt: string;
  deleted: {
    consents: number;
    gallery: boolean;
    galleryItems: number;
    selfieVector: boolean;
    anchors: number;
    faceVectors: number;
    selfieObjects: number;
    feedback: number;
    matchRuns: number;
  };
};

/** GET /v1/admin/retention/schedule (adminRetentionScheduleResponseSchema). */
export type AdminRetentionSchedule = {
  enabled: boolean;
  windowSeconds: number;
  events: Array<{
    eventId: string;
    slug: string;
    retentionDays: number;
    lastRunAt: string | null;
    windowStart: string | null;
    nextRunAt: string;
    runs: number;
    outcome: "enqueued" | "failed" | null;
    jobId: string | null;
    jobStatus: "queued" | "running" | "done" | "error" | null;
    jobError: string | null;
    jobFinishedAt: string | null;
    alarm: "failed" | "job_error" | "skipped" | "never" | null;
  }>;
};

// ---- tagging v6 (agent E) -----------------------------------------------------------------

/** `users.taggable` / `users.display_name`. `taggable` is false until the participant opts in. */
export type TagProfile = {
  taggable: boolean;
  displayName: string | null;
  /**
   * The tagging consent text accepted at opt-in, and when. Null while not taggable. This is
   * NOT the recognition consent on the selfie page: tagging does not require that one.
   */
  consentTextVersion: string | null;
  consentAt: string | null;
};

/**
 * One autocomplete suggestion. There is no `email` field and there must never be one: the
 * suggestion list is shown to other participants.
 */
export type TaggableUser = {
  userId: string;
  displayName: string;
};

export type TagSearchResponse = {
  items: TaggableUser[];
};

export type TaggedPhoto = {
  photoId: string;
  thumbUrl: string;
  webUrl: string;
  createdAt: string;
};

export type TagsMeResponse = {
  profile: TagProfile;
  items: TaggedPhoto[];
};

export type PhotoTag = {
  photoId: string;
  userId: string;
  displayName: string | null;
  createdAt: string;
};

export type PhotoTagsResponse = {
  items: PhotoTag[];
};
