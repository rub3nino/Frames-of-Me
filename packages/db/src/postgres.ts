import { createHash, randomUUID } from "node:crypto";
import type { JobType, PhotoCollection, PhotoStatus, Role } from "@rephoto/contracts";
import {
  JOB_MAX_ATTEMPTS,
  JOB_PRIORITY,
  STALE_RUNNING_MS,
  THROTTLE_REQUEUE_SECONDS,
} from "@rephoto/contracts";
import { isUniqueViolation, type Sql } from "./sql.js";
import { DuplicateKeyError } from "./types.js";
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
  PhotosByStatus,
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
  PublicGalleryItem,
  BBox,
  ClaimOptions,
  GalleryMatchPatch,
  MatchHitInsert,
  MatchRunInsert,
  QueryVectorGallery,
} from "./types.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";
const INVITE_ID = "00000000-0000-4000-8000-000000000004";

const PHOTO_COLUMNS =
  "id, event_id, photographer_id, collection, sha256, status, original_key, content_type, bytes, original_status, indexed_at, error, created_at";
const EVENT_COLUMNS = "id, slug, name, retention_days, access, created_at";
const UPLOAD_COLUMNS =
  "id, event_id, photographer_id, collection, s3_upload_id, object_key, sha256, content_type, status, bytes, stage, photo_id, original_content_type, original_bytes, filename, tags, created_at";
const PHOTO_ADMIN_COLUMNS = `${PHOTO_COLUMNS}, filename, tags`;

function asContentType(value: string): ImageContentType {
  if (value === "image/jpeg" || value === "image/png") return value;
  throw new Error("Invalid content type");
}

export class PostgresDatabase implements Database {
  constructor(private readonly sql: Sql) {}

  async seedDemo(): Promise<void> {
    await this.sql`
      insert into events (id, slug, name, retention_days)
      values (${EVENT_ID}, 'demo', 'Demo', 90)
      on conflict (slug) do nothing
    `;
    await this.sql`
      insert into users (id, email, role)
      values (${ADMIN_ID}, 'admin@rephoto.local', 'admin')
      on conflict (email, role) do nothing
    `;
    await this.sql`
      insert into users (id, email, role)
      values (${PHOTOGRAPHER_ID}, 'photographer@rephoto.local', 'photographer')
      on conflict (email, role) do nothing
    `;
    const tokenHash = createHash("sha256").update("seed-invite").digest("hex");
    await this.sql`
      insert into invites (id, email, event_id, token_hash, role, expires_at, used_at)
      values (
        ${INVITE_ID},
        'photographer@rephoto.local',
        ${EVENT_ID},
        ${tokenHash},
        'photographer',
        now() + interval '365 days',
        now()
      )
      on conflict (id) do nothing
    `;
    await this.sql`
      insert into event_photographers (event_id, user_id)
      values (${EVENT_ID}, ${PHOTOGRAPHER_ID})
      on conflict (event_id, user_id) do nothing
    `;
  }

  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  async findEventBySlug(slug: string): Promise<EventRow | null> {
    const rows = await this.sql<EventSql[]>`
      select ${this.sql.unsafe(EVENT_COLUMNS)} from events where slug = ${slug}
    `;
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async findEventById(id: string): Promise<EventRow | null> {
    const rows = await this.sql<EventSql[]>`
      select ${this.sql.unsafe(EVENT_COLUMNS)} from events where id = ${id}
    `;
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async updateEvent(
    id: string,
    patch: { access?: EventAccess; retentionDays?: number },
  ): Promise<EventRow | null> {
    const rows = await this.sql<EventSql[]>`
      update events
      set access = coalesce(${patch.access ?? null}, access),
          retention_days = coalesce(${patch.retentionDays ?? null}, retention_days)
      where id = ${id}
      returning ${this.sql.unsafe(EVENT_COLUMNS)}
    `;
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const rows = await this.sql<UserSql[]>`
      select id, email, role, created_at from users where id = ${id}
    `;
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserByEmailRole(email: string, role: Role): Promise<UserRow | null> {
    const rows = await this.sql<UserSql[]>`
      select id, email, role, created_at from users
      where email = ${email} and role = ${role}
    `;
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async insertUser(email: string, role: Role): Promise<UserRow> {
    return this.createUser({ email, role });
  }

  async createUser(input: { id?: string; email: string; role: Role }): Promise<UserRow> {
    const existing = await this.findUserByEmailRole(input.email, input.role);
    if (existing) return existing;
    const id = input.id ?? randomUUID();
    const rows = await this.sql<UserSql[]>`
      insert into users (id, email, role)
      values (${id}, ${input.email}, ${input.role})
      returning id, email, role, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error("User insert failed");
    return mapUser(row);
  }

  async setUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.sql`update users set password_hash = ${passwordHash} where id = ${userId}`;
  }

  async findUserForLogin(
    email: string,
    role: Role,
  ): Promise<{ user: UserRow; passwordHash: string | null } | null> {
    const rows = await this.sql<(UserSql & { password_hash: string | null })[]>`
      select id, email, role, created_at, password_hash from users
      where email = ${email} and role = ${role}
    `;
    const row = rows[0];
    if (!row) return null;
    return { user: mapUser(row), passwordHash: row.password_hash };
  }

  async insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
  }): Promise<void> {
    await this.sql`
      insert into magic_links (email, role, token_hash, expires_at, ip)
      values (${input.email}, ${input.role}, ${input.tokenHash}, ${input.expiresAt}, ${input.ip})
    `;
  }

  async countMagicLinksSince(input: { email?: string; ip?: string; since: Date }): Promise<number> {
    if (input.email === undefined && input.ip === undefined) return 0;
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from magic_links
      where created_at >= ${input.since}
        ${input.email === undefined ? this.sql`` : this.sql`and email = ${input.email}`}
        ${input.ip === undefined ? this.sql`` : this.sql`and ip = ${input.ip}`}
    `;
    return rows[0]?.count ?? 0;
  }

  async consumeMagicLink(tokenHash: string): Promise<{ email: string; role: Role } | null> {
    const rows = await this.sql<{ email: string; role: Role }[]>`
      update magic_links
      set used_at = now()
      where token_hash = ${tokenHash} and used_at is null and expires_at > now()
      returning email, role
    `;
    return rows[0] ?? null;
  }

  async insertSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.sql`
      insert into sessions (user_id, token_hash, expires_at)
      values (${input.userId}, ${input.tokenHash}, ${input.expiresAt})
    `;
  }

  async findUserBySession(tokenHash: string): Promise<UserRow | null> {
    const rows = await this.sql<UserSql[]>`
      select u.id, u.email, u.role, u.created_at
      from sessions s join users u on u.id = s.user_id
      where s.token_hash = ${tokenHash} and s.expires_at > now()
    `;
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.sql`delete from sessions where token_hash = ${tokenHash}`;
  }

  async insertConsent(input: {
    userId: string;
    eventId: string;
    textVersion: string;
    ip: string;
    userAgent: string;
  }): Promise<{ id: string; grantedAt: Date }> {
    const rows = await this.sql<{ id: string; granted_at: Date }[]>`
      insert into consents (user_id, event_id, text_version, ip, user_agent)
      values (${input.userId}, ${input.eventId}, ${input.textVersion}, ${input.ip}, ${input.userAgent})
      returning id, granted_at
    `;
    const row = rows[0];
    if (!row) throw new Error("Consent insert failed");
    return { id: row.id, grantedAt: row.granted_at };
  }

  async hasActiveConsent(userId: string, eventId: string): Promise<boolean> {
    const rows = await this.sql<{ ok: number }[]>`
      select 1 as ok from consents
      where user_id = ${userId} and event_id = ${eventId} and withdrawn_at is null
    `;
    return rows.length > 0;
  }

  async countMatchJobsSince(userId: string, since: Date): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from jobs
      where type = 'match' and payload->>'userId' = ${userId} and created_at >= ${since}
    `;
    return rows[0]?.count ?? 0;
  }

  async findPhotoBySha(eventId: string, sha256: string): Promise<PhotoRow | null> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos where event_id = ${eventId} and sha256 = ${sha256}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  async findOwnPhotoBySha(
    photographerId: string,
    eventId: string,
    sha256: string,
  ): Promise<PhotoRow | null> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos
      where event_id = ${eventId} and sha256 = ${sha256} and photographer_id = ${photographerId}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  async insertUploadSession(input: {
    id: string;
    eventId: string;
    photographerId: string;
    collection?: PhotoCollection;
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
  }): Promise<void> {
    await this.sql`
      insert into upload_sessions (
        id, event_id, photographer_id, collection, s3_upload_id, object_key, sha256, content_type, status, bytes,
        stage, photo_id, original_content_type, original_bytes, filename, tags
      ) values (
        ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.collection ?? "official"}, ${input.s3UploadId},
        ${input.objectKey}, ${input.sha256}, ${input.contentType}, 'open', ${input.bytes},
        ${input.stage ?? "original"}, ${input.photoId ?? null},
        ${input.originalContentType ?? null}, ${input.originalBytes ?? null},
        ${input.filename ?? null}, ${input.tags ?? []}::text[]
      )
    `;
  }

  async findUploadSession(id: string): Promise<UploadSessionRow | null> {
    const rows = await this.sql<UploadSql[]>`
      select ${this.sql.unsafe(UPLOAD_COLUMNS)}
      from upload_sessions where id = ${id}
    `;
    return rows[0] ? mapUpload(rows[0]) : null;
  }

  async markUploadSession(id: string, status: "completed" | "aborted"): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update upload_sessions set status = ${status}
      where id = ${id} and status = 'open'
      returning id
    `;
    return rows.length > 0;
  }

  async listUploadSessions(photographerId: string, eventId: string): Promise<UploadSessionRow[]> {
    const rows = await this.sql<UploadSql[]>`
      select ${this.sql.unsafe(UPLOAD_COLUMNS)}
      from upload_sessions
      where photographer_id = ${photographerId} and event_id = ${eventId}
      order by created_at desc
    `;
    return rows.map(mapUpload);
  }

  async listUploadSessionsPage(
    photographerId: string,
    eventId: string,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: UploadSessionRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    // The cursor round-trips through a JS Date (millisecond precision) while created_at keeps
    // microseconds: order and compare on the truncated value so rows sharing a millisecond
    // are neither skipped nor repeated.
    const rows = await this.sql<UploadSql[]>`
      select ${this.sql.unsafe(UPLOAD_COLUMNS)}
      from upload_sessions
      where photographer_id = ${photographerId} and event_id = ${eventId}
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', created_at), id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : this.sql``
        }
      order by date_trunc('milliseconds', created_at) desc, id desc
      limit ${input.limit + 1}
    `;
    const items = rows.slice(0, input.limit).map(mapUpload);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, nextCursor };
  }

