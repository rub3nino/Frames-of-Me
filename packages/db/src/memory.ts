import { createHash, randomUUID } from "node:crypto";
import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";
import {
  JOB_MAX_ATTEMPTS,
  JOB_PRIORITY,
  // v6 (agent C): `not_me` never counts toward the auto-pending threshold. The predicate
  // and MODERATION_COUNTING_REASONS in the contracts carry the reasoning.
  countsTowardModeration,
  STALE_RUNNING_MS,
  THROTTLE_REQUEUE_SECONDS,
} from "@rephoto/contracts";
import {
  AlbumRecognitionLockedError,
  AlbumRecognitionNotAllowedError,
  DuplicateKeyError,
} from "./types.js";
import type {
  AnchoredGallery,
  ClaimedJob,
  Database,
  EnqueueJobOptions,
  EventAccess,
  EventRow,
  FaceInsert,
  GalleryCursor,
  GalleryItemRow,
  GalleryItemSource,
  GalleryPage,
  ImageContentType,
  Metrics,
  OriginalStatus,
  PhotoRow,
  StaleUpload,
  UploadCursor,
  UploadSessionRow,
  UploadStage,
  UploadSummary,
  UserRow,
  EventWithCounts,
  FeedbackExportRow,
  FeedbackVerdict,
  GalleryExportRow,
  GalleryListCursor,
  GalleryListRow,
  GalleryWithItems,
  MatchHitExportRow,
  MatchRunRow,
  MetricsExtras,
  PhotoAdminFilters,
  PhotoAdminRow,
  PhotoDetail,
  ClaimOptions,
  GalleryMatchPatch,
  MatchHitInsert,
  MatchRunInsert,
  QueryVectorGallery,
  AlbumInsert,
  AlbumPatch,
  AlbumRow,
  // v6 (agent B)
  EventCodeRow,
  IdentityProvider,
  // v6 (agent D): admin console
  AlbumPhotographerRow,
  EventCodePatch,
  EventStatus,
  EventStatusAlbum,
  PhotosByStatus,
  // v6 (agent C)
  AlbumPhoto,
  ModerationItem,
  ModerationState,
  ReportReason,
  ReportRow,
} from "./types.js";

/** Same cap as PostgresDatabase.findGalleriesByQueryVector. */
const QUERY_VECTOR_GALLERY_LIMIT = 50;
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";
const INVITE_ID = "00000000-0000-4000-8000-000000000004";
/** v6: slug of the official album every event gets (migration 009). */
const DEFAULT_ALBUM_SLUG = "ufficiale";

type MagicLink = {
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  ip: string | null;
  createdAt: Date;
};

type Consent = { userId: string; eventId: string; withdrawnAt: Date | null };

type FaceRow = FaceInsert & { id: string; photoId: string; eventId: string };

type Gallery = {
  id: string;
  userId: string;
  eventId: string;
  anchorFaceIds: string[];
  matchedAt: Date | null;
  notifiedAt: Date | null;
  // v5 (agent A): galleries.query_embedding / last_match_reason / selfie_key
  queryEmbedding: number[] | null;
  lastMatchReason: string | null;
  selfieKey: string | null;
};

type Item = GalleryItemRow & { galleryId: string; source: GalleryItemSource; createdAt: Date };

type Invite = {
  id: string;
  email: string;
  eventId: string;
  tokenHash: string;
  role: Role;
  expiresAt: Date;
  usedAt: Date | null;
};

type JobRow = {
  id: string;
  type: JobType;
  payload: unknown;
  status: "queued" | "running" | "done" | "error";
  attempts: number;
  priority: number;
  dedupeKey: string | null;
  runAfter: Date;
  createdAt: Date;
  claimedAt: Date | null;
  lastError: string | null;
  finishedAt: Date | null;
  durationMs: number | null;
};

export class MemoryDatabase implements Database {
  private readonly users = new Map<string, UserRow>();
  private readonly passwords = new Map<string, string>();
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
  private readonly invites: Invite[] = [];
  private readonly eventPhotographers = new Set<string>();
  private readonly eventParticipants = new Set<string>();
  // v5 (agent D): photos.filename/tags, gallery_feedback, and a read model of match_runs/match_hits.
  private readonly photoMeta = new Map<string, { filename: string | null; tags: string[] }>();
  private readonly feedback: FeedbackRow[] = [];
  private readonly matchRunRows: MatchRunStored[] = [];
  private readonly matchHitRows: MatchHitStored[] = [];
  // v6 (agent A): albums. Migration 009 gives every event an official album and a
  // trigger adds one to each new event; `ensureDefaultAlbum` is that trigger here.
  private readonly albums = new Map<string, AlbumRow>();

  // v6 (agent B): user_identities, event_codes, users.email_verified_at.
  private readonly identities = new Map<string, IdentityStored>();
  private readonly eventCodes = new Map<string, EventCodeRow>();
  private readonly emailVerified = new Map<string, Date>();

  // v6 (agent C): photos.moderation_state/moderated_by/moderated_at and `reports`.
  private readonly moderation = new Map<string, { moderatedBy: string | null; moderatedAt: Date | null }>();
  private readonly reports: ReportRow[] = [];

