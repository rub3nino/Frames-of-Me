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