  async uploadSummary(photographerId: string, eventId: string): Promise<UploadSummary> {
    const sessions = await this.sql<{ status: string; count: number }[]>`
      select status, count(*)::int as count from upload_sessions
      where photographer_id = ${photographerId} and event_id = ${eventId}
      group by status
    `;
    const photos = await this.sql<{ status: PhotoStatus; count: number }[]>`
      select status, count(*)::int as count from photos
      where photographer_id = ${photographerId} and event_id = ${eventId}
      group by status
    `;
    const pending = await this.sql<{ count: number }[]>`
      select count(*)::int as count from photos
      where photographer_id = ${photographerId} and event_id = ${eventId}
        and original_status = 'pending'
    `;
    const summary: UploadSummary = {
      sessions: { open: 0, completed: 0, aborted: 0 },
      photos: { ...emptyPhotosByStatus(), originalsPending: pending[0]?.count ?? 0 },
    };
    for (const row of sessions) {
      if (row.status in summary.sessions) {
        summary.sessions[row.status as keyof UploadSummary["sessions"]] = row.count;
      }
    }
    for (const row of photos) {
      if (row.status in summary.photos) summary.photos[row.status] = row.count;
    }
    return summary;
  }

  async abortStaleUploads(input: { olderThan: Date }): Promise<StaleUpload[]> {
    const rows = await this.sql<{ id: string; object_key: string; s3_upload_id: string | null }[]>`
      update upload_sessions set status = 'aborted'
      where status = 'open' and created_at < ${input.olderThan}
      returning id, object_key, s3_upload_id
    `;
    return rows.map((row) => ({
      id: row.id,
      objectKey: row.object_key,
      s3UploadId: row.s3_upload_id,
    }));
  }

  async insertPhoto(input: {
    id: string;
    eventId: string;
    photographerId: string;
    collection?: PhotoCollection;
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
    originalStatus?: OriginalStatus;
    filename?: string | null;
    tags?: string[];
  }): Promise<PhotoRow> {
    try {
      const rows = await this.sql<PhotoSql[]>`
        insert into photos (
          id, event_id, photographer_id, collection, sha256, status, original_key, content_type, bytes, original_status,
          filename, tags
        )
        values (
          ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.collection ?? "official"}, ${input.sha256},
          'uploaded', ${input.originalKey}, ${input.contentType}, ${input.bytes},
          ${input.originalStatus ?? "present"}, ${input.filename ?? null}, ${input.tags ?? []}::text[]
        )
        returning ${this.sql.unsafe(PHOTO_COLUMNS)}
      `;
      const row = rows[0];
      if (!row) throw new Error("Photo insert failed");
      return mapPhoto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError();
      throw error;
    }
  }