  async seedDemo(): Promise<void> {
    if (!(await this.findEventBySlug("demo"))) {
      this.events.set(EVENT_ID, {
        id: EVENT_ID,
        slug: "demo",
        name: "Demo",
        retentionDays: 90,
        access: "open",
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
    await this.addEventPhotographer(EVENT_ID, PHOTOGRAPHER_ID);
    this.ensureDefaultAlbum(EVENT_ID);
  }

  async ping(): Promise<void> {
    return undefined;
  }

  async findEventBySlug(slug: string): Promise<EventRow | null> {
    for (const event of this.events.values()) if (event.slug === slug) return event;
    return null;
  }

  async findEventById(id: string): Promise<EventRow | null> {
    return this.events.get(id) ?? null;
  }

  async updateEvent(
    id: string,
    patch: { access?: EventAccess; retentionDays?: number },
  ): Promise<EventRow | null> {
    const event = this.events.get(id);
    if (!event) return null;
    if (patch.access !== undefined) event.access = patch.access;
    if (patch.retentionDays !== undefined) event.retentionDays = patch.retentionDays;
    return event;
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

  async setUserPassword(userId: string, passwordHash: string): Promise<void> {
    this.passwords.set(userId, passwordHash);
  }

  async findUserForLogin(
    email: string,
    role: Role,
  ): Promise<{ user: UserRow; passwordHash: string | null } | null> {
    const user = await this.findUserByEmailRole(email, role);
    if (!user) return null;
    return { user, passwordHash: this.passwords.get(user.id) ?? null };
  }

  async insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
  }): Promise<void> {
    this.links.push({ ...input, usedAt: null, createdAt: new Date() });
  }

  async countMagicLinksSince(input: { email?: string; ip?: string; since: Date }): Promise<number> {
    if (input.email === undefined && input.ip === undefined) return 0;
    return this.links.filter(
      (link) =>
        link.createdAt >= input.since &&
        (input.email === undefined || link.email === input.email) &&
        (input.ip === undefined || link.ip === input.ip),
    ).length;
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

  /** Event-wide, like {@link findPhotoBySha}: see the note on the Postgres implementation. */
  async findOwnPhotoBySha(
    photographerId: string,
    eventId: string,
    sha256: string,
  ): Promise<PhotoRow | null> {
    const photo = await this.findPhotoBySha(eventId, sha256);
    return photo && photo.photographerId === photographerId ? photo : null;
  }

  async insertUploadSession(input: {
    id: string;
    eventId: string;
    photographerId: string;
    s3UploadId: string | null;
    objectKey: string;
    sha256: string;
    contentType: ImageContentType;
    bytes: number;
    stage?: UploadStage;
    photoId?: string | null;
    originalContentType?: ImageContentType | null;
    originalBytes?: number | null;
    filename?: string | null;
    tags?: string[];
    albumId?: string | null;
  }): Promise<void> {
    this.uploads.set(input.id, {
      // v6 (agent C): the album chosen at init, carried to complete; the event's official
      // album when the caller gives none, exactly as `insertPhoto` resolves it.
      albumId: input.albumId ?? this.ensureDefaultAlbum(input.eventId).id,
      filename: input.filename ?? null,
      tags: [...(input.tags ?? [])],
      id: input.id,
      eventId: input.eventId,
      photographerId: input.photographerId,
      s3UploadId: input.s3UploadId,
      objectKey: input.objectKey,
      sha256: input.sha256,
      contentType: input.contentType,
      bytes: input.bytes,
      stage: input.stage ?? "original",
      photoId: input.photoId ?? null,
      originalContentType: input.originalContentType ?? null,
      originalBytes: input.originalBytes ?? null,
      status: "open",
      createdAt: new Date(),
    });
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
    return this.uploadsOf(photographerId, eventId);
  }

  async listUploadSessionsPage(
    photographerId: string,
    eventId: string,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: UploadSessionRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const rows = this.uploadsOf(photographerId, eventId).filter((row) => {
      if (!cursor) return true;
      const byTime = row.createdAt.getTime() - cursor.createdAt.getTime();
      return byTime < 0 || (byTime === 0 && row.id < cursor.id);
    });
    const items = rows.slice(0, input.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, nextCursor };
  }

  async uploadSummary(photographerId: string, eventId: string): Promise<UploadSummary> {
    const summary: UploadSummary = {
      sessions: { open: 0, completed: 0, aborted: 0 },
      photos: { uploaded: 0, processing: 0, indexed: 0, error: 0, originalsPending: 0 },
    };
    for (const row of this.uploads.values()) {
      if (row.photographerId === photographerId && row.eventId === eventId) {
        summary.sessions[row.status] += 1;
      }
    }
    for (const photo of this.photos.values()) {
      if (photo.photographerId === photographerId && photo.eventId === eventId) {
        summary.photos[photo.status] += 1;
        if (photo.originalStatus === "pending") summary.photos.originalsPending += 1;
      }
    }
    return summary;
  }

  async abortStaleUploads(input: { olderThan: Date }): Promise<StaleUpload[]> {
    const aborted: StaleUpload[] = [];
    for (const row of this.uploads.values()) {
      if (row.status !== "open" || row.createdAt >= input.olderThan) continue;
      row.status = "aborted";
      aborted.push({ id: row.id, objectKey: row.objectKey, s3UploadId: row.s3UploadId });
    }
    return aborted;
  }

  async insertPhoto(input: {
    id: string;
    eventId: string;
    photographerId: string;
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
    originalStatus?: OriginalStatus;
    filename?: string | null;
    tags?: string[];
    albumId?: string;
  }): Promise<PhotoRow> {
    // v6: dedup is per album (`photos unique (album_id, sha256)`), so the same bytes may
    // exist once in the official album and once in a crowd album.
    const albumId = input.albumId ?? this.ensureDefaultAlbum(input.eventId).id;
    if (await this.findPhotoByAlbumSha(albumId, input.sha256)) throw new DuplicateKeyError();
    this.photoMeta.set(input.id, { filename: input.filename ?? null, tags: [...(input.tags ?? [])] });
    const photo: PhotoRow = {
      id: input.id,
      eventId: input.eventId,
      photographerId: input.photographerId,
      sha256: input.sha256,
      originalKey: input.originalKey,
      contentType: input.contentType,
      bytes: input.bytes,
      originalStatus: input.originalStatus ?? "present",
      status: "uploaded",
      indexedAt: null,
      error: null,
      createdAt: new Date(),
      albumId,
      // v6 (agent C): moderation `post` is the default — a photo arrives approved and is
      // visible at once (`photos.moderation_state default 'approved'`, migration 010).
      moderationState: "approved",
    };
    this.photos.set(photo.id, photo);
    // The `photos_album_first_upload` trigger of migration 009.
    await this.markAlbumFirstUpload(albumId);
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

  async setOriginalStatus(photoId: string, status: OriginalStatus): Promise<void> {
    const photo = this.photos.get(photoId);
    if (photo) photo.originalStatus = status;
  }

  async setPhotoErrorText(photoId: string, error: string | null): Promise<void> {
    const photo = this.photos.get(photoId);
    if (photo) photo.error = error;
  }

  async setPhotoIndexed(id: string): Promise<void> {
    const photo = this.photos.get(id);
    if (!photo) return;
    photo.status = "indexed";
    photo.indexedAt = new Date();
    photo.error = null;
  }

  async setPhotoError(id: string, error: string): Promise<void> {
    const photo = this.photos.get(id);
    if (!photo) return;
    photo.status = "error";
    photo.error = error;
  }

  async listPhotosCreatedBefore(
    eventId: string,
    cutoff: Date,
    limit?: number,
  ): Promise<PhotoRow[]> {
    const rows = [...this.photos.values()]
      .filter((photo) => photo.eventId === eventId && photo.createdAt < cutoff)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async countPhotos(eventId: string): Promise<number> {
    let count = 0;
    for (const photo of this.photos.values()) if (photo.eventId === eventId) count += 1;
    return count;
  }

  async listPhotosByIds(ids: string[]): Promise<PhotoRow[]> {
    const rows: PhotoRow[] = [];
    for (const id of ids) {
      const photo = this.photos.get(id);
      if (photo) rows.push(photo);
    }
    return rows;
  }

  async listOwnedPhotos(userId: string, eventId: string, photoIds: string[]): Promise<PhotoRow[]> {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery || photoIds.length === 0) return [];
    const owned = new Set(
      this.items.filter((item) => item.galleryId === gallery.id).map((item) => item.photoId),
    );
    const rows: PhotoRow[] = [];
    for (const id of new Set(photoIds)) {
      const photo = this.photos.get(id);
      if (photo && owned.has(id)) rows.push(photo);
    }
    return rows;
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

  async listDerivativeKeys(photoIds: string[]): Promise<string[]> {
    const ids = new Set(photoIds);
    return this.derivatives.filter((row) => ids.has(row.photoId)).map((row) => row.s3Key);
  }

  async replaceFaces(photoId: string, eventId: string, faces: FaceInsert[]): Promise<void> {
    const removed = new Set(
      this.faces.filter((face) => face.photoId === photoId).map((face) => face.id),
    );
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (removed.has(this.items[index]?.faceId ?? "")) this.items.splice(index, 1);
    }
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

  async listExternalIdsForPhotos(photoIds: string[]): Promise<string[]> {
    const ids = new Set(photoIds);
    return this.faces.filter((face) => ids.has(face.photoId)).map((face) => face.externalId);
  }

  async findFaceRowsByPhoto(photoId: string): Promise<Array<{ id: string; externalId: string }>> {
    return this.faces
      .filter((face) => face.photoId === photoId)
      .map((face) => ({ id: face.id, externalId: face.externalId }));
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

  async findFacesByExternalIds(
    eventId: string,
    externalIds: string[],
  ): Promise<Array<{ id: string; photoId: string; externalId: string }>> {
    if (externalIds.length === 0) return [];
    const wanted = new Set(externalIds);
    return this.faces
      .filter((face) => face.eventId === eventId && wanted.has(face.externalId))
      .map((face) => ({ id: face.id, photoId: face.photoId, externalId: face.externalId }));
  }

  async replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
    anchors: string[],
  ): Promise<void> {
    const now = new Date();
    let gallery = this.galleryOf(userId, eventId);
    if (!gallery) {
      gallery = this.newGallery(userId, eventId);
      this.galleries.push(gallery);
    }
    gallery.anchorFaceIds = [...anchors];
    gallery.matchedAt = now;
    gallery.notifiedAt = now;
    const galleryId = gallery.id;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.galleryId === galleryId) this.items.splice(index, 1);
    }
    for (const item of items) {
      this.items.push({ ...item, galleryId, source: "match", createdAt: now });
    }
  }

  async listGallery(userId: string, eventId: string): Promise<GalleryItemRow[]> {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) return [];
    return this.items
      .filter((item) => item.galleryId === gallery.id)
      .map(({ photoId, faceId, score }) => ({ photoId, faceId, score }));
  }

  async findGalleryByUser(
    userId: string,
    eventId: string,
  ): Promise<{
    id: string;
    anchorFaceIds: string[];
    matchedAt: Date | null;
    reason: string | null;
    selfieKey: string | null;
    hasQueryVector: boolean;
  } | null> {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) return null;
    return {
      id: gallery.id,
      anchorFaceIds: [...gallery.anchorFaceIds],
      matchedAt: gallery.matchedAt,
      reason: gallery.lastMatchReason,
      selfieKey: gallery.selfieKey,
      hasQueryVector: gallery.queryEmbedding !== null,
    };
  }

  async listGalleryPage(
    userId: string,
    eventId: string,
    input: { limit: number; cursor?: GalleryCursor },
  ): Promise<GalleryPage> {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) return { total: 0, items: [] };
    const cursor = input.cursor;
    const eligible = this.items
      .filter((item) => item.galleryId === gallery.id)
      .flatMap((item) => {
        const thumb = this.derivatives.find((row) => row.photoId === item.photoId && row.kind === "thumb");
        const web = this.derivatives.find((row) => row.photoId === item.photoId && row.kind === "web");
        const photo = this.photos.get(item.photoId);
        if (!thumb || !web || !photo) return [];
        // v6 (agent C): a photo withheld by moderation leaves every gallery until a
        // moderator rules. Everything is `approved` by default, so v5 behaviour is unchanged.
        if (photo.moderationState !== "approved") return [];
        return [
          {
            photoId: item.photoId,
            score: item.score,
            source: item.source,
            createdAt: item.createdAt,
            thumbKey: thumb.s3Key,
            webKey: web.s3Key,
            originalReady: photo.originalStatus === "present",
          },
        ];
      })
      .sort((a, b) => b.score - a.score || compareText(a.photoId, b.photoId));
    const items = eligible
      .filter((item) => {
        if (!cursor) return true;
        return item.score < cursor.score || (item.score === cursor.score && item.photoId > cursor.photoId);
      })
      .slice(0, input.limit);
    return { total: eligible.length, items };
  }

