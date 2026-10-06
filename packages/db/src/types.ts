import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";

export type ImageContentType = "image/jpeg" | "image/png";

export class DuplicateKeyError extends Error {
  constructor() {
    super("duplicate key");
    this.name = "DuplicateKeyError";
  }
}

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
  createdAt: Date;
};

export type GalleryItemRow = {
  photoId: string;
  faceId: string;
  score: number;
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
  findEventBySlug(slug: string): Promise<EventRow | null>;
  findEventById(id: string): Promise<EventRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  findUserByEmailRole(email: string, role: Role): Promise<UserRow | null>;
  createUser(input: { id?: string; email: string; role: Role }): Promise<UserRow>;
  insertUser(email: string, role: Role): Promise<UserRow>;
  insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
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
  insertUploadSession(input: {
    id: string;
    eventId: string;
    photographerId: string;
    s3UploadId: string | null;
    objectKey: string;
    sha256: string;
    contentType: ImageContentType;
  }): Promise<void>;
  findUploadSession(id: string): Promise<UploadSessionRow | null>;
  markUploadSession(id: string, status: "completed" | "aborted"): Promise<boolean>;
  listUploadSessions(photographerId: string, eventId: string): Promise<UploadSessionRow[]>;
  insertPhoto(input: {
    id: string;
    eventId: string;
    photographerId: string;
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
  }): Promise<PhotoRow>;
  findPhoto(id: string): Promise<PhotoRow | null>;
  listPhotosByPhotographer(photographerId: string): Promise<PhotoRow[]>;
  setPhotoStatus(id: string, status: PhotoStatus): Promise<void>;
  listPhotosCreatedBefore(eventId: string, cutoff: Date): Promise<PhotoRow[]>;
  upsertDerivative(input: {
    photoId: string;
    kind: "thumb" | "web";
    s3Key: string;
  }): Promise<void>;
  listDerivatives(photoId: string): Promise<Array<{ kind: "thumb" | "web"; s3Key: string }>>;
  replaceFaces(photoId: string, eventId: string, faces: FaceInsert[]): Promise<void>;
  listExternalIds(photoId: string): Promise<string[]>;
  findFaceByExternalId(
    eventId: string,
    externalId: string,
  ): Promise<{ id: string; photoId: string } | null>;
  replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
  ): Promise<void>;
  listGallery(userId: string, eventId: string): Promise<GalleryItemRow[]>;
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
  insertAudit(input: {
    actorId: string | null;
    action: string;
    target: string;
    meta: Record<string, unknown>;
  }): Promise<void>;
  metrics(): Promise<{
    events: number;
    photos: number;
    faces: number;
    users: number;
    jobsQueued: number;
  }>;
  enqueueJob(type: JobType, payload: unknown): Promise<void>;
  claimJob(): Promise<ClaimedJob | null>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: string): Promise<"queued" | "error">;
}