  async findPhoto(id: string): Promise<PhotoRow | null> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos where id = ${id}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  async listPhotosByPhotographer(photographerId: string): Promise<PhotoRow[]> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos where photographer_id = ${photographerId}
    `;
    return rows.map(mapPhoto);
  }

  async setPhotoStatus(id: string, status: PhotoStatus): Promise<void> {
    await this.sql`update photos set status = ${status} where id = ${id}`;
  }

  async setOriginalStatus(photoId: string, status: OriginalStatus): Promise<void> {
    await this.sql`update photos set original_status = ${status} where id = ${photoId}`;
  }

  async setPhotoErrorText(photoId: string, error: string | null): Promise<void> {
    await this.sql`update photos set error = ${error} where id = ${photoId}`;
  }

  async setPhotoIndexed(id: string): Promise<void> {
    await this.sql`
      update photos set status = 'indexed', indexed_at = now(), error = null where id = ${id}
    `;
  }

  async setPhotoError(id: string, error: string): Promise<void> {
    await this.sql`
      update photos set status = 'error', error = ${error} where id = ${id}
    `;
  }

  async listPhotosCreatedBefore(
    eventId: string,
    cutoff: Date,
    limit?: number,
  ): Promise<PhotoRow[]> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos
      where event_id = ${eventId} and created_at < ${cutoff}
      order by created_at
      ${limit === undefined ? this.sql`` : this.sql`limit ${limit}`}
    `;
    return rows.map(mapPhoto);
  }

  async countPhotos(eventId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from photos where event_id = ${eventId}
    `;
    return rows[0]?.count ?? 0;
  }

  async listPhotosByIds(ids: string[]): Promise<PhotoRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos where id = any(${ids}::uuid[])
    `;
    return rows.map(mapPhoto);
  }

  async listPublicGallery(
    eventId: string,
    input: { limit: number; offset: number },
  ): Promise<PublicGalleryItem[]> {
    const rows = await this.sql<{
      photo_id: string;
      created_at: Date;
      thumb_key: string;
      web_key: string;
      original_status: OriginalStatus;
    }[]>`
      select p.id as photo_id, p.created_at, t.s3_key as thumb_key, w.s3_key as web_key,
             p.original_status
      from photos p
      join derivatives t on t.photo_id = p.id and t.kind = 'thumb'
      join derivatives w on w.photo_id = p.id and w.kind = 'web'
      where p.event_id = ${eventId} and p.collection = 'public' and p.status = 'indexed'
      order by p.created_at desc, p.id desc
      limit ${input.limit} offset ${input.offset}
    `;
    return rows.map((row) => ({
      photoId: row.photo_id,
      createdAt: row.created_at,
      thumbKey: row.thumb_key,
      webKey: row.web_key,
      originalReady: row.original_status === "present",
    }));
  }

  async listOwnedPhotos(userId: string, eventId: string, photoIds: string[]): Promise<PhotoRow[]> {
    if (photoIds.length === 0) return [];
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(prefixColumns("p", PHOTO_COLUMNS))}
      from photos p
      join gallery_items gi on gi.photo_id = p.id
      join galleries g on g.id = gi.gallery_id
      where g.user_id = ${userId} and g.event_id = ${eventId}
        and p.id = any(${photoIds}::uuid[])
    `;
    return rows.map(mapPhoto);
  }

  async upsertDerivative(input: {
    photoId: string;
    kind: "thumb" | "web";
    s3Key: string;
  }): Promise<void> {
    await this.sql`
      insert into derivatives (photo_id, kind, s3_key)
      values (${input.photoId}, ${input.kind}, ${input.s3Key})
      on conflict (photo_id, kind) do update set s3_key = excluded.s3_key
    `;
  }

  async listDerivatives(
    photoId: string,
  ): Promise<Array<{ kind: "thumb" | "web"; s3Key: string }>> {
    const rows = await this.sql<{ kind: "thumb" | "web"; s3_key: string }[]>`
      select kind, s3_key from derivatives where photo_id = ${photoId}
    `;
    return rows.map((row) => ({ kind: row.kind, s3Key: row.s3_key }));
  }

  async listDerivativeKeys(photoIds: string[]): Promise<string[]> {
    if (photoIds.length === 0) return [];
    const rows = await this.sql<{ s3_key: string }[]>`
      select s3_key from derivatives where photo_id = any(${photoIds}::uuid[])
    `;
    return rows.map((row) => row.s3_key);
  }

  async replaceFaces(photoId: string, eventId: string, faces: FaceInsert[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from gallery_items where face_id in (select id from faces where photo_id = ${photoId})`;
      await tx`delete from faces where photo_id = ${photoId}`;
      for (const face of faces) {
        await tx`
          insert into faces (photo_id, event_id, external_id, bbox, confidence)
          values (
            ${photoId}, ${eventId}, ${face.externalId},
            ${tx.json(face.bbox)}, ${face.confidence}
          )
        `;
      }
    });
  }

  async listExternalIds(photoId: string): Promise<string[]> {
    const rows = await this.sql<{ external_id: string }[]>`
      select external_id from faces where photo_id = ${photoId}
    `;
    return rows.map((row) => row.external_id);
  }

  async listExternalIdsForPhotos(photoIds: string[]): Promise<string[]> {
    if (photoIds.length === 0) return [];
    const rows = await this.sql<{ external_id: string }[]>`
      select external_id from faces where photo_id = any(${photoIds}::uuid[])
    `;
    return rows.map((row) => row.external_id);
  }

  async findFaceRowsByPhoto(photoId: string): Promise<Array<{ id: string; externalId: string }>> {
    const rows = await this.sql<{ id: string; external_id: string }[]>`
      select id, external_id from faces where photo_id = ${photoId}
    `;
    return rows.map((row) => ({ id: row.id, externalId: row.external_id }));
  }

  async findFaceByExternalId(
    eventId: string,
    externalId: string,
  ): Promise<{ id: string; photoId: string } | null> {
    const rows = await this.sql<{ id: string; photo_id: string }[]>`
      select id, photo_id from faces
      where event_id = ${eventId} and external_id = ${externalId}
    `;
    const row = rows[0];
    return row ? { id: row.id, photoId: row.photo_id } : null;
  }

  async findFacesByExternalIds(
    eventId: string,
    externalIds: string[],
  ): Promise<Array<{ id: string; photoId: string; externalId: string }>> {
    if (externalIds.length === 0) return [];
    const rows = await this.sql<{ id: string; photo_id: string; external_id: string }[]>`
      select id, photo_id, external_id from faces
      where event_id = ${eventId} and external_id = any(${externalIds})
    `;
    return rows.map((row) => ({
      id: row.id,
      photoId: row.photo_id,
      externalId: row.external_id,
    }));
  }

  async replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
    anchors: string[],
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into galleries (user_id, event_id, anchor_face_ids, matched_at, notified_at)
        values (${userId}, ${eventId}, ${anchors}::text[], now(), now())
        on conflict (user_id, event_id) do update
          set anchor_face_ids = excluded.anchor_face_ids,
              matched_at = now(),
              notified_at = now()
        returning id
      `;
      const galleryId = rows[0]?.id;
      if (!galleryId) throw new Error("Gallery upsert failed");
      await tx`delete from gallery_items where gallery_id = ${galleryId}`;
      const unique = dedupeByPhoto(items);
      if (unique.length === 0) return;
      const values = unique.map((item) => ({
        gallery_id: galleryId,
        photo_id: item.photoId,
        face_id: item.faceId,
        score: item.score,
        source: "match",
      }));
      await tx`insert into gallery_items ${tx(values)}`;
    });
  }

  async listGallery(userId: string, eventId: string): Promise<GalleryItemRow[]> {
    const rows = await this.sql<{ photo_id: string; face_id: string; score: number }[]>`
      select gi.photo_id, gi.face_id, gi.score
      from gallery_items gi
      join galleries g on g.id = gi.gallery_id
      where g.user_id = ${userId} and g.event_id = ${eventId}
    `;
    return rows.map((row) => ({
      photoId: row.photo_id,
      faceId: row.face_id,
      score: Number(row.score),
    }));
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
    const vectors = await this.queryVectorAvailable();
    const rows = await this.sql<{
      id: string;
      anchor_face_ids: string[];
      matched_at: Date | null;
      last_match_reason: string | null;
      selfie_key: string | null;
      has_vector: boolean;
    }[]>`
      select id, anchor_face_ids, matched_at, last_match_reason, selfie_key,
             ${vectors ? this.sql`(query_embedding is not null)` : this.sql`false`} as has_vector
      from galleries
      where user_id = ${userId} and event_id = ${eventId}
    `;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          anchorFaceIds: row.anchor_face_ids,
          matchedAt: row.matched_at,
          reason: row.last_match_reason,
          selfieKey: row.selfie_key,
          hasQueryVector: row.has_vector === true,
        }
      : null;
  }

  async listGalleryPage(
    userId: string,
    eventId: string,
    input: { limit: number; cursor?: GalleryCursor },
  ): Promise<GalleryPage> {
    const cursor = input.cursor;
    const rows = await this.sql<{
      photo_id: string;
      score: number;
      source: GalleryItemSource;
      created_at: Date;
      thumb_key: string;
      web_key: string;
      original_status: OriginalStatus;
    }[]>`
      select gi.photo_id, gi.score, gi.source, gi.created_at,
             t.s3_key as thumb_key, w.s3_key as web_key, p.original_status
      from gallery_items gi
      join galleries g on g.id = gi.gallery_id
      join photos p on p.id = gi.photo_id
      join derivatives t on t.photo_id = gi.photo_id and t.kind = 'thumb'
      join derivatives w on w.photo_id = gi.photo_id and w.kind = 'web'
      where g.user_id = ${userId} and g.event_id = ${eventId}
        ${
          cursor
            ? this.sql`and (gi.score < ${cursor.score} or (gi.score = ${cursor.score} and gi.photo_id > ${cursor.photoId}::uuid))`
            : this.sql``
        }
      order by gi.score desc, gi.photo_id asc
      limit ${input.limit}
    `;
    const totals = await this.sql<{ count: number }[]>`
      select count(*)::int as count
      from gallery_items gi
      join galleries g on g.id = gi.gallery_id
      join derivatives t on t.photo_id = gi.photo_id and t.kind = 'thumb'
      join derivatives w on w.photo_id = gi.photo_id and w.kind = 'web'
      where g.user_id = ${userId} and g.event_id = ${eventId}
    `;
    return {
      total: totals[0]?.count ?? 0,
      items: rows.map((row) => ({
        photoId: row.photo_id,
        score: Number(row.score),
        source: row.source,
        createdAt: row.created_at,
        thumbKey: row.thumb_key,
        webKey: row.web_key,
        originalReady: row.original_status === "present",
      })),
    };
  }

  async countAnchoredGalleries(eventId: string): Promise<number> {
    const vectors = await this.queryVectorAvailable();
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from galleries
      where event_id = ${eventId}
        and (cardinality(anchor_face_ids) > 0
             ${vectors ? this.sql`or query_embedding is not null` : this.sql``})
    `;
    return rows[0]?.count ?? 0;
  }

  async countGalleriesWithQueryVector(eventId: string): Promise<number> {
    if (!(await this.queryVectorAvailable())) return 0;
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from galleries
      where event_id = ${eventId} and query_embedding is not null
    `;
    return rows[0]?.count ?? 0;
  }

  async findGalleriesByAnchors(eventId: string, externalFaceIds: string[]): Promise<AnchoredGallery[]> {
    if (externalFaceIds.length === 0) return [];
    const rows = await this.sql<{
      id: string;
      user_id: string;
      anchor_face_ids: string[];
      notified_at: Date | null;
    }[]>`
      select id, user_id, anchor_face_ids, notified_at from galleries
      where event_id = ${eventId} and anchor_face_ids && ${externalFaceIds}::text[]
    `;
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      anchorFaceIds: row.anchor_face_ids,
      notifiedAt: row.notified_at,
    }));
  }

  async addGalleryItems(
    galleryId: string,
    items: Array<{ photoId: string; faceId: string; score: number; source: GalleryItemSource }>,
  ): Promise<number> {
    const unique = dedupeByPhoto(items);
    if (unique.length === 0) return 0;
    const values = unique.map((item) => ({
      gallery_id: galleryId,
      photo_id: item.photoId,
      face_id: item.faceId,
      score: item.score,
      source: item.source,
    }));
    const rows = await this.sql<{ inserted: boolean }[]>`
      insert into gallery_items ${this.sql(values)}
      on conflict (gallery_id, photo_id) do update
        set score = greatest(gallery_items.score, excluded.score)
      returning (xmax = 0) as inserted
    `;
    return rows.filter((row) => row.inserted).length;
  }

  async markGalleryNotified(galleryId: string, at: Date): Promise<void> {
    await this.sql`update galleries set notified_at = ${at} where id = ${galleryId}`;
  }

  async removeAnchors(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    await this.sql`
      update galleries
      set anchor_face_ids = coalesce(
        (select array_agg(x) from unnest(anchor_face_ids) x where x <> all(${externalFaceIds}::text[])),
        '{}'::text[]
      )
      where event_id = ${eventId} and anchor_face_ids && ${externalFaceIds}::text[]
    `;
  }

  async latestMatchJob(
    userId: string,
    eventId: string,
  ): Promise<{ status: "queued" | "running" | "done" | "error" } | null> {
    const rows = await this.sql<{ status: "queued" | "running" | "done" | "error" }[]>`
      select status from jobs
      where type = 'match'
        and payload->>'userId' = ${userId}
        and payload->>'eventId' = ${eventId}
      order by created_at desc
      limit 1
    `;
    const row = rows[0];
    return row ? { status: row.status } : null;
  }

  async deletePhoto(photoId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from gallery_items where photo_id = ${photoId}`;
      await tx`delete from faces where photo_id = ${photoId}`;
      await tx`delete from face_index where photo_id = ${photoId}`;
      await tx`delete from photos where id = ${photoId}`;
    });
  }

  async deleteParticipant(userId: string): Promise<boolean> {
    const user = await this.findUserById(userId);
    if (!user || user.role !== "participant") return false;
    await this.sql.begin(async (tx) => {
      await tx`delete from gallery_items where gallery_id in (select id from galleries where user_id = ${userId})`;
      await tx`delete from galleries where user_id = ${userId}`;
      await tx`delete from consents where user_id = ${userId}`;
      await tx`delete from sessions where user_id = ${userId}`;
      if (user) {
        await tx`delete from magic_links where email = ${user.email} and role = ${user.role}`;
      }
      await tx`delete from users where id = ${userId}`;
    });
    return true;
  }

  async insertInvite(input: {
    email: string;
    eventId: string;
    tokenHash: string;
    role: Role;
    expiresAt: Date;
  }): Promise<string> {
    const rows = await this.sql<{ id: string }[]>`
      insert into invites (email, event_id, token_hash, role, expires_at)
      values (${input.email}, ${input.eventId}, ${input.tokenHash}, ${input.role}, ${input.expiresAt})
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("Invite insert failed");
    return id;
  }

  async consumeInvite(
    tokenHash: string,
  ): Promise<{ email: string; role: Role; eventId: string } | null> {
    const rows = await this.sql<{ email: string; role: Role; event_id: string }[]>`
      update invites
      set used_at = now()
      where token_hash = ${tokenHash} and used_at is null and expires_at > now()
      returning email, role, event_id
    `;
    const row = rows[0];
    return row ? { email: row.email, role: row.role, eventId: row.event_id } : null;
  }

  async addEventPhotographer(eventId: string, userId: string): Promise<void> {
    await this.sql`
      insert into event_photographers (event_id, user_id)
      values (${eventId}, ${userId})
      on conflict (event_id, user_id) do nothing
    `;
  }

  async isEventPhotographer(eventId: string, userId: string): Promise<boolean> {
    const rows = await this.sql<{ ok: number }[]>`
      select 1 as ok from event_photographers
      where event_id = ${eventId} and user_id = ${userId}
    `;
    return rows.length > 0;
  }

  async upsertEventParticipants(eventId: string, emails: string[]): Promise<number> {
    const unique = [...new Set(emails)];
    if (unique.length === 0) return 0;
    const values = unique.map((email) => ({ event_id: eventId, email }));
    const rows = await this.sql<{ email: string }[]>`
      insert into event_participants ${this.sql(values)}
      on conflict (event_id, email) do nothing
      returning email
    `;
    return rows.length;
  }

  async isEventParticipant(eventId: string, email: string): Promise<boolean> {
    const rows = await this.sql<{ ok: number }[]>`
      select 1 as ok from event_participants
      where event_id = ${eventId} and email = ${email}
    `;
    return rows.length > 0;
  }

  async insertAudit(input: {
    actorId: string | null;
    action: string;
    target: string;
    meta: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      insert into audit_log (actor_id, action, target, meta)
      values (${input.actorId}, ${input.action}, ${input.target}, ${JSON.stringify(input.meta)}::jsonb)
    `;
  }

  async metrics(): Promise<Metrics> {
    const rows = await this.sql<{
      events: number;
      photos: number;
      faces: number;
      users: number;
      galleries: number;
      jobs_queued: number;
      jobs_running: number;
      jobs_error: number;
      photos_uploaded: number;
      photos_processing: number;
      photos_indexed: number;
      photos_error: number;
      originals_pending: number;
    }[]>`
      select
        (select count(*)::int from events) as events,
        -- Approximate (pg_stat_user_tables.n_live_tup): exact counts over 150k photos / 500k
        -- faces are full scans on every admin page load (v5, B).
        coalesce((select n_live_tup::int from pg_stat_user_tables where relname = 'photos'), 0) as photos,
        coalesce((select n_live_tup::int from pg_stat_user_tables where relname = 'faces'), 0) as faces,
        coalesce((select n_live_tup::int from pg_stat_user_tables where relname = 'users'), 0) as users,
        (select count(*)::int from galleries) as galleries,
        (select count(*)::int from jobs where status = 'queued') as jobs_queued,
        (select count(*)::int from jobs where status = 'running') as jobs_running,
        (select count(*)::int from jobs where status = 'error') as jobs_error,
        (select count(*)::int from photos where status = 'uploaded') as photos_uploaded,
        (select count(*)::int from photos where status = 'processing') as photos_processing,
        (select count(*)::int from photos where status = 'indexed') as photos_indexed,
        (select count(*)::int from photos where status = 'error') as photos_error,
        (select count(*)::int from photos where original_status = 'pending') as originals_pending
    `;
    const row = rows[0];
    return {
      events: row?.events ?? 0,
      photos: row?.photos ?? 0,
      faces: row?.faces ?? 0,
      users: row?.users ?? 0,
      jobsQueued: row?.jobs_queued ?? 0,
      jobsRunning: row?.jobs_running ?? 0,
      jobsError: row?.jobs_error ?? 0,
      photosByStatus: {
        uploaded: row?.photos_uploaded ?? 0,
        processing: row?.photos_processing ?? 0,
        indexed: row?.photos_indexed ?? 0,
        error: row?.photos_error ?? 0,
      },
      galleries: row?.galleries ?? 0,
      originalsPending: row?.originals_pending ?? 0,
    };
  }

  async enqueueJob(type: JobType, payload: unknown, opts: EnqueueJobOptions = {}): Promise<string> {
    const priority = opts.priority ?? JOB_PRIORITY[type];
    const dedupeKey = opts.dedupeKey ?? null;
    const runAfter = opts.runAfter ?? null;
    const json = this.sql.json(payload as Parameters<Sql["json"]>[0]);
    // The partial unique index on active dedupe keys makes `do nothing` safe;
    // the loop covers the active job finishing between the insert and the select.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.sql<{ id: string }[]>`
        insert into jobs (type, payload, priority, dedupe_key, run_after)
        values (${type}, ${json}, ${priority}, ${dedupeKey}, coalesce(${runAfter}::timestamptz, now()))
        on conflict do nothing
        returning id
      `;
      const id = inserted[0]?.id;
      if (id) return id;
      if (dedupeKey === null) break;
      const existing = await this.sql<{ id: string }[]>`
        select id from jobs
        where dedupe_key = ${dedupeKey} and status in ('queued', 'running')
        limit 1
      `;
      const existingId = existing[0]?.id;
      if (existingId) return existingId;
    }
    throw new Error("Job insert failed");
  }

  async claimJob(options: ClaimOptions = {}): Promise<ClaimedJob | null> {
    const staleSeconds = STALE_RUNNING_MS / 1000;
    const excluded = [...(options.excludeTypes ?? [])];
    return this.sql.begin(async (tx) => {
      await tx`
        update jobs
        set status = 'queued', claimed_at = null
        where status = 'running'
          and coalesce(claimed_at, created_at) < now() - (${staleSeconds} * interval '1 second')
      `;
      const rows = await tx<{
        id: string;
        type: JobType;
        payload: unknown;
        attempts: number;
      }[]>`
        update jobs
        set status = 'running', claimed_at = now()
        where id = (
          select id from jobs
          where status = 'queued' and run_after <= now()
            ${excluded.length > 0 ? tx`and type <> all(${excluded}::text[])` : tx``}
          order by priority asc, run_after asc, created_at asc
          for update skip locked
          limit 1
        )
        returning id, type, payload, attempts
      `;
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, type: row.type, payload: row.payload, attempts: row.attempts };
    });
  }

  async completeJob(id: string): Promise<void> {
    await this.sql`
      update jobs
      set status = 'done', ${this.sql.unsafe(JOB_FINISHED_SQL)}
      where id = ${id}
    `;
  }

  async failJob(id: string, error: string): Promise<"queued" | "error"> {
    const current = await this.sql<{ attempts: number }[]>`
      select attempts from jobs where id = ${id}
    `;
    const next = (current[0]?.attempts ?? 0) + 1;
    if (next >= JOB_MAX_ATTEMPTS) {
      await this.sql`
        update jobs
        set status = 'error', attempts = ${next}, last_error = ${error},
            ${this.sql.unsafe(JOB_FINISHED_SQL)}, claimed_at = null
        where id = ${id}
      `;
      return "error";
    }
    const delaySeconds = next * 30;
    await this.sql`
      update jobs
      set status = 'queued',
          attempts = ${next},
          last_error = ${error},
          ${this.sql.unsafe(JOB_FINISHED_SQL)},
          claimed_at = null,
          run_after = now() + (${delaySeconds} * interval '1 second')
      where id = ${id}
    `;
    return "queued";
  }

  async failJobTerminal(id: string, error: string): Promise<void> {
    await this.sql`
      update jobs
      set status = 'error', attempts = ${JOB_MAX_ATTEMPTS}, last_error = ${error},
          ${this.sql.unsafe(JOB_FINISHED_SQL)}, claimed_at = null
      where id = ${id}
    `;
  }

  async requeueJob(id: string, error: string): Promise<void> {
    await this.sql`
      update jobs
      set status = 'queued',
          last_error = ${error},
          ${this.sql.unsafe(JOB_FINISHED_SQL)},
          claimed_at = null,
          run_after = now() + (${THROTTLE_REQUEUE_SECONDS} * interval '1 second')
      where id = ${id}
    `;
  }

  async pruneJobs(input: { doneOlderThan: Date }): Promise<number> {
    const result = await this.sql`
      delete from jobs where status = 'done' and created_at < ${input.doneOlderThan}
    `;
    return result.count;
  }

  // ---- recognition + robustness v5 (agent A) --------------------------------------------

  async updateGalleryMatch(userId: string, eventId: string, patch: GalleryMatchPatch): Promise<void> {
    const vectors = patch.queryEmbedding === undefined ? false : await this.queryVectorAvailable();
    const vector = patch.queryEmbedding ? `[${patch.queryEmbedding.join(",")}]` : null;
    await this.sql`
      insert into galleries (user_id, event_id, anchor_face_ids, last_match_reason, selfie_key)
      values (${userId}, ${eventId}, '{}'::text[], ${patch.lastMatchReason ?? null}, ${patch.selfieKey ?? null})
      on conflict (user_id, event_id) do update
        set last_match_reason = ${
          patch.lastMatchReason === undefined
            ? this.sql`galleries.last_match_reason`
            : this.sql`${patch.lastMatchReason}`
        },
            selfie_key = ${
              patch.selfieKey === undefined ? this.sql`galleries.selfie_key` : this.sql`${patch.selfieKey}`
            }
    `;
    if (!vectors) return;
    await this.sql`
      update galleries set query_embedding = ${vector}::vector
      where user_id = ${userId} and event_id = ${eventId}
    `;
  }

  async findGalleriesByQueryVector(
    eventId: string,
    embedding: number[],
    minCosine: number,
  ): Promise<QueryVectorGallery[]> {
    if (!(await this.queryVectorAvailable())) return [];
    const vector = `[${embedding.join(",")}]`;
    const rows = await this.sql<{
      id: string;
      user_id: string;
      anchor_face_ids: string[];
      notified_at: Date | null;
      cos: number;
    }[]>`
      select id, user_id, anchor_face_ids, notified_at,
             1 - (query_embedding <=> ${vector}::vector) as cos
      from galleries
      where event_id = ${eventId} and query_embedding is not null
        and 1 - (query_embedding <=> ${vector}::vector) >= ${minCosine}
      order by query_embedding <=> ${vector}::vector
      limit ${QUERY_VECTOR_GALLERY_LIMIT}
    `;
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      anchorFaceIds: row.anchor_face_ids,
      notifiedAt: row.notified_at,
      cosine: Number(row.cos),
    }));
  }

  async insertMatchRun(input: MatchRunInsert): Promise<string> {
    const rows = await this.sql<{ id: string }[]>`
      insert into match_runs (user_id, event_id, liveness, reason, selfie_sha256, selfie_faces, engine_ms, hits)
      values (
        ${input.userId}, ${input.eventId}, ${input.liveness}, ${input.reason},
        ${input.selfieSha256}, ${input.selfieFaces}, ${input.engineMs}, ${input.hits}
      )
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("match_runs insert failed");
    return id;
  }

  async insertMatchHits(runId: string, hits: MatchHitInsert[]): Promise<void> {
    if (hits.length === 0) return;
    const seen = new Set<string>();
    const values = hits
      .filter((hit) => {
        const key = `${hit.photoId}:${hit.externalFaceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((hit) => ({
        run_id: runId,
        photo_id: hit.photoId,
        external_face_id: hit.externalFaceId,
        cosine: hit.cosine,
        similarity: hit.similarity,
        kept: hit.kept,
      }));
    for (let start = 0; start < values.length; start += MATCH_HITS_CHUNK) {
      await this.sql`
        insert into match_hits ${this.sql(values.slice(start, start + MATCH_HITS_CHUNK))}
        on conflict do nothing
      `;
    }
  }

  async touchJob(id: string): Promise<void> {
    await this.sql`update jobs set claimed_at = now() where id = ${id} and status = 'running'`;
  }

  async deleteGalleriesByEvent(eventId: string): Promise<number> {
    return this.sql.begin(async (tx) => {
      await tx`
        delete from gallery_items
        where gallery_id in (select id from galleries where event_id = ${eventId})
      `;
      const result = await tx`delete from galleries where event_id = ${eventId}`;
      return result.count;
    });
  }

  async listGallerySelfieKeys(eventId: string): Promise<string[]> {
    const rows = await this.sql<{ selfie_key: string }[]>`
      select selfie_key from galleries where event_id = ${eventId} and selfie_key is not null
    `;
    return rows.map((row) => row.selfie_key);
  }

  async listGallerySelfieKeysByUser(userId: string): Promise<string[]> {
    const rows = await this.sql<{ selfie_key: string }[]>`
      select selfie_key from galleries where user_id = ${userId} and selfie_key is not null
    `;
    return rows.map((row) => row.selfie_key);
  }

  async expireGalleryMatches(eventId: string, cutoff: Date): Promise<string[]> {
    const vectors = await this.queryVectorAvailable();
    const rows = await this.sql<{ selfie_key: string | null }[]>`
      update galleries
      set anchor_face_ids = '{}'::text[],
          selfie_key = null
          ${vectors ? this.sql`, query_embedding = null` : this.sql``}
      where event_id = ${eventId}
        and matched_at < ${cutoff}
        and (cardinality(anchor_face_ids) > 0
             or selfie_key is not null
             ${vectors ? this.sql`or query_embedding is not null` : this.sql``})
      returning selfie_key
    `;
    return rows.map((row) => row.selfie_key).filter((key): key is string => key !== null);
  }

  async deleteMatchRunsByEvent(eventId: string): Promise<number> {
    const result = await this.sql`delete from match_runs where event_id = ${eventId}`;
    return result.count;
  }

  async resetPhotosForRequeue(input: {
    eventId: string;
    status: PhotoStatus;
    errorLike?: string;
  }): Promise<Array<{ id: string; webReady: boolean }>> {
    const like = input.errorLike === undefined ? null : `%${escapeLike(input.errorLike)}%`;
    const rows = await this.sql<{ id: string; web_ready: boolean }[]>`
      with target as (
        select p.id,
               exists (select 1 from derivatives d where d.photo_id = p.id and d.kind = 'web') as web_ready,
               exists (select 1 from derivatives d where d.photo_id = p.id and d.kind = 'thumb') as thumb_ready
        from photos p
        where p.event_id = ${input.eventId} and p.status = ${input.status}
          ${like === null ? this.sql`` : this.sql`and p.error ilike ${like}`}
      )
      update photos p
      set status = case when t.web_ready and t.thumb_ready then 'processing' else 'uploaded' end,
          error = null
      from target t
      where p.id = t.id
      returning p.id, t.web_ready
    `;
    return rows.map((row) => ({ id: row.id, webReady: row.web_ready === true }));
  }

  /** Whether `galleries.query_embedding` exists (migration 006 on a pgvector server). Cached. */
  private queryVectorAvailable(): Promise<boolean> {
    if (!this.queryVectorChecked) {
      this.queryVectorChecked = this.sql<{ present: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'galleries' and column_name = 'query_embedding'
        ) as present
      `
        .then((rows) => rows[0]?.present === true)
        .catch((error: unknown) => {
          this.queryVectorChecked = undefined;
          throw error;
        });
    }
    return this.queryVectorChecked;
  }

  private queryVectorChecked: Promise<boolean> | undefined;

  // ---- admin and participant tooling v5 (agent D) ----------------------------------------

  async createEvent(input: {
    slug: string;
    name: string;
    retentionDays?: number;
    access?: EventAccess;
  }): Promise<EventRow> {
    try {
      const rows = await this.sql<EventSql[]>`
        insert into events (slug, name, retention_days, access)
        values (${input.slug}, ${input.name}, ${input.retentionDays ?? 90}, ${input.access ?? "open"})
        returning ${this.sql.unsafe(EVENT_COLUMNS)}
      `;
      const row = rows[0];
      if (!row) throw new Error("Event insert failed");
      return mapEvent(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError();
      throw error;
    }
  }

  async listEventsWithCounts(): Promise<EventWithCounts[]> {
    const rows = await this.sql<(EventSql & {
      photos: number;
      galleries: number;
      participants: number;
      photographers: number;
    })[]>`
      select ${this.sql.unsafe(prefixColumns("e", EVENT_COLUMNS))},
             (select count(*)::int from photos p where p.event_id = e.id) as photos,
             (select count(*)::int from galleries g where g.event_id = e.id) as galleries,
             (select count(distinct c.user_id)::int from consents c where c.event_id = e.id and c.withdrawn_at is null) as participants,
             (select count(*)::int from event_photographers ep where ep.event_id = e.id) as photographers
      from events e
      order by e.created_at desc, e.id
    `;
    return rows.map((row) => ({
      ...mapEvent(row),
      photos: row.photos,
      galleries: row.galleries,
      participants: row.participants,
      photographers: row.photographers,
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
    const rows = await this.sql<{
      user_id: string;
      email: string;
      total: number;
      matched_at: Date | null;
      reason: string | null;
      sort_at: Date;
    }[]>`
      select g.user_id, u.email, g.matched_at, g.last_match_reason as reason,
             date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz)) as sort_at,
             (select count(*)::int from gallery_items gi where gi.gallery_id = g.id) as total
      from galleries g
      join users u on u.id = g.user_id
      where g.event_id = ${eventId}
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz)) < ${cursor.matchedAt}
                 or (date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz)) = ${cursor.matchedAt} and g.user_id > ${cursor.userId}::uuid))`
            : this.sql``
        }
      order by sort_at desc, g.user_id asc
      limit ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      galleries: page.map((row) => ({
        userId: row.user_id,
        email: row.email,
        total: row.total,
        matchedAt: row.matched_at,
        reason: row.reason,
      })),
      nextCursor:
        rows.length > input.limit && last ? { matchedAt: last.sort_at, userId: last.user_id } : null,
    };
  }

  async findGalleryWithItemsByEmail(eventId: string, email: string): Promise<GalleryWithItems | null> {
    const user = await this.findUserByEmailRole(email, "participant");
    if (!user) return null;
    const galleries = await this.sql<{
      id: string;
      anchor_face_ids: string[];
      matched_at: Date | null;
      reason: string | null;
    }[]>`
      select id, anchor_face_ids, matched_at, last_match_reason as reason
      from galleries where user_id = ${user.id} and event_id = ${eventId}
    `;
    const gallery = galleries[0];
    if (!gallery) return { user, gallery: null, items: [] };
    const rows = await this.sql<{
      photo_id: string;
      face_id: string;
      score: number;
      source: GalleryItemSource;
      created_at: Date;
      thumb_key: string | null;
      web_key: string | null;
      original_status: OriginalStatus;
      sha256: string;
      filename: string | null;
      feedback: FeedbackVerdict | null;
    }[]>`
      select gi.photo_id, gi.face_id, gi.score, gi.source, gi.created_at,
             t.s3_key as thumb_key, w.s3_key as web_key, p.original_status, p.sha256, p.filename,
             f.verdict as feedback
      from gallery_items gi
      join photos p on p.id = gi.photo_id
      left join derivatives t on t.photo_id = gi.photo_id and t.kind = 'thumb'
      left join derivatives w on w.photo_id = gi.photo_id and w.kind = 'web'
      left join gallery_feedback f on f.user_id = ${user.id} and f.event_id = ${eventId} and f.photo_id = gi.photo_id
      where gi.gallery_id = ${gallery.id}
      order by gi.score desc, gi.photo_id asc
      limit 2000
    `;
    const totals = await this.sql<{ count: number }[]>`
      select count(*)::int as count from gallery_items where gallery_id = ${gallery.id}
    `;
    return {
      user,
      gallery: {
        id: gallery.id,
        matchedAt: gallery.matched_at,
        anchorFaceIds: gallery.anchor_face_ids,
        reason: gallery.reason,
        total: totals[0]?.count ?? 0,
      },
      items: rows.map((row) => ({
        photoId: row.photo_id,
        faceId: row.face_id,
        score: Number(row.score),
        source: row.source,
        createdAt: row.created_at,
        thumbKey: row.thumb_key ?? "",
        webKey: row.web_key ?? "",
        originalReady: row.original_status === "present",
        sha256: row.sha256,
        filename: row.filename,
        feedback: row.feedback,
      })),
    };
  }

  async findPhotoDetail(id: string): Promise<PhotoDetail | null> {
    const photos = await this.sql<PhotoAdminSql[]>`
      select ${this.sql.unsafe(PHOTO_ADMIN_COLUMNS)} from photos where id = ${id}
    `;
    const photo = photos[0];
    if (!photo) return null;
    const faces = await this.sql<{ id: string; external_id: string; bbox: BBox; confidence: number }[]>`
      select id, external_id, bbox, confidence from faces where photo_id = ${id} order by created_at, id
    `;
    const galleries = await this.sql<{
      user_id: string;
      email: string;
      score: number;
      source: GalleryItemSource;
      face_id: string;
      feedback: FeedbackVerdict | null;
    }[]>`
      select g.user_id, u.email, gi.score, gi.source, gi.face_id, f.verdict as feedback
      from gallery_items gi
      join galleries g on g.id = gi.gallery_id
      join users u on u.id = g.user_id
      left join gallery_feedback f on f.user_id = g.user_id and f.event_id = g.event_id and f.photo_id = gi.photo_id
      where gi.photo_id = ${id}
      order by gi.score desc, u.email
    `;
    return {
      photo: mapPhotoAdmin(photo),
      faces: faces.map((face) => ({
        id: face.id,
        externalId: face.external_id,
        bbox: face.bbox,
        confidence: Number(face.confidence),
      })),
      galleries: galleries.map((row) => ({
        userId: row.user_id,
        email: row.email,
        score: Number(row.score),
        source: row.source,
        faceId: row.face_id,
        feedback: row.feedback,
      })),
    };
  }

  async listPhotosAdmin(
    filters: PhotoAdminFilters,
    input: { limit: number; cursor?: UploadCursor },
  ): Promise<{ items: PhotoAdminRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const sql = this.sql;
    const rows = await sql<PhotoAdminSql[]>`
      select ${sql.unsafe(PHOTO_ADMIN_COLUMNS)}
      from photos
      where event_id = ${filters.eventId}
        ${filters.sha256 ? sql`and sha256 like ${`${filters.sha256}%`}` : sql``}
        ${filters.filename ? sql`and filename like ${`${escapeLike(filters.filename)}%`}` : sql``}
        ${filters.status ? sql`and status = ${filters.status}` : sql``}
        ${filters.photographerId ? sql`and photographer_id = ${filters.photographerId}` : sql``}
        ${filters.tag ? sql`and ${filters.tag} = any(tags)` : sql``}
        ${
          cursor
            ? sql`and (date_trunc('milliseconds', created_at), id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : sql``
        }
      order by date_trunc('milliseconds', created_at) desc, id desc
      limit ${input.limit + 1}
    `;
    const items = rows.slice(0, input.limit).map(mapPhotoAdmin);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async findGallerySelfieKey(userId: string, eventId: string): Promise<string | null> {
    const rows = await this.sql<{ selfie_key: string | null }[]>`
      select selfie_key from galleries where user_id = ${userId} and event_id = ${eventId}
    `;
    return rows[0]?.selfie_key ?? null;
  }

  async deleteGallery(userId: string, eventId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        delete from galleries where user_id = ${userId} and event_id = ${eventId} returning id
      `;
      return rows.length > 0;
    });
  }

  async upsertFeedback(input: {
    userId: string;
    eventId: string;
    photoId: string;
    verdict: FeedbackVerdict;
    scoreAtTime: number | null;
  }): Promise<void> {
    await this.sql`
      insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time)
      values (${input.userId}, ${input.eventId}, ${input.photoId}, ${input.verdict}, ${input.scoreAtTime})
      on conflict (user_id, event_id, photo_id) do update
        set verdict = excluded.verdict, score_at_time = excluded.score_at_time, created_at = now()
    `;
  }

  async listFeedback(
    userId: string,
    eventId: string,
    photoIds?: string[],
  ): Promise<Array<{ photoId: string; verdict: FeedbackVerdict }>> {
    if (photoIds !== undefined && photoIds.length === 0) return [];
    const rows = await this.sql<{ photo_id: string; verdict: FeedbackVerdict }[]>`
      select photo_id, verdict
      from gallery_feedback
      where user_id = ${userId} and event_id = ${eventId}
        ${photoIds === undefined ? this.sql`` : this.sql`and photo_id = any(${photoIds}::uuid[])`}
    `;
    return rows.map((row) => ({ photoId: row.photo_id, verdict: row.verdict }));
  }

  async listMatchRuns(
    eventId: string,
    input: { email?: string; limit: number; cursor?: UploadCursor },
  ): Promise<{ runs: MatchRunRow[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const sql = this.sql;
    const rows = await sql<{
      id: string;
      user_id: string;
      email: string;
      liveness: string | null;
      reason: string | null;
      selfie_sha256: string | null;
      selfie_faces: number | null;
      engine_ms: number | null;
      hits: number;
      created_at: Date;
      kept: number;
      max_cosine: number | null;
    }[]>`
      select r.id, r.user_id, u.email, r.liveness, r.reason, r.selfie_sha256, r.selfie_faces,
             r.engine_ms, r.hits, r.created_at,
             (select count(*)::int from match_hits h where h.run_id = r.id and h.kept) as kept,
             (select max(h.cosine)::float8 from match_hits h where h.run_id = r.id) as max_cosine
      from match_runs r
      join users u on u.id = r.user_id
      where r.event_id = ${eventId}
        ${input.email ? sql`and u.email = ${input.email}` : sql``}
        ${
          cursor
            ? sql`and (date_trunc('milliseconds', r.created_at), r.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : sql``
        }
      order by date_trunc('milliseconds', r.created_at) desc, r.id desc
      limit ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      runs: page.map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: row.email,
        liveness: row.liveness,
        reason: row.reason,
        selfieSha256: row.selfie_sha256,
        selfieFaces: row.selfie_faces,
        engineMs: row.engine_ms,
        hits: row.hits,
        createdAt: row.created_at,
        kept: row.kept,
        maxCosine: row.max_cosine === null ? null : Number(row.max_cosine),
      })),
      nextCursor: rows.length > input.limit && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  async *exportGalleries(eventId: string): AsyncIterable<GalleryExportRow> {
    const query = this.sql<{
      email: string;
      user_id: string;
      photo_id: string;
      sha256: string;
      filename: string | null;
      score: number;
      source: GalleryItemSource;
      face_id: string;
      created_at: Date;
      feedback: FeedbackVerdict | null;
    }[]>`
      select u.email, g.user_id, gi.photo_id, p.sha256, p.filename, gi.score, gi.source, gi.face_id,
             gi.created_at, f.verdict as feedback
      from galleries g
      join users u on u.id = g.user_id
      join gallery_items gi on gi.gallery_id = g.id
      join photos p on p.id = gi.photo_id
      left join gallery_feedback f on f.user_id = g.user_id and f.event_id = g.event_id and f.photo_id = gi.photo_id
      where g.event_id = ${eventId}
      order by u.email, gi.score desc, gi.photo_id
    `;
    for await (const batch of query.cursor(500)) {
      for (const row of batch) {
        yield {
          email: row.email,
          userId: row.user_id,
          photoId: row.photo_id,
          sha256: row.sha256,
          filename: row.filename,
          score: Number(row.score),
          source: row.source,
          faceId: row.face_id,
          createdAt: row.created_at,
          feedback: row.feedback,
        };
      }
    }
  }

  async *exportMatchHits(eventId: string): AsyncIterable<MatchHitExportRow> {
    const query = this.sql<{
      run_id: string;
      email: string;
      user_id: string;
      run_created_at: Date;
      photo_id: string;
      external_face_id: string;
      cosine: number;
      similarity: number;
      kept: boolean;
    }[]>`
      select h.run_id, u.email, r.user_id, r.created_at as run_created_at, h.photo_id,
             h.external_face_id, h.cosine::float8 as cosine, h.similarity::float8 as similarity, h.kept
      from match_runs r
      join users u on u.id = r.user_id
      join match_hits h on h.run_id = r.id
      where r.event_id = ${eventId}
      order by r.created_at, r.id, h.cosine desc
    `;
    for await (const batch of query.cursor(500)) {
      for (const row of batch) {
        yield {
          runId: row.run_id,
          email: row.email,
          userId: row.user_id,
          runCreatedAt: row.run_created_at,
          photoId: row.photo_id,
          externalFaceId: row.external_face_id,
          cosine: Number(row.cosine),
          similarity: Number(row.similarity),
          kept: row.kept,
        };
      }
    }
  }

  async *exportFeedback(eventId: string): AsyncIterable<FeedbackExportRow> {
    const query = this.sql<{
      email: string;
      user_id: string;
      photo_id: string;
      sha256: string;
      filename: string | null;
      verdict: FeedbackVerdict;
      score_at_time: number | null;
      created_at: Date;
    }[]>`
      select u.email, f.user_id, f.photo_id, p.sha256, p.filename, f.verdict, f.score_at_time, f.created_at
      from gallery_feedback f
      join users u on u.id = f.user_id
      join photos p on p.id = f.photo_id
      where f.event_id = ${eventId}
      order by u.email, f.created_at
    `;
    for await (const batch of query.cursor(500)) {
      for (const row of batch) {
        yield {
          email: row.email,
          userId: row.user_id,
          photoId: row.photo_id,
          sha256: row.sha256,
          filename: row.filename,
          verdict: row.verdict,
          scoreAtTime: row.score_at_time === null ? null : Number(row.score_at_time),
          createdAt: row.created_at,
        };
      }
    }
  }

  async metricsExtras(): Promise<MetricsExtras> {
    const byType = await this.sql<{
      type: string;
      queued: number;
      running: number;
      error: number;
      oldest_queued_seconds: number | null;
    }[]>`
      select type,
             count(*) filter (where status = 'queued')::int as queued,
             count(*) filter (where status = 'running')::int as running,
             count(*) filter (where status = 'error')::int as error,
             extract(epoch from now() - min(created_at) filter (where status = 'queued'))::float8 as oldest_queued_seconds
      from jobs
      where status in ('queued', 'running', 'error')
      group by type
      order by type
    `;
    const errors = await this.sql<{ id: string; type: string; last_error: string | null; created_at: Date }[]>`
      select id, type, last_error, created_at from jobs
      where status = 'error'
      order by created_at desc
      limit 20
    `;
    const jobsByType = byType.map((row) => ({
      type: row.type,
      queued: row.queued,
      running: row.running,
      error: row.error,
      oldestQueuedSeconds:
        row.oldest_queued_seconds === null ? null : Math.max(0, Number(row.oldest_queued_seconds)),
    }));
    const ages = jobsByType
      .map((row) => row.oldestQueuedSeconds)
      .filter((age): age is number => age !== null);
    return {
      jobsByType,
      oldestQueuedSeconds: ages.length > 0 ? Math.max(...ages) : null,
      lastErrors: errors.map((row) => ({
        id: row.id,
        type: row.type,
        error: row.last_error ?? "",
        at: row.created_at,
      })),
    };
  }
}