  async countAnchoredGalleries(eventId: string): Promise<number> {
    return this.galleries.filter(
      (gallery) =>
        gallery.eventId === eventId &&
        (gallery.anchorFaceIds.length > 0 || gallery.queryEmbedding !== null),
    ).length;
  }

  async countGalleriesWithQueryVector(eventId: string): Promise<number> {
    return this.galleries.filter(
      (gallery) => gallery.eventId === eventId && gallery.queryEmbedding !== null,
    ).length;
  }

  async findGalleriesByAnchors(eventId: string, externalFaceIds: string[]): Promise<AnchoredGallery[]> {
    if (externalFaceIds.length === 0) return [];
    const wanted = new Set(externalFaceIds);
    return this.galleries
      .filter(
        (gallery) =>
          gallery.eventId === eventId && gallery.anchorFaceIds.some((id) => wanted.has(id)),
      )
      .map((gallery) => ({
        id: gallery.id,
        userId: gallery.userId,
        anchorFaceIds: [...gallery.anchorFaceIds],
        notifiedAt: gallery.notifiedAt,
      }));
  }

  async addGalleryItems(
    galleryId: string,
    items: Array<{ photoId: string; faceId: string; score: number; source: GalleryItemSource }>,
  ): Promise<number> {
    let inserted = 0;
    const now = new Date();
    for (const item of items) {
      const existing = this.items.find(
        (row) => row.galleryId === galleryId && row.photoId === item.photoId,
      );
      if (existing) {
        existing.score = Math.max(existing.score, item.score);
        continue;
      }
      this.items.push({ ...item, galleryId, createdAt: now });
      inserted += 1;
    }
    return inserted;
  }

  async markGalleryNotified(galleryId: string, at: Date): Promise<void> {
    const gallery = this.galleries.find((row) => row.id === galleryId);
    if (gallery) gallery.notifiedAt = at;
  }

