import { createHash, randomUUID } from "node:crypto";
import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";
import { JOB_MAX_ATTEMPTS } from "@rephoto/contracts";
import { DuplicateKeyError } from "./types.js";
import type {
  ClaimedJob,
  Database,
  EventRow,
  FaceInsert,
  GalleryItemRow,
  ImageContentType,
  PhotoRow,
  UploadSessionRow,
  UserRow,
} from "./types.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";
const INVITE_ID = "00000000-0000-4000-8000-000000000004";

type MagicLink = {
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

type Consent = { userId: string; eventId: string; withdrawnAt: Date | null };

type FaceRow = FaceInsert & { id: string; photoId: string; eventId: string };

type Gallery = { id: string; userId: string; eventId: string };

type Item = GalleryItemRow & { galleryId: string };

type JobRow = {
  id: string;
  type: JobType;
  payload: unknown;
  status: "queued" | "running" | "done" | "error";
  attempts: number;
  runAfter: Date;
  createdAt: Date;
};

export class MemoryDatabase implements Database {
  private readonly users = new Map<string, UserRow>();
  private readonly events = new Map<string, EventRow>();
  private readonly links: MagicLink[] = [];
  private readonly sessions = new Map<string, { userId: string; expiresAt: Date }>();
  private readonly consents: Consent[] = [];
  private readonly photos = new Map<string, PhotoRow>();
  private readonly uploads = new Map<string, UploadSessionRow>();
  private readonly derivatives: Array<{ photoId: string; kind: "thumb" | "web"; s3Key: string }> = [];
  private readonly faces: FaceRow[] = [];
  private readonly galleries: Gallery[] = [];
  private readonly items: Item[] = [];
  private readonly jobs: JobRow[] = [];

  async seedDemo(): Promise<void> {
    if (!(await this.findEventBySlug("demo"))) {
      this.events.set(EVENT_ID, {
        id: EVENT_ID,
        slug: "demo",
        name: "Demo",
        retentionDays: 90,
        createdAt: new Date(),
      });
    }
    if (!(await this.findUserByEmailRole("admin@rephoto.local", "admin"))) {
      this.users.set(ADMIN_ID, {
        id: ADMIN_ID,
        email: "admin@rephoto.local",
        role: "admin",
        createdAt: new Date(),
      });
    }
    if (!(await this.findUserByEmailRole("photographer@rephoto.local", "photographer"))) {
      this.users.set(PHOTOGRAPHER_ID, {
        id: PHOTOGRAPHER_ID,
        email: "photographer@rephoto.local",
        role: "photographer",
        createdAt: new Date(),
      });
    }
    await this.insertInvite({
      id: INVITE_ID,
      email: "photographer@rephoto.local",
      eventId: EVENT_ID,
      tokenHash: seedInviteHash(),
      role: "photographer",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      usedAt: new Date(),
    });
  }

  async findEventBySlug(slug: string): Promise<EventRow | null> {
    for (const event of this.events.values()) if (event.slug === slug) return event;
    return null;
  }

  async findEventById(id: string): Promise<EventRow | null> {
    return this.events.get(id) ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  async findUserByEmailRole(email: string, role: Role): Promise<UserRow | null> {
    for (const user of this.users.values()) {
      if (user.email === email && user.role === role) return user;
    }
    return null;
  }

  async insertUser(email: string, role: Role): Promise<UserRow> {
    return this.createUser({ email, role });
  }

  async createUser(input: { id?: string; email: string; role: Role }): Promise<UserRow> {
    const existing = await this.findUserByEmailRole(input.email, input.role);
    if (existing) return existing;
    const user: UserRow = {
      id: input.id ?? randomUUID(),
      email: input.email,
      role: input.role,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.links.push({ ...input, usedAt: null });
  }

  async consumeMagicLink(tokenHash: string): Promise<{ email: string; role: Role } | null> {
    const link = this.links.find((row) => row.tokenHash === tokenHash);
    if (!link || link.usedAt || link.expiresAt <= new Date()) return null;
    link.usedAt = new Date();
    return { email: link.email, role: link.role };
  }

  async insertSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    this.sessions.set(input.tokenHash, { userId: input.userId, expiresAt: input.expiresAt });
  }

  async findUserBySession(tokenHash: string): Promise<UserRow | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt <= new Date()) return null;
    return this.findUserById(session.userId);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async insertConsent(input: {
    userId: string;
    eventId: string;
    textVersion: string;
    ip: string;
    userAgent: string;
  }): Promise<{ id: string; grantedAt: Date }> {
    void input.textVersion;
    void input.ip;
    void input.userAgent;
    this.consents.push({ userId: input.userId, eventId: input.eventId, withdrawnAt: null });
    return { id: randomUUID(), grantedAt: new Date() };
  }

  async hasActiveConsent(userId: string, eventId: string): Promise<boolean> {
    return this.consents.some(
      (row) => row.userId === userId && row.eventId === eventId && !row.withdrawnAt,
    );
  }

  async countMatchJobsSince(userId: string, since: Date): Promise<number> {
    return this.jobs.filter((job) => {
      if (job.type !== "match" || job.createdAt < since) return false;
      const payload = job.payload as { userId?: string };
      return payload.userId === userId;
    }).length;
  }

  async findPhotoBySha(eventId: string, sha256: string): Promise<PhotoRow | null> {
    for (const photo of this.photos.values()) {
      if (photo.eventId === eventId && photo.sha256 === sha256) return photo;
    }
    return null;
  }

  async insertUploadSession(input: {
    id: string;
    eventId: string;
    photographerId: string;
    s3UploadId: string | null;
    objectKey: string;
    sha256: string;
    contentType: ImageContentType;
  }): Promise<void> {
    this.uploads.set(input.id, { ...input, status: "open", createdAt: new Date() });
  }

  async findUploadSession(id: string): Promise<UploadSessionRow | null> {
    return this.uploads.get(id) ?? null;
  }

  async markUploadSession(id: string, status: "completed" | "aborted"): Promise<boolean> {
    const session = this.uploads.get(id);
    if (!session || session.status !== "open") return false;
    session.status = status;
    return true;
  }

  async listUploadSessions(photographerId: string, eventId: string): Promise<UploadSessionRow[]> {
    return [...this.uploads.values()].filter(
      (row) => row.photographerId === photographerId && row.eventId === eventId,
    );
  }

  async insertPhoto(input: {
    id: string;
    eventId: string;
    photographerId: string;
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
  }): Promise<PhotoRow> {
    if (await this.findPhotoBySha(input.eventId, input.sha256)) throw new DuplicateKeyError();
    const photo: PhotoRow = { ...input, status: "uploaded", createdAt: new Date() };
    this.photos.set(photo.id, photo);
    return photo;
  }

  async findPhoto(id: string): Promise<PhotoRow | null> {
    return this.photos.get(id) ?? null;
  }

  async listPhotosByPhotographer(photographerId: string): Promise<PhotoRow[]> {
    return [...this.photos.values()].filter((photo) => photo.photographerId === photographerId);
  }

  async setPhotoStatus(id: string, status: PhotoStatus): Promise<void> {
    const photo = this.photos.get(id);
    if (photo) photo.status = status;
  }

  async listPhotosCreatedBefore(eventId: string, cutoff: Date): Promise<PhotoRow[]> {
    return [...this.photos.values()].filter(
      (photo) => photo.eventId === eventId && photo.createdAt < cutoff,
    );
  }

  async upsertDerivative(input: {
    photoId: string;
    kind: "thumb" | "web";
    s3Key: string;
  }): Promise<void> {
    const index = this.derivatives.findIndex(
      (row) => row.photoId === input.photoId && row.kind === input.kind,
    );
    if (index >= 0) this.derivatives[index] = input;
    else this.derivatives.push(input);
  }

  async listDerivatives(photoId: string): Promise<Array<{ kind: "thumb" | "web"; s3Key: string }>> {
    return this.derivatives
      .filter((row) => row.photoId === photoId)
      .map(({ kind, s3Key }) => ({ kind, s3Key }));
  }

  async replaceFaces(photoId: string, eventId: string, faces: FaceInsert[]): Promise<void> {
    for (let index = this.faces.length - 1; index >= 0; index -= 1) {
      if (this.faces[index]?.photoId === photoId) this.faces.splice(index, 1);
    }
    for (const face of faces) {
      this.faces.push({ ...face, id: randomUUID(), photoId, eventId });
    }
  }

  async listExternalIds(photoId: string): Promise<string[]> {
    return this.faces.filter((face) => face.photoId === photoId).map((face) => face.externalId);
  }

  async findFaceByExternalId(
    eventId: string,
    externalId: string,
  ): Promise<{ id: string; photoId: string } | null> {
    const face = this.faces.find(
      (row) => row.eventId === eventId && row.externalId === externalId,
    );
    return face ? { id: face.id, photoId: face.photoId } : null;
  }

  async replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
  ): Promise<void> {
    let gallery = this.galleries.find((row) => row.userId === userId && row.eventId === eventId);
    if (!gallery) {
      gallery = { id: randomUUID(), userId, eventId };
      this.galleries.push(gallery);
    }
    const galleryId = gallery.id;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.galleryId === galleryId) this.items.splice(index, 1);
    }
    for (const item of items) this.items.push({ ...item, galleryId });
  }

  async listGallery(userId: string, eventId: string): Promise<GalleryItemRow[]> {
    const gallery = this.galleries.find((row) => row.userId === userId && row.eventId === eventId);
    if (!gallery) return [];
    return this.items
      .filter((item) => item.galleryId === gallery.id)
      .map(({ photoId, faceId, score }) => ({ photoId, faceId, score }));
  }

  async latestMatchJob(
    userId: string,
    eventId: string,
  ): Promise<{ status: "queued" | "running" | "done" | "error" } | null> {
    const matches = this.jobs
      .filter((job) => {
        if (job.type !== "match") return false;
        const payload = job.payload as { userId?: string; eventId?: string };
        return payload.userId === userId && payload.eventId === eventId;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = matches[0];
    return latest ? { status: latest.status } : null;
  }

  async deletePhoto(photoId: string): Promise<void> {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.photoId === photoId) this.items.splice(index, 1);
    }
    for (let index = this.faces.length - 1; index >= 0; index -= 1) {
      if (this.faces[index]?.photoId === photoId) this.faces.splice(index, 1);
    }
    for (let index = this.derivatives.length - 1; index >= 0; index -= 1) {
      if (this.derivatives[index]?.photoId === photoId) this.derivatives.splice(index, 1);
    }
    this.photos.delete(photoId);
  }

  async deleteParticipant(userId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.role !== "participant") return false;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const gallery = this.galleries.find((row) => row.id === this.items[index]?.galleryId);
      if (gallery?.userId === userId) this.items.splice(index, 1);
    }
    for (let index = this.galleries.length - 1; index >= 0; index -= 1) {
      if (this.galleries[index]?.userId === userId) this.galleries.splice(index, 1);
    }
    for (let index = this.consents.length - 1; index >= 0; index -= 1) {
      if (this.consents[index]?.userId === userId) this.consents.splice(index, 1);
    }
    for (let index = this.links.length - 1; index >= 0; index -= 1) {
      const user = await this.findUserById(userId);
      if (user && this.links[index]?.email === user.email && this.links[index]?.role === user.role) {
        this.links.splice(index, 1);
      }
    }
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(hash);
    }
    if (!this.users.has(userId)) return false;
    this.users.delete(userId);
    return true;
  }

  async insertInvite(input: {
    id?: string;
    email: string;
    eventId: string;
    tokenHash: string;
    role: Role;
    expiresAt: Date;
    usedAt?: Date | null;
  }): Promise<string> {
    void input.email;
    void input.eventId;
    void input.tokenHash;
    void input.role;
    void input.expiresAt;
    void input.usedAt;
    return input.id ?? randomUUID();
  }

  async insertAudit(): Promise<void> {
    return undefined;
  }

  async metrics(): Promise<{
    events: number;
    photos: number;
    faces: number;
    users: number;
    jobsQueued: number;
  }> {
    return {
      events: this.events.size,
      photos: this.photos.size,
      faces: this.faces.length,
      users: this.users.size,
      jobsQueued: this.jobs.filter((job) => job.status === "queued").length,
    };
  }

  async enqueueJob(type: JobType, payload: unknown): Promise<void> {
    const now = new Date();
    this.jobs.push({
      id: randomUUID(),
      type,
      payload,
      status: "queued",
      attempts: 0,
      runAfter: now,
      createdAt: now,
    });
  }

  async claimJob(): Promise<ClaimedJob | null> {
    const now = new Date();
    const job = this.jobs
      .filter((row) => row.status === "queued" && row.runAfter <= now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!job) return null;
    job.status = "running";
    return { id: job.id, type: job.type, payload: job.payload, attempts: job.attempts };
  }

  async completeJob(id: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id);
    if (job) job.status = "done";
  }

  async failJob(id: string, error: string): Promise<"queued" | "error"> {
    void error;
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return "error";
    const next = job.attempts + 1;
    job.attempts = next;
    if (next >= JOB_MAX_ATTEMPTS) {
      job.status = "error";
      return "error";
    }
    job.status = "queued";
    job.runAfter = new Date(Date.now() + next * 30_000);
    return "queued";
  }
}

export function seedInviteHash(): string {
  return createHash("sha256").update("seed-invite").digest("hex");
}