/** Escapes `%` and `_` so a filename prefix search does not become a wildcard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type UserSql = { id: string; email: string; role: Role; created_at: Date };
type EventSql = {
  id: string;
  slug: string;
  name: string;
  retention_days: number;
  access: EventAccess;
  created_at: Date;
};
type PhotoSql = {
  id: string;
  event_id: string;
  photographer_id: string;
  collection: PhotoCollection;
  sha256: string;
  status: PhotoStatus;
  original_key: string;
  content_type: string;
  bytes: string | number;
  original_status: OriginalStatus;
  indexed_at: Date | null;
  error: string | null;
  created_at: Date;
};
type UploadSql = {
  id: string;
  event_id: string;
  photographer_id: string;
  collection: PhotoCollection;
  s3_upload_id: string | null;
  object_key: string;
  sha256: string;
  content_type: string;
  status: "open" | "completed" | "aborted";
  bytes: string | number | null;
  stage: UploadStage;
  photo_id: string | null;
  original_content_type: string | null;
  original_bytes: string | number | null;
  filename: string | null;
  tags: string[] | null;
  created_at: Date;
};
type PhotoAdminSql = PhotoSql & { filename: string | null; tags: string[] | null };

/** `finished_at` / `duration_ms` (from `claimed_at`) written when a job leaves `running` (v5, B). */
const JOB_FINISHED_SQL =
  "finished_at = now(), duration_ms = (extract(epoch from (now() - coalesce(claimed_at, now()))) * 1000)::int";
