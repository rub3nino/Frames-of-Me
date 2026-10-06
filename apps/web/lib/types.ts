export type Role = "participant" | "photographer" | "admin";

export type User = {
  id: string;
  email: string;
  role: Role;
};

export type EventInfo = {
  id: string;
  slug: string;
  name: string;
  retentionDays: number;
};

export type GalleryStatus = "empty" | "queued" | "ready";

export type GalleryItem = {
  photoId: string;
  thumbUrl: string;
  webUrl: string;
  score: number;
};

export type GalleryResponse = {
  status: GalleryStatus;
  items: GalleryItem[];
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

export type UploadListItem = {
  id: string;
  objectKey: string;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
  status: "open" | "completed" | "aborted";
  createdAt: string;
};

export type AdminMetrics = {
  events: number;
  photos: number;
  faces: number;
  users: number;
  jobsQueued: number;
};