  async removeAnchors(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    const removed = new Set(externalFaceIds);
    for (const gallery of this.galleries) {
      if (gallery.eventId !== eventId) continue;
      gallery.anchorFaceIds = gallery.anchorFaceIds.filter((id) => !removed.has(id));
    }
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
    // v6 (agent C): `reports.photo_id ... on delete cascade` (migration 010).
    for (let index = this.reports.length - 1; index >= 0; index -= 1) {
      if (this.reports[index]?.photoId === photoId) this.reports.splice(index, 1);
    }
    this.moderation.delete(photoId);
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
      if (this.links[index]?.email === user.email && this.links[index]?.role === user.role) {
        this.links.splice(index, 1);
      }
    }
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(hash);
    }
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
    const id = input.id ?? randomUUID();
    if (this.invites.some((row) => row.id === id)) return id;
    this.invites.push({
      id,
      email: input.email,
      eventId: input.eventId,
      tokenHash: input.tokenHash,
      role: input.role,
      expiresAt: input.expiresAt,
      usedAt: input.usedAt ?? null,
    });
    return id;
  }

  async consumeInvite(
    tokenHash: string,
  ): Promise<{ email: string; role: Role; eventId: string } | null> {
    const invite = this.invites.find((row) => row.tokenHash === tokenHash);
    if (!invite || invite.usedAt || invite.expiresAt <= new Date()) return null;
    invite.usedAt = new Date();
    return { email: invite.email, role: invite.role, eventId: invite.eventId };
  }

  async addEventPhotographer(eventId: string, userId: string): Promise<void> {
    this.eventPhotographers.add(`${eventId}:${userId}`);
  }

  async isEventPhotographer(eventId: string, userId: string): Promise<boolean> {
    return this.eventPhotographers.has(`${eventId}:${userId}`);
  }

  async upsertEventParticipants(eventId: string, emails: string[]): Promise<number> {
    let inserted = 0;
    for (const email of new Set(emails)) {
      const key = `${eventId}:${email}`;
      if (this.eventParticipants.has(key)) continue;
      this.eventParticipants.add(key);
      inserted += 1;
    }
    return inserted;
  }

  async isEventParticipant(eventId: string, email: string): Promise<boolean> {
    return this.eventParticipants.has(`${eventId}:${email}`);
  }

  async insertAudit(): Promise<void> {
    return undefined;
  }

  async metrics(): Promise<Metrics> {
    const photosByStatus = { uploaded: 0, processing: 0, indexed: 0, error: 0 };
    let originalsPending = 0;
    for (const photo of this.photos.values()) {
      photosByStatus[photo.status] += 1;
      if (photo.originalStatus === "pending") originalsPending += 1;
    }
    return {
      events: this.events.size,
      photos: this.photos.size,
      faces: this.faces.length,
      users: this.users.size,
      jobsQueued: this.jobs.filter((job) => job.status === "queued").length,
      jobsRunning: this.jobs.filter((job) => job.status === "running").length,
      jobsError: this.jobs.filter((job) => job.status === "error").length,
      photosByStatus,
      galleries: this.galleries.length,
      originalsPending,
    };
  }

  async enqueueJob(type: JobType, payload: unknown, opts: EnqueueJobOptions = {}): Promise<string> {
    const dedupeKey = opts.dedupeKey ?? null;
    if (dedupeKey !== null) {
      const active = this.jobs.find(
        (job) => job.dedupeKey === dedupeKey && (job.status === "queued" || job.status === "running"),
      );
      if (active) return active.id;
    }
    const now = new Date();
    const id = randomUUID();
    this.jobs.push({
      id,
      type,
      payload,
      status: "queued",
      attempts: 0,
      priority: opts.priority ?? JOB_PRIORITY[type],
      dedupeKey,
      runAfter: opts.runAfter ?? now,
      createdAt: now,
      claimedAt: null,
      lastError: null,
      finishedAt: null,
      durationMs: null,
    });
    return id;
  }

  async claimJob(options: ClaimOptions = {}): Promise<ClaimedJob | null> {
    const excluded = new Set<JobType>(options.excludeTypes ?? []);
    const now = new Date();
    const staleBefore = now.getTime() - STALE_RUNNING_MS;
    for (const row of this.jobs) {
      if (row.status !== "running") continue;
      const claimed = row.claimedAt ?? row.createdAt;
      if (claimed.getTime() < staleBefore) {
        row.status = "queued";
        row.claimedAt = null;
      }
    }
    const job = this.jobs
      .filter((row) => row.status === "queued" && row.runAfter <= now && !excluded.has(row.type))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.runAfter.getTime() - b.runAfter.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
    if (!job) return null;
    job.status = "running";
    job.claimedAt = now;
    return { id: job.id, type: job.type, payload: job.payload, attempts: job.attempts };
  }

  async completeJob(id: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return;
    finishJob(job);
    job.status = "done";
  }

  async failJob(id: string, error: string): Promise<"queued" | "error"> {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return "error";
    const next = job.attempts + 1;
    finishJob(job);
    job.attempts = next;
    job.claimedAt = null;
    job.lastError = error;
    if (next >= JOB_MAX_ATTEMPTS) {
      job.status = "error";
      return "error";
    }
    job.status = "queued";
    job.runAfter = new Date(Date.now() + next * 30_000);
    return "queued";
  }

  async failJobTerminal(id: string, error: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return;
    finishJob(job);
    job.status = "error";
    job.attempts = JOB_MAX_ATTEMPTS;
    job.lastError = error;
    job.claimedAt = null;
  }

  async requeueJob(id: string, error: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return;
    finishJob(job);
    job.status = "queued";
    job.claimedAt = null;
    job.lastError = error;
    job.runAfter = new Date(Date.now() + THROTTLE_REQUEUE_SECONDS * 1000);
  }

  async pruneJobs(input: { doneOlderThan: Date }): Promise<number> {
    let removed = 0;
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index];
      if (job && job.status === "done" && job.createdAt < input.doneOlderThan) {
        this.jobs.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  jobView(id: string): {
    status: string;
    type: JobType;
    attempts: number;
    claimedAt: Date | null;
    runAfter: Date;
    priority: number;
    dedupeKey: string | null;
    lastError: string | null;
    finishedAt: Date | null;
    durationMs: number | null;
  } | null {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) return null;
    return {
      status: job.status,
      type: job.type,
      attempts: job.attempts,
      claimedAt: job.claimedAt,
      runAfter: job.runAfter,
      priority: job.priority,
      dedupeKey: job.dedupeKey,
      lastError: job.lastError,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
    };
  }

  // ---- recognition + robustness v5 (agent A) --------------------------------------------

  async updateGalleryMatch(userId: string, eventId: string, patch: GalleryMatchPatch): Promise<void> {
    let gallery = this.galleryOf(userId, eventId);
    if (!gallery) {
      gallery = this.newGallery(userId, eventId);
      this.galleries.push(gallery);
    }
    if (patch.queryEmbedding !== undefined) {
      gallery.queryEmbedding = patch.queryEmbedding ? [...patch.queryEmbedding] : null;
    }
    if (patch.lastMatchReason !== undefined) gallery.lastMatchReason = patch.lastMatchReason;
    if (patch.selfieKey !== undefined) gallery.selfieKey = patch.selfieKey;
  }

  async findGalleriesByQueryVector(
    eventId: string,
    embedding: number[],
    minCosine: number,
  ): Promise<QueryVectorGallery[]> {
    const hits: QueryVectorGallery[] = [];
    for (const gallery of this.galleries) {
      if (gallery.eventId !== eventId || gallery.queryEmbedding === null) continue;
      const cosine = cosineOf(gallery.queryEmbedding, embedding);
      if (cosine < minCosine) continue;
      hits.push({
        id: gallery.id,
        userId: gallery.userId,
        anchorFaceIds: [...gallery.anchorFaceIds],
        notifiedAt: gallery.notifiedAt,
        cosine,
      });
    }
    return hits.sort((a, b) => b.cosine - a.cosine).slice(0, QUERY_VECTOR_GALLERY_LIMIT);
  }

  async insertMatchRun(input: MatchRunInsert): Promise<string> {
    const id = randomUUID();
    this.matchRunRows.push({ ...input, id, createdAt: new Date() });
    return id;
  }

  async insertMatchHits(runId: string, hits: MatchHitInsert[]): Promise<void> {
    const seen = new Set(
      this.matchHitRows
        .filter((row) => row.runId === runId)
        .map((row) => `${row.photoId}:${row.externalFaceId}`),
    );
    for (const hit of hits) {
      const key = `${hit.photoId}:${hit.externalFaceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.matchHitRows.push({ ...hit, runId });
    }
  }

  async touchJob(id: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id);
    if (job && job.status === "running") job.claimedAt = new Date();
  }

  async deleteGalleriesByEvent(eventId: string): Promise<number> {
    const ids = new Set(
      this.galleries.filter((gallery) => gallery.eventId === eventId).map((gallery) => gallery.id),
    );
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.items[index]?.galleryId ?? "")) this.items.splice(index, 1);
    }
    for (let index = this.galleries.length - 1; index >= 0; index -= 1) {
      if (this.galleries[index]?.eventId === eventId) this.galleries.splice(index, 1);
    }
    return ids.size;
  }

  async listGallerySelfieKeys(eventId: string): Promise<string[]> {
    return this.galleries
      .filter((gallery) => gallery.eventId === eventId)
      .map(gallerySelfieKey)
      .filter((key): key is string => key !== null);
  }

  async listGallerySelfieKeysByUser(userId: string): Promise<string[]> {
    return this.galleries
      .filter((gallery) => gallery.userId === userId)
      .map(gallerySelfieKey)
      .filter((key): key is string => key !== null);
  }

  async expireGalleryMatches(eventId: string, cutoff: Date): Promise<string[]> {
    const keys: string[] = [];
    for (const gallery of this.galleries) {
      if (gallery.eventId !== eventId || !gallery.matchedAt || gallery.matchedAt >= cutoff) continue;
      const key = gallerySelfieKey(gallery);
      if (key) keys.push(key);
      gallery.queryEmbedding = null;
      gallery.anchorFaceIds = [];
      gallery.selfieKey = null;
    }
    return keys;
  }

  async deleteMatchRunsByEvent(eventId: string): Promise<number> {
    const ids = new Set(
      this.matchRunRows.filter((run) => run.eventId === eventId).map((run) => run.id),
    );
    for (let index = this.matchHitRows.length - 1; index >= 0; index -= 1) {
      if (ids.has(this.matchHitRows[index]?.runId ?? "")) this.matchHitRows.splice(index, 1);
    }
    for (let index = this.matchRunRows.length - 1; index >= 0; index -= 1) {
      if (this.matchRunRows[index]?.eventId === eventId) this.matchRunRows.splice(index, 1);
    }
    return ids.size;
  }

  async resetPhotosForRequeue(input: {
    eventId: string;
    status: PhotoStatus;
    errorLike?: string;
  }): Promise<Array<{ id: string; webReady: boolean }>> {
    const needle = input.errorLike?.toLowerCase();
    const result: Array<{ id: string; webReady: boolean }> = [];
    for (const photo of this.photos.values()) {
      if (photo.eventId !== input.eventId || photo.status !== input.status) continue;
      if (needle !== undefined && !(photo.error ?? "").toLowerCase().includes(needle)) continue;
      const web = this.derivatives.some((row) => row.photoId === photo.id && row.kind === "web");
      const thumb = this.derivatives.some((row) => row.photoId === photo.id && row.kind === "thumb");
      photo.status = web && thumb ? "processing" : "uploaded";
      photo.error = null;
      result.push({ id: photo.id, webReady: web });
    }
    return result;
  }

  /** Test helper: the match log of an event, oldest first, with each run's hits. */
  matchLogOf(eventId: string): Array<MatchRunStored & { hitRows: MatchHitStored[] }> {
    return this.matchRunRows
      .filter((run) => run.eventId === eventId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((run) => ({ ...run, hitRows: this.matchHitRows.filter((hit) => hit.runId === run.id) }));
  }

  /** Test helper: the stored selfie vector of a gallery (null when none). */
  galleryQueryVector(userId: string, eventId: string): number[] | null {
    const gallery = this.galleryOf(userId, eventId);
    return gallery?.queryEmbedding ? [...gallery.queryEmbedding] : null;
  }

  private newGallery(userId: string, eventId: string): Gallery {
    return {
      id: randomUUID(),
      userId,
      eventId,
      anchorFaceIds: [],
      matchedAt: null,
      notifiedAt: null,
      queryEmbedding: null,
      lastMatchReason: null,
      selfieKey: null,
    };
  }

  makeJobDue(id: string): void {
    const job = this.jobs.find((row) => row.id === id);
    if (job) job.runAfter = new Date(0);
  }

  forceRunning(id: string, claimedAt: Date): void {
    const job = this.jobs.find((row) => row.id === id);
    if (!job) throw new Error("missing job");
    job.status = "running";
    job.claimedAt = claimedAt;
  }

  setPhotoCreatedAt(id: string, createdAt: Date): void {
    const photo = this.photos.get(id);
    if (photo) photo.createdAt = createdAt;
  }

  setJobCreatedAt(id: string, createdAt: Date): void {
    const job = this.jobs.find((row) => row.id === id);
    if (job) job.createdAt = createdAt;
  }

  setUploadCreatedAt(id: string, createdAt: Date): void {
    const upload = this.uploads.get(id);
    if (upload) upload.createdAt = createdAt;
  }

  // ---- admin and participant tooling v5 (agent D) ----------------------------------------

  async createEvent(input: {
    slug: string;
    name: string;
    retentionDays?: number;
    access?: EventAccess;
  }): Promise<EventRow> {
    if (await this.findEventBySlug(input.slug)) throw new DuplicateKeyError();
    const event: EventRow = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      retentionDays: input.retentionDays ?? 90,
      access: input.access ?? "open",
      createdAt: new Date(),
    };
    this.events.set(event.id, event);
    this.ensureDefaultAlbum(event.id);
    return event;
  }

  async listEventsWithCounts(): Promise<EventWithCounts[]> {
    return [...this.events.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(a.id, b.id))
      .map((event) => ({
        ...event,
        photos: [...this.photos.values()].filter((photo) => photo.eventId === event.id).length,
        galleries: this.galleries.filter((gallery) => gallery.eventId === event.id).length,
        participants: new Set(
          this.consents
            .filter((row) => row.eventId === event.id && !row.withdrawnAt)
            .map((row) => row.userId),
        ).size,
        photographers: [...this.eventPhotographers].filter((key) => key.startsWith(`${event.id}:`)).length,
      }));
  }

  async findUserByEmail(email: string, role: Role = "participant"): Promise<UserRow | null> {
    return this.findUserByEmailRole(email, role);
  }

  async listGalleriesPage(
    eventId: string,
    input: { limit: number; cursor?: GalleryListCursor },
  ): Promise<{ galleries: GalleryListRow[]; nextCursor: GalleryListCursor | null }> {
    const cursor = input.cursor;
    const sortAt = (gallery: Gallery) => gallery.matchedAt?.getTime() ?? 0;
    const rows = this.galleries
      .filter((gallery) => gallery.eventId === eventId)
      .sort((a, b) => sortAt(b) - sortAt(a) || compareText(a.userId, b.userId))
      .filter((gallery) => {
        if (!cursor) return true;
        const at = cursor.matchedAt.getTime();
        return sortAt(gallery) < at || (sortAt(gallery) === at && gallery.userId > cursor.userId);
      });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      galleries: page.map((gallery) => ({
        userId: gallery.userId,
        email: this.users.get(gallery.userId)?.email ?? "",
        total: this.items.filter((item) => item.galleryId === gallery.id).length,
        matchedAt: gallery.matchedAt,
        reason: galleryReason(gallery),
      })),
      nextCursor:
        rows.length > input.limit && last
          ? { matchedAt: new Date(sortAt(last)), userId: last.userId }
          : null,
    };
  }

  async findGalleryWithItemsByEmail(eventId: string, email: string): Promise<GalleryWithItems | null> {
    const user = await this.findUserByEmailRole(email, "participant");
    if (!user) return null;
    const gallery = this.galleryOf(user.id, eventId);
    if (!gallery) return { user, gallery: null, items: [] };
    const feedback = new Map(
      this.feedback
        .filter((row) => row.userId === user.id && row.eventId === eventId)
        .map((row) => [row.photoId, row.verdict]),
    );
    const items = this.items
      .filter((item) => item.galleryId === gallery.id)
      .sort((a, b) => b.score - a.score || compareText(a.photoId, b.photoId))
      .flatMap((item) => {
        const photo = this.photos.get(item.photoId);
        if (!photo) return [];
        const thumb = this.derivatives.find((row) => row.photoId === item.photoId && row.kind === "thumb");
        const web = this.derivatives.find((row) => row.photoId === item.photoId && row.kind === "web");
        return [
          {
            photoId: item.photoId,
            faceId: item.faceId,
            score: item.score,
            source: item.source,
            createdAt: item.createdAt,
            thumbKey: thumb?.s3Key ?? "",
            webKey: web?.s3Key ?? "",
            originalReady: photo.originalStatus === "present",
            sha256: photo.sha256,
            filename: this.photoMeta.get(photo.id)?.filename ?? null,
            feedback: feedback.get(item.photoId) ?? null,
          },
        ];
      });
    return {
      user,
      gallery: {
        id: gallery.id,
        matchedAt: gallery.matchedAt,
        anchorFaceIds: [...gallery.anchorFaceIds],
        reason: galleryReason(gallery),
        total: items.length,
      },
      items,
    };
  }

  async findPhotoDetail(id: string): Promise<PhotoDetail | null> {
    const photo = this.photos.get(id);
    if (!photo) return null;
    const galleries = this.items
      .filter((item) => item.photoId === id)
      .flatMap((item) => {
        const gallery = this.galleries.find((row) => row.id === item.galleryId);
        if (!gallery) return [];
        const verdict = this.feedback.find(
          (row) => row.userId === gallery.userId && row.eventId === gallery.eventId && row.photoId === id,
        );
        return [
          {
            userId: gallery.userId,
            email: this.users.get(gallery.userId)?.email ?? "",
            score: item.score,
            source: item.source,
            faceId: item.faceId,
            feedback: verdict?.verdict ?? null,
          },
        ];
      })
      .sort((a, b) => b.score - a.score || compareText(a.email, b.email));
    return {
      photo: this.adminPhoto(photo),
      faces: this.faces
        .filter((face) => face.photoId === id)
        .map((face) => ({
          id: face.id,
          externalId: face.externalId,
          bbox: { ...face.bbox },
          confidence: face.confidence,
        })),
      galleries,
    };
  }

  async listPhotosAdmin(
    filters: PhotoAdminFilters,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: PhotoAdminRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const rows = [...this.photos.values()]
      .filter((photo) => {
        if (photo.eventId !== filters.eventId) return false;
        const meta = this.photoMeta.get(photo.id);
        if (filters.sha256 && !photo.sha256.startsWith(filters.sha256)) return false;
        if (filters.filename && !(meta?.filename ?? "").startsWith(filters.filename)) return false;
        if (filters.status && photo.status !== filters.status) return false;
        if (filters.photographerId && photo.photographerId !== filters.photographerId) return false;
        if (filters.tag && !(meta?.tags ?? []).includes(filters.tag)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(b.id, a.id))
      .filter((photo) => {
        if (!cursor) return true;
        const byTime = photo.createdAt.getTime() - cursor.createdAt.getTime();
        return byTime < 0 || (byTime === 0 && photo.id < cursor.id);
      });
    const items = rows.slice(0, input.limit).map((photo) => this.adminPhoto(photo));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async findGallerySelfieKey(userId: string, eventId: string): Promise<string | null> {
    const gallery = this.galleryOf(userId, eventId);
    return gallery ? gallerySelfieKey(gallery) : null;
  }

  async deleteGallery(userId: string, eventId: string): Promise<boolean> {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) return false;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.galleryId === gallery.id) this.items.splice(index, 1);
    }
    const position = this.galleries.indexOf(gallery);
    if (position >= 0) this.galleries.splice(position, 1);
    return true;
  }

  async upsertFeedback(input: {
    userId: string;
    eventId: string;
    photoId: string;
    verdict: FeedbackVerdict;
    scoreAtTime: number | null;
  }): Promise<void> {
    const existing = this.feedback.find(
      (row) =>
        row.userId === input.userId && row.eventId === input.eventId && row.photoId === input.photoId,
    );
    if (existing) {
      existing.verdict = input.verdict;
      existing.scoreAtTime = input.scoreAtTime;
      existing.createdAt = new Date();
      return;
    }
    this.feedback.push({ ...input, createdAt: new Date() });
  }

  async listFeedback(
    userId: string,
    eventId: string,
    photoIds?: readonly string[],
  ): Promise<Array<{ photoId: string; verdict: FeedbackVerdict }>> {
    const wanted = photoIds ? new Set(photoIds) : null;
    return this.feedback
      .filter((row) => row.userId === userId && row.eventId === eventId)
      .filter((row) => wanted === null || wanted.has(row.photoId))
      .map((row) => ({ photoId: row.photoId, verdict: row.verdict }));
  }

  async listMatchRuns(
    eventId: string,
    input: { email?: string; limit: number; cursor?: UploadCursor },
  ): Promise<{ runs: MatchRunRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const rows = this.matchRunRows
      .filter((run) => {
        if (run.eventId !== eventId) return false;
        if (input.email && this.users.get(run.userId)?.email !== input.email) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(b.id, a.id))
      .filter((run) => {
        if (!cursor) return true;
        const byTime = run.createdAt.getTime() - cursor.createdAt.getTime();
        return byTime < 0 || (byTime === 0 && run.id < cursor.id);
      });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map((run) => {
        const hits = this.matchHitRows.filter((hit) => hit.runId === run.id);
        return {
          id: run.id,
          userId: run.userId,
          email: this.users.get(run.userId)?.email ?? "",
          liveness: run.liveness,
          reason: run.reason,
          selfieSha256: run.selfieSha256,
          selfieFaces: run.selfieFaces,
          engineMs: run.engineMs,
          hits: run.hits,
          createdAt: run.createdAt,
          kept: hits.filter((hit) => hit.kept).length,
          maxCosine: hits.length > 0 ? Math.max(...hits.map((hit) => hit.cosine)) : null,
        };
      }),
      nextCursor: rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async *exportGalleries(eventId: string): AsyncIterable<GalleryExportRow> {
    const galleries = this.galleries
      .filter((gallery) => gallery.eventId === eventId)
      .map((gallery) => ({ gallery, email: this.users.get(gallery.userId)?.email ?? "" }))
      .sort((a, b) => compareText(a.email, b.email));
    for (const { gallery, email } of galleries) {
      const items = this.items
        .filter((item) => item.galleryId === gallery.id)
        .sort((a, b) => b.score - a.score || compareText(a.photoId, b.photoId));
      for (const item of items) {
        const photo = this.photos.get(item.photoId);
        if (!photo) continue;
        const verdict = this.feedback.find(
          (row) => row.userId === gallery.userId && row.eventId === eventId && row.photoId === item.photoId,
        );
        yield {
          email,
          userId: gallery.userId,
          photoId: item.photoId,
          sha256: photo.sha256,
          filename: this.photoMeta.get(photo.id)?.filename ?? null,
          score: item.score,
          source: item.source,
          faceId: item.faceId,
          createdAt: item.createdAt,
          feedback: verdict?.verdict ?? null,
        };
      }
    }
  }

  async *exportMatchHits(eventId: string): AsyncIterable<MatchHitExportRow> {
    const runs = this.matchRunRows
      .filter((run) => run.eventId === eventId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.id, b.id));
    for (const run of runs) {
      const hits = this.matchHitRows
        .filter((hit) => hit.runId === run.id)
        .sort((a, b) => b.cosine - a.cosine);
      for (const hit of hits) {
        yield {
          runId: run.id,
          email: this.users.get(run.userId)?.email ?? "",
          userId: run.userId,
          runCreatedAt: run.createdAt,
          photoId: hit.photoId,
          externalFaceId: hit.externalFaceId,
          cosine: hit.cosine,
          similarity: hit.similarity,
          kept: hit.kept,
        };
      }
    }
  }

  async *exportFeedback(eventId: string): AsyncIterable<FeedbackExportRow> {
    const rows = this.feedback
      .filter((row) => row.eventId === eventId)
      .map((row) => ({ row, email: this.users.get(row.userId)?.email ?? "" }))
      .sort((a, b) => compareText(a.email, b.email) || a.row.createdAt.getTime() - b.row.createdAt.getTime());
    for (const { row, email } of rows) {
      const photo = this.photos.get(row.photoId);
      if (!photo) continue;
      yield {
        email,
        userId: row.userId,
        photoId: row.photoId,
        sha256: photo.sha256,
        filename: this.photoMeta.get(photo.id)?.filename ?? null,
        verdict: row.verdict,
        scoreAtTime: row.scoreAtTime,
        createdAt: row.createdAt,
      };
    }
  }

  async metricsExtras(): Promise<MetricsExtras> {
    const now = Date.now();
    const byType = new Map<string, MetricsExtras["jobsByType"][number]>();
    for (const job of this.jobs) {
      if (job.status === "done") continue;
      let row = byType.get(job.type);
      if (!row) {
        row = { type: job.type, queued: 0, running: 0, error: 0, oldestQueuedSeconds: null };
        byType.set(job.type, row);
      }
      row[job.status] += 1;
      if (job.status === "queued") {
        const age = Math.max(0, (now - job.createdAt.getTime()) / 1000);
        row.oldestQueuedSeconds = Math.max(row.oldestQueuedSeconds ?? 0, age);
      }
    }
    const jobsByType = [...byType.values()].sort((a, b) => compareText(a.type, b.type));
    const ages = jobsByType
      .map((row) => row.oldestQueuedSeconds)
      .filter((age): age is number => age !== null);
    return {
      jobsByType,
      oldestQueuedSeconds: ages.length > 0 ? Math.max(...ages) : null,
      lastErrors: this.jobs
        .filter((job) => job.status === "error")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 20)
        .map((job) => ({ id: job.id, type: job.type, error: job.lastError ?? "", at: job.createdAt })),
    };
  }

  /** Test helper: what the worker records with KEEP_SELFIES (agent A's `galleries.selfie_key`). */
  setGallerySelfieKey(userId: string, eventId: string, selfieKey: string | null): void {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) throw new Error("missing gallery");
    (gallery as { selfieKey?: string | null }).selfieKey = selfieKey;
  }

  /** Test helper: backdates a match so retention (`expireGalleryMatches`) picks the gallery up. */
  setGalleryMatchedAt(userId: string, eventId: string, matchedAt: Date | null): void {
    const gallery = this.galleryOf(userId, eventId);
    if (!gallery) throw new Error("missing gallery");
    gallery.matchedAt = matchedAt;
  }

  /** Test helper: what the worker records with MATCH_LOG (agent A's match_runs / match_hits). */
  addMatchRun(
    run: Omit<MatchRunStored, "id" | "createdAt"> & { id?: string; createdAt?: Date },
    hits: Array<Omit<MatchHitStored, "runId">> = [],
  ): string {
    const id = run.id ?? randomUUID();
    this.matchRunRows.push({ ...run, id, createdAt: run.createdAt ?? new Date() });
    for (const hit of hits) this.matchHitRows.push({ ...hit, runId: id });
    return id;
  }

  // ---- auth v6 (agent B): identities, event codes, lazy e-mail verification -------------

  async findUserByIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<UserRow | null> {
    const identity = this.identities.get(identityKey(provider, subject));
    if (!identity) return null;
    return this.findUserById(identity.userId);
  }

  async insertIdentity(input: {
    userId: string;
    provider: IdentityProvider;
    subject: string;
    email: string | null;
  }): Promise<void> {
    const key = identityKey(input.provider, input.subject);
    if (this.identities.has(key)) throw new DuplicateKeyError();
    this.identities.set(key, {
      userId: input.userId,
      provider: input.provider,
      subject: input.subject,
      email: input.email,
      createdAt: new Date(),
    });
  }

  async createEventCode(input: {
    eventId: string;
    code: string;
    label?: string | null;
    maxUses?: number | null;
    expiresAt?: Date | null;
  }): Promise<EventCodeRow> {
    const key = eventCodeKey(input.eventId, input.code);
    if (this.eventCodes.has(key)) throw new DuplicateKeyError();
    const row: EventCodeRow = {
      eventId: input.eventId,
      code: input.code,
      label: input.label ?? null,
      maxUses: input.maxUses ?? null,
      uses: 0,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date(),
    };
    this.eventCodes.set(key, row);
    return { ...row };
  }

  async findEventCode(eventId: string, code: string): Promise<EventCodeRow | null> {
    const row = this.eventCodes.get(eventCodeKey(eventId, code));
    return row ? { ...row } : null;
  }

  async claimEventCode(code: string): Promise<EventCodeRow | null> {
    const now = new Date();
    // Same tie-break as Postgres (`order by created_at, event_id limit 1`): the same code
    // string in two events claims exactly one row, the oldest valid one.
    const candidates = [...this.eventCodes.values()]
      .filter(
        (row) =>
          row.code === code &&
          (row.expiresAt === null || row.expiresAt > now) &&
          (row.maxUses === null || row.uses < row.maxUses),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.eventId, b.eventId),
      );
    const row = candidates[0];
    if (!row) return null;
    row.uses += 1;
    return { ...row };
  }

  async markEmailVerified(userId: string, at: Date = new Date()): Promise<void> {
    if (!this.users.has(userId)) return;
    if (this.emailVerified.has(userId)) return;
    this.emailVerified.set(userId, at);
  }

  async findEmailVerifiedAt(userId: string): Promise<Date | null> {
    return this.emailVerified.get(userId) ?? null;
  }

  private adminPhoto(photo: PhotoRow): PhotoAdminRow {
    const meta = this.photoMeta.get(photo.id);
    return { ...photo, filename: meta?.filename ?? null, tags: [...(meta?.tags ?? [])] };
  }

  // ---- albums and vector isolation v6 (agent A) -------------------------------------------

  async createAlbum(input: AlbumInsert): Promise<AlbumRow> {
    if (input.kind === "crowd" && input.recognition === true) {
      throw new AlbumRecognitionNotAllowedError();
    }
    if (await this.findAlbumBySlug(input.eventId, input.slug)) throw new DuplicateKeyError();
    const album: AlbumRow = {
      id: input.id ?? randomUUID(),
      eventId: input.eventId,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      recognition: input.recognition ?? false,
      moderation: input.moderation ?? "post",
      visibility: input.visibility ?? "participants",
      maxPhotosPerUser: input.maxPhotosPerUser ?? null,
      uploadsOpen: input.uploadsOpen ?? true,
      retentionDays: input.retentionDays ?? null,
      firstUploadAt: null,
      createdAt: new Date(),
    };
    this.albums.set(album.id, album);
    return album;
  }

  async findAlbum(id: string): Promise<AlbumRow | null> {
    return this.albums.get(id) ?? null;
  }

  async findAlbumBySlug(eventId: string, slug: string): Promise<AlbumRow | null> {
    for (const album of this.albums.values()) {
      if (album.eventId === eventId && album.slug === slug) return album;
    }
    return null;
  }

  async listAlbums(eventId: string): Promise<AlbumRow[]> {
    return [...this.albums.values()]
      .filter((album) => album.eventId === eventId)
      .sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.id, b.id),
      );
  }

  async findDefaultAlbum(eventId: string): Promise<AlbumRow | null> {
    return this.findAlbumBySlug(eventId, DEFAULT_ALBUM_SLUG);
  }

  async listRecognitionAlbumIds(eventId: string): Promise<string[]> {
    return (await this.listAlbums(eventId))
      .filter((album) => album.recognition)
      .map((album) => album.id);
  }

  async updateAlbum(id: string, patch: AlbumPatch): Promise<AlbumRow | null> {
    const album = this.albums.get(id);
    if (!album) return null;
    if (patch.recognition !== undefined && patch.recognition !== album.recognition) {
      // Decision 3 (frozen): the trigger of migration 009 refuses this in Postgres.
      if (album.firstUploadAt !== null) throw new AlbumRecognitionLockedError();
      if (album.kind === "crowd" && patch.recognition) throw new AlbumRecognitionNotAllowedError();
      album.recognition = patch.recognition;
    }
    if (patch.name !== undefined) album.name = patch.name;
    if (patch.moderation !== undefined) album.moderation = patch.moderation;
    if (patch.visibility !== undefined) album.visibility = patch.visibility;
    if (patch.maxPhotosPerUser !== undefined) album.maxPhotosPerUser = patch.maxPhotosPerUser;
    if (patch.uploadsOpen !== undefined) album.uploadsOpen = patch.uploadsOpen;
    if (patch.retentionDays !== undefined) album.retentionDays = patch.retentionDays;
    return album;
  }

  async markAlbumFirstUpload(albumId: string, at: Date = new Date()): Promise<void> {
    const album = this.albums.get(albumId);
    if (album && album.firstUploadAt === null) album.firstUploadAt = at;
  }

  async findPhotoByAlbumSha(albumId: string, sha256: string): Promise<PhotoRow | null> {
    for (const photo of this.photos.values()) {
      if (photo.albumId === albumId && photo.sha256 === sha256) return photo;
    }
    return null;
  }

  /** The `events_default_album` trigger of migration 009: every event has one. */
  private ensureDefaultAlbum(eventId: string): AlbumRow {
    for (const album of this.albums.values()) {
      if (album.eventId === eventId && album.slug === DEFAULT_ALBUM_SLUG) return album;
    }
    const album: AlbumRow = {
      id: randomUUID(),
      eventId,
      slug: DEFAULT_ALBUM_SLUG,
      name: "Album ufficiale",
      kind: "official",
      recognition: true,
      moderation: "off",
      visibility: "participants",
      maxPhotosPerUser: null,
      uploadsOpen: true,
      retentionDays: null,
      firstUploadAt: null,
      createdAt: new Date(),
    };
    this.albums.set(album.id, album);
    return album;
  }

  private galleryOf(userId: string, eventId: string): Gallery | undefined {
    return this.galleries.find((row) => row.userId === userId && row.eventId === eventId);
  }

  private uploadsOf(photographerId: string, eventId: string): UploadSessionRow[] {
    return [...this.uploads.values()]
      .filter((row) => row.photographerId === photographerId && row.eventId === eventId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(b.id, a.id));
  }

  // ---- admin console v6 (agent D) -------------------------------------------------------

  // `album_photographers` of migration 017: albumId -> (userId -> created_at). A class field
  // declared here and not at the top of the class so the whole area is one block; field
  // initializers run in declaration order at construction either way.
  private readonly albumPhotographers = new Map<string, Map<string, Date>>();

  async listEventCodes(eventId: string): Promise<EventCodeRow[]> {
    return [...this.eventCodes.values()]
      .filter((row) => row.eventId === eventId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || compareText(a.code, b.code),
      )
      .map((row) => ({ ...row }));
  }

  async updateEventCode(
    eventId: string,
    code: string,
    patch: EventCodePatch,
  ): Promise<EventCodeRow | null> {
    const row = this.eventCodes.get(eventCodeKey(eventId, code));
    if (!row) return null;
    if (patch.label !== undefined) row.label = patch.label;
    if (patch.maxUses !== undefined) row.maxUses = patch.maxUses;
    if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
    return { ...row };
  }

  async revokeEventCode(eventId: string, code: string): Promise<EventCodeRow | null> {
    const row = this.eventCodes.get(eventCodeKey(eventId, code));
    if (!row) return null;
    // Postgres evaluates `now()`; here the only clock there is, is this one.
    row.expiresAt = new Date();
    return { ...row };
  }

  async addAlbumPhotographer(albumId: string, userId: string): Promise<void> {
    const grants = this.albumPhotographers.get(albumId) ?? new Map<string, Date>();
    if (!grants.has(userId)) grants.set(userId, new Date());
    this.albumPhotographers.set(albumId, grants);
  }

  async removeAlbumPhotographer(albumId: string, userId: string): Promise<boolean> {
    const grants = this.albumPhotographers.get(albumId);
    if (!grants) return false;
    const removed = grants.delete(userId);
    // An empty list is no list: the album goes back to the event-level grant.
    if (grants.size === 0) this.albumPhotographers.delete(albumId);
    return removed;
  }

  async listAlbumPhotographers(albumId: string): Promise<AlbumPhotographerRow[]> {
    const grants = this.albumPhotographers.get(albumId);
    if (!grants) return [];
    const rows: AlbumPhotographerRow[] = [];
    for (const [userId, createdAt] of grants) {
      const user = this.users.get(userId);
      if (!user) continue;
      rows.push({ albumId, userId, email: user.email, createdAt });
    }
    return rows.sort((a, b) => compareText(a.email, b.email));
  }

  async isAlbumPhotographerAllowed(albumId: string, userId: string): Promise<boolean> {
    const grants = this.albumPhotographers.get(albumId);
    if (!grants || grants.size === 0) return true;
    return grants.has(userId);
  }

  async eventStatus(eventId: string): Promise<EventStatus> {
    const photos = [...this.photos.values()].filter((photo) => photo.eventId === eventId);
    const photosByStatus: PhotosByStatus = { uploaded: 0, processing: 0, indexed: 0, error: 0 };
    for (const photo of photos) photosByStatus[photo.status] += 1;
    const galleries = this.galleries.filter((gallery) => gallery.eventId === eventId);
    const perAlbum = new Map<string, number>();
    for (const photo of photos) {
      perAlbum.set(photo.albumId, (perAlbum.get(photo.albumId) ?? 0) + 1);
    }
    const albums = (await this.listAlbums(eventId)).map(
      (album): EventStatusAlbum => ({
        id: album.id,
        slug: album.slug,
        name: album.name,
        kind: album.kind,
        recognition: album.recognition,
        moderation: album.moderation,
        uploadsOpen: album.uploadsOpen,
        photos: perAlbum.get(album.id) ?? 0,
        firstUploadAt: album.firstUploadAt,
      }),
    );
    return {
      photos: photos.length,
      photosByStatus,
      originalsPending: photos.filter((photo) => photo.originalStatus === "pending").length,
      faces: this.faces.filter((face) => face.eventId === eventId).length,
      galleries: galleries.length,
      galleriesMatched: galleries.filter((gallery) => gallery.matchedAt !== null).length,
      selfiesWaiting: galleries.filter(
        (gallery) => gallery.queryEmbedding !== null && gallery.matchedAt === null,
      ).length,
      albums,
    };
  }

  // ---- crowd upload and moderation v6 (agent C) -----------------------------------------

  async countAlbumPhotosByUploader(albumId: string, uploaderId: string): Promise<number> {
    let count = 0;
    for (const photo of this.photos.values()) {
      if (photo.albumId !== albumId || photo.photographerId !== uploaderId) continue;
      if (photo.moderationState === "approved" || photo.moderationState === "pending") count += 1;
    }
    return count;
  }

  async setPhotoModeration(input: {
    photoId: string;
    state: ModerationState;
    moderatorId?: string | null;
    at?: Date;
  }): Promise<PhotoRow | null> {
    const photo = this.photos.get(input.photoId);
    if (!photo) return null;
    photo.moderationState = input.state;
    const human = input.moderatorId ?? null;
    if (human !== null) {
      // Only a human ruling stamps the two audit columns; the automatic paths leave them.
      this.moderation.set(photo.id, { moderatedBy: human, moderatedAt: input.at ?? new Date() });
    }
    return photo;
  }

  async insertReport(input: {
    photoId: string;
    reporterId: string;
    reason: ReportReason;
    note?: string | null;
  }): Promise<{ created: boolean; report: ReportRow }> {
    const existing = this.reports.find(
      (row) => row.photoId === input.photoId && row.reporterId === input.reporterId,
    );
    // `reports unique (photo_id, reporter_id)`: a second tap from the same person changes
    // nothing, which is what keeps the auto-pending threshold a count of distinct people.
    // The one exception, mirrored from the Postgres `on conflict ... where`: a stored
    // `not_me` may be escalated to a counting reason, one-way, so that tapping
    // "non sono io" does not silently spend the person's only report on this photo.
    if (existing) {
      const escalates = existing.reason === "not_me" && input.reason !== "not_me";
      if (!escalates) return { created: false, report: existing };
      existing.reason = input.reason;
      existing.note = input.note ?? existing.note;
      existing.state = "open";
      existing.createdAt = new Date();
      return { created: true, report: existing };
    }
    const report: ReportRow = {
      id: randomUUID(),
      photoId: input.photoId,
      reporterId: input.reporterId,
      reason: input.reason,
      note: input.note ?? null,
      state: "open",
      createdAt: new Date(),
    };
    this.reports.push(report);
    return { created: true, report };
  }

  async countOpenReports(photoId: string): Promise<number> {
    // Counting reasons ONLY. A `not_me` report is recorded but never moves a photo: it is
    // the normal error mode of face matching, not an abuse signal, and it is answered
    // per-user through `gallery_feedback`. See MODERATION_COUNTING_REASONS.
    const reporters = new Set<string>();
    for (const row of this.reports) {
      if (row.photoId !== photoId || row.state !== "open") continue;
      if (!countsTowardModeration(row.reason)) continue;
      reporters.add(row.reporterId);
    }
    return reporters.size;
  }

  async countOpenNotMeReports(photoId: string): Promise<number> {
    const reporters = new Set<string>();
    for (const row of this.reports) {
      if (row.photoId !== photoId || row.state !== "open" || row.reason !== "not_me") continue;
      reporters.add(row.reporterId);
    }
    return reporters.size;
  }

  async countReportsByUserSince(reporterId: string, since: Date): Promise<number> {
    return this.reports.filter((row) => row.reporterId === reporterId && row.createdAt >= since)
      .length;
  }

  async closeReports(photoId: string): Promise<number> {
    let closed = 0;
    for (const row of this.reports) {
      if (row.photoId === photoId && row.state === "open") {
        row.state = "closed";
        closed += 1;
      }
    }
    return closed;
  }

  async listOpenReports(photoId: string): Promise<ReportRow[]> {
    return this.reports
      .filter((row) => row.photoId === photoId && row.state === "open")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareText(a.id, b.id));
  }

  async listModerationPage(input: {
    albumId?: string;
    state?: ModerationState;
    includeNotMe?: boolean;
    limit: number;
    cursor?: UploadCursor;
  }): Promise<{ items: ModerationItem[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const rows: ModerationItem[] = [];
    for (const photo of this.photos.values()) {
      if (input.albumId && photo.albumId !== input.albumId) continue;
      if (input.state && photo.moderationState !== input.state) continue;
      const open = this.reports.filter((row) => row.photoId === photo.id && row.state === "open");
      const counting = new Set(
        open.filter((row) => countsTowardModeration(row.reason)).map((row) => row.reporterId),
      );
      const notMe = new Set(
        open.filter((row) => row.reason === "not_me").map((row) => row.reporterId),
      );
      // Everything a moderator still has to look at: not approved, or approved with an open
      // report whose reason COUNTS. `not_me` alone never queues a photo (it is the normal
      // error mode of face matching and would bury two moderators); `includeNotMe` asks for
      // those on purpose.
      const queued =
        photo.moderationState !== "approved" ||
        counting.size > 0 ||
        (input.includeNotMe === true && notMe.size > 0);
      if (!queued) continue;
      if (cursor) {
        const byTime = photo.createdAt.getTime() - cursor.createdAt.getTime();
        if (!(byTime < 0 || (byTime === 0 && photo.id < cursor.id))) continue;
      }
      rows.push({
        photoId: photo.id,
        albumId: photo.albumId,
        eventId: photo.eventId,
        uploaderId: photo.photographerId,
        moderationState: photo.moderationState,
        createdAt: photo.createdAt,
        openReports: counting.size,
        reasons: [...new Set(open.map((row) => row.reason))].sort(compareText),
        notMeReports: notMe.size,
        thumbKey: this.derivativeKey(photo.id, "thumb"),
        webKey: this.derivativeKey(photo.id, "web"),
      });
    }
    rows.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || compareText(b.photoId, a.photoId),
    );
    const items = rows.slice(0, input.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.photoId } : null;
    return { items, nextCursor };
  }

  async listAlbumPhotosPage(
    albumId: string,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: AlbumPhoto[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const rows: AlbumPhoto[] = [];
    for (const photo of this.photos.values()) {
      // `approved` only: a photo the report threshold flipped to `pending` leaves the feed.
      if (photo.albumId !== albumId || photo.moderationState !== "approved") continue;
      const thumbKey = this.derivativeKey(photo.id, "thumb");
      const webKey = this.derivativeKey(photo.id, "web");
      if (!thumbKey || !webKey) continue;
      if (cursor) {
        const byTime = photo.createdAt.getTime() - cursor.createdAt.getTime();
        if (!(byTime < 0 || (byTime === 0 && photo.id < cursor.id))) continue;
      }
      rows.push({
        id: photo.id,
        albumId: photo.albumId,
        uploaderId: photo.photographerId,
        createdAt: photo.createdAt,
        thumbKey,
        webKey,
      });
    }
    rows.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(b.id, a.id),
    );
    const items = rows.slice(0, input.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, nextCursor };
  }

  /** v6 (agent C): the stored key of one derivative, or null when it is not there yet. */
  private derivativeKey(photoId: string, kind: "thumb" | "web"): string | null {
    const row = this.derivatives.find((item) => item.photoId === photoId && item.kind === kind);
    return row ? row.s3Key : null;
  }
}

type FeedbackRow = {
  userId: string;
  eventId: string;
  photoId: string;
  verdict: FeedbackVerdict;
  scoreAtTime: number | null;
  createdAt: Date;
};

type MatchRunStored = {
  id: string;
  userId: string;
  eventId: string;
  liveness: string | null;
  reason: string | null;
  selfieSha256: string | null;
  selfieFaces: number | null;
  engineMs: number | null;
  hits: number;
  createdAt: Date;
};

type MatchHitStored = {
  runId: string;
  photoId: string;
  externalFaceId: string;
  cosine: number;
  similarity: number;
  kept: boolean;
};

/** `galleries.last_match_reason` as the worker (agent A) records it on the in-memory gallery. */
function galleryReason(gallery: Gallery): string | null {
  const row = gallery as { lastMatchReason?: string | null; reason?: string | null };
  return row.lastMatchReason ?? row.reason ?? null;
}

function gallerySelfieKey(gallery: Gallery): string | null {
  return (gallery as { selfieKey?: string | null }).selfieKey ?? null;
}

/** `finished_at` / `duration_ms` as Postgres computes them when a job leaves `running`. */
function finishJob(job: JobRow): void {
  const now = new Date();
  job.finishedAt = now;
  job.durationMs = Math.max(0, now.getTime() - (job.claimedAt ?? now).getTime());
}

function cosineOf(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function seedInviteHash(): string {
  return createHash("sha256").update("seed-invite").digest("hex");
}

// ---- auth v6 (agent B) --------------------------------------------------------------------

type IdentityStored = {
  userId: string;
  provider: IdentityProvider;
  subject: string;
  email: string | null;
  createdAt: Date;
};

function identityKey(provider: IdentityProvider, subject: string): string {
  return `${provider}\u0000${subject}`;
}

function eventCodeKey(eventId: string, code: string): string {
  return `${eventId}\u0000${code}`;
}
