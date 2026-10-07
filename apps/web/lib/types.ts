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
};

export type GalleryResponse = {
  status: GalleryStatus;
  total: number;
  items: GalleryItem[];
  nextCursor: string | null;
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