const MATCH_HITS_CHUNK = 500;
/** `findGalleriesByQueryVector` returns at most this many galleries (HNSW needs an ORDER BY … LIMIT). */
const QUERY_VECTOR_GALLERY_LIMIT = 50;

function prefixColumns(alias: string, columns: string): string {
  return columns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

function emptyPhotosByStatus(): PhotosByStatus {
  return { uploaded: 0, processing: 0, indexed: 0, error: 0 };
}

/** One row per photo, keeping the best score; `on conflict do update` cannot touch a row twice. */
function dedupeByPhoto<T extends { photoId: string; score: number }>(items: T[]): T[] {
  const byPhoto = new Map<string, T>();
  for (const item of items) {
    const current = byPhoto.get(item.photoId);
    if (!current || item.score > current.score) byPhoto.set(item.photoId, item);
  }
  return [...byPhoto.values()];
}

function mapUser(row: UserSql): UserRow {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at };
}
function mapEvent(row: EventSql): EventRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    retentionDays: row.retention_days,
    access: row.access,
    createdAt: row.created_at,
  };
}
function mapPhoto(row: PhotoSql): PhotoRow {
  return {
    id: row.id,
    eventId: row.event_id,
    photographerId: row.photographer_id,
    collection: row.collection,
    sha256: row.sha256,
    status: row.status,
    originalKey: row.original_key,
    contentType: asContentType(row.content_type),
    bytes: Number(row.bytes),
    originalStatus: row.original_status,
    indexedAt: row.indexed_at,
    error: row.error,
    createdAt: row.created_at,
  };
}
function mapUpload(row: UploadSql): UploadSessionRow {
  return {
    id: row.id,
    eventId: row.event_id,
    photographerId: row.photographer_id,
    collection: row.collection,
    s3UploadId: row.s3_upload_id,
    objectKey: row.object_key,
    sha256: row.sha256,
    contentType: asContentType(row.content_type),
    status: row.status,
    bytes: row.bytes === null ? null : Number(row.bytes),
    stage: row.stage,
    photoId: row.photo_id,
    originalContentType:
      row.original_content_type === null ? null : asContentType(row.original_content_type),
    originalBytes: row.original_bytes === null ? null : Number(row.original_bytes),
    filename: row.filename ?? null,
    tags: row.tags ?? [],
    createdAt: row.created_at,
  };
}
function mapPhotoAdmin(row: PhotoAdminSql): PhotoAdminRow {
  return { ...mapPhoto(row), filename: row.filename ?? null, tags: row.tags ?? [] };
}
