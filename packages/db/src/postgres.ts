import { createHash, randomUUID } from "node:crypto";
import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";
import {
  JOB_MAX_ATTEMPTS,
  JOB_PRIORITY,
  // v6 (agent C): the reasons that count toward the auto-pending threshold. `not_me` is
  // excluded on purpose; the constant's own comment says why.
  MODERATION_COUNTING_REASONS,
  STALE_RUNNING_MS,
  THROTTLE_REQUEUE_SECONDS,
} from "@rephoto/contracts";
import { inTransaction, isUniqueViolation, type Sql } from "./sql.js";
import {
  AlbumRecognitionLockedError,
  AlbumRecognitionNotAllowedError,
  DuplicateKeyError,
  // v6 (agent E): tagging
  nextTagConsent,
  normalizeDisplayName,
  TAG_SEARCH_MIN_PREFIX,
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
  PhotosByStatus,
  StaleUpload,
  UploadCursor,
  UploadSessionRow,
  UploadStage,
  UploadSummary,
  UserRow,
  EventWithCounts,
  FeedbackExportRow,
  FeedbackSource,
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
  BBox,
  ClaimOptions,
  GalleryMatchPatch,
  MatchHitInsert,
  MatchRunInsert,
  QueryVectorGallery,
  AlbumInsert,
  AlbumKind,
  AlbumModeration,
  AlbumPatch,
  AlbumRow,
  AlbumVisibility,
  // v6 (agent B)
  EventCodeRow,
  IdentityProvider,
  // v6 (agent D): admin console
  AlbumPhotographerRow,
  EventCodePatch,
  EventStatus,
  EventStatusAlbum,
  // v6 (agent C)
  AlbumPhoto,
  ModerationItem,
  ModerationState,
  ReportReason,
  ReportRow,
  // v6 (agent G)
  ConsentState,
  ConsentWithdrawal,
  RetentionAlarmMail,
  RetentionOutcome,
  RetentionStatusRow,
  // v6 (agent E): event membership + tagging
  AuditEntryRow,
  EventMemberRow,
  EventMemberSource,
  PhotoTagRow,
  PhotoTagState,
  PhotoTagWithNameRow,
  TagProfileRow,
  TaggableUserRow,
  TaggedPhotoRow,
} from "./types.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";
const INVITE_ID = "00000000-0000-4000-8000-000000000004";
/** v6: slug of the official album every event gets (migration 009). */
const DEFAULT_ALBUM_SLUG = "ufficiale";

const PHOTO_COLUMNS =
  "id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, original_status, indexed_at, error, created_at, album_id, moderation_state";
/** v6: `albums` columns, in the order {@link mapAlbum} reads them. */
const ALBUM_COLUMNS =
  "id, event_id, slug, name, kind, recognition, moderation, visibility, max_photos_per_user, uploads_open, retention_days, first_upload_at, created_at";
const EVENT_COLUMNS = "id, slug, name, retention_days, access, created_at";
const UPLOAD_COLUMNS =
  "id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status, bytes, stage, photo_id, original_content_type, original_bytes, filename, tags, created_at, album_id";
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

  /**
   * One `begin`/`commit` on one pooled connection. The handle handed to `fn` is another
   * `PostgresDatabase` over the transaction's `sql`, so every existing method works
   * inside it unchanged; nothing else in this class knows a transaction exists.
   *
   * `postgres` rolls back and re-throws if `fn` throws, and a connection that dies
   * mid-transaction is rolled back by Postgres itself — which is the whole point: an
   * interrupted registration cannot leave a claimed event code behind.
   */
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return await inTransaction(this.sql, (tx) => fn(new PostgresDatabase(tx)));
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
    // v6 hardening (agent H): a new password retires every outstanding reset link of that
    // user, in the same transaction. Doing it here rather than at the call sites means no
    // future password-changing route can forget it. See migration 016.
    await inTransaction(this.sql, async (tx) => {
      await tx`update users set password_hash = ${passwordHash} where id = ${userId}`;
      await tx`
        update password_reset_tokens set used_at = now()
        where user_id = ${userId} and used_at is null
      `;
    });
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

  /**
   * Still EVENT-wide, unlike {@link findPhotoByAlbumSha}: it backs
   * `GET /v1/uploads/lookup`, which only knows an event. Since v6 the same bytes can exist
   * once per album (`photos unique (album_id, sha256)`), so with several albums per event
   * this can return any one of them. Harmless today -- the photographer upload route only
   * ever writes into the event's official album -- but a lookup that has to be exact needs
   * an album id in the query.
   */
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
    // v6 (agent C): without an explicit album the session targets the event's official
    // album, the same resolution `insertPhoto` does, so `complete` always knows where the
    // photo belongs (`upload_sessions.album_id`, migration 010).
    await this.sql`
      insert into upload_sessions (
        id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status, bytes,
        stage, photo_id, original_content_type, original_bytes, filename, tags, album_id
      ) values (
        ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.s3UploadId},
        ${input.objectKey}, ${input.sha256}, ${input.contentType}, 'open', ${input.bytes},
        ${input.stage ?? "original"}, ${input.photoId ?? null},
        ${input.originalContentType ?? null}, ${input.originalBytes ?? null},
        ${input.filename ?? null}, ${input.tags ?? []}::text[],
        coalesce(
          ${input.albumId ?? null}::uuid,
          (select a.id from albums a
            where a.event_id = ${input.eventId} and a.slug = ${DEFAULT_ALBUM_SLUG})
        )
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
    // The explicit 'UTC' third argument is what makes the expression indexable: the two-argument
    // date_trunc(text, timestamptz) is STABLE (it reads the session TimeZone), so Postgres refuses
    // it in an index expression; the three-argument form is IMMUTABLE. For a sub-second unit the
    // value is identical in every real zone (all offsets are whole minutes). The matching indexes
    // are in migration 014; without them this ordering could not use any index (v6 F3).
    const rows = await this.sql<UploadSql[]>`
      select ${this.sql.unsafe(UPLOAD_COLUMNS)}
      from upload_sessions
      where photographer_id = ${photographerId} and event_id = ${eventId}
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', created_at, 'UTC'), id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : this.sql``
        }
      order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc
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
    sha256: string;
    originalKey: string;
    contentType: ImageContentType;
    bytes: number;
    originalStatus?: OriginalStatus;
    filename?: string | null;
    tags?: string[];
    albumId?: string;
  }): Promise<PhotoRow> {
    try {
      // v6: without an explicit album the photo lands in the event's official album, which
      // every event has (migration 009 backfills it and a trigger adds it to new events).
      const rows = await this.sql<PhotoSql[]>`
        insert into photos (
          id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, original_status,
          filename, tags, album_id
        )
        values (
          ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.sha256},
          'uploaded', ${input.originalKey}, ${input.contentType}, ${input.bytes},
          ${input.originalStatus ?? "present"}, ${input.filename ?? null}, ${input.tags ?? []}::text[],
          coalesce(
            ${input.albumId ?? null}::uuid,
            (select a.id from albums a
              where a.event_id = ${input.eventId} and a.slug = ${DEFAULT_ALBUM_SLUG})
          )
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
    await inTransaction(this.sql, async (tx) => {
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
    await inTransaction(this.sql, async (tx) => {
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
        -- v6 (agent C): a photo withheld by moderation leaves every gallery until a
        -- moderator rules (C2, the report threshold). moderation_state defaults to
        -- 'approved' (migration 010), so this clause changes nothing for v5 data.
        and p.moderation_state = 'approved'
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
      join photos p on p.id = gi.photo_id
      join derivatives t on t.photo_id = gi.photo_id and t.kind = 'thumb'
      join derivatives w on w.photo_id = gi.photo_id and w.kind = 'web'
      where g.user_id = ${userId} and g.event_id = ${eventId}
        and p.moderation_state = 'approved'
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
    await inTransaction(this.sql, async (tx) => {
      await tx`delete from gallery_items where photo_id = ${photoId}`;
      await tx`delete from faces where photo_id = ${photoId}`;
      await tx`delete from face_index where photo_id = ${photoId}`;
      await tx`delete from photos where id = ${photoId}`;
    });
  }

  async deleteParticipant(userId: string): Promise<boolean> {
    const user = await this.findUserById(userId);
    if (!user || user.role !== "participant") return false;
    await inTransaction(this.sql, async (tx) => {
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
    return inTransaction(this.sql, async (tx) => {
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
    return inTransaction(this.sql, async (tx) => {
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
             date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz), 'UTC') as sort_at,
             (select count(*)::int from gallery_items gi where gi.gallery_id = g.id) as total
      from galleries g
      join users u on u.id = g.user_id
      where g.event_id = ${eventId}
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz), 'UTC') < ${cursor.matchedAt}
                 or (date_trunc('milliseconds', coalesce(g.matched_at, 'epoch'::timestamptz), 'UTC') = ${cursor.matchedAt} and g.user_id > ${cursor.userId}::uuid))`
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
            ? sql`and (date_trunc('milliseconds', created_at, 'UTC'), id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : sql``
        }
      order by date_trunc('milliseconds', created_at, 'UTC') desc, id desc
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
    return inTransaction(this.sql, async (tx) => {
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
    source: FeedbackSource;
  }): Promise<void> {
    // `source` moves with the verdict on a conflict (migration 018): the row records the
    // judgement that stands, and the flow that produced THAT judgement. A person who refused
    // a tag and later rules on the same photo in their gallery leaves a `recognition` row,
    // which is correct — that last ruling is a statement about the matcher.
    await this.sql`
      insert into gallery_feedback (user_id, event_id, photo_id, verdict, score_at_time, source)
      values (${input.userId}, ${input.eventId}, ${input.photoId}, ${input.verdict}, ${input.scoreAtTime}, ${input.source})
      on conflict (user_id, event_id, photo_id) do update
        set verdict = excluded.verdict,
            score_at_time = excluded.score_at_time,
            source = excluded.source,
            created_at = now()
    `;
  }

  async listFeedback(
    userId: string,
    eventId: string,
    photoIds?: readonly string[],
  ): Promise<Array<{ photoId: string; verdict: FeedbackVerdict }>> {
    // An empty id list is "this page has no photos": answer without a round trip (v6 F4).
    if (photoIds && photoIds.length === 0) return [];
    const rows = await this.sql<{ photo_id: string; verdict: FeedbackVerdict }[]>`
      select photo_id, verdict from gallery_feedback where user_id = ${userId} and event_id = ${eventId}
        ${photoIds ? this.sql`and photo_id = any(${[...photoIds]}::uuid[])` : this.sql``}
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
            ? sql`and (date_trunc('milliseconds', r.created_at, 'UTC'), r.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : sql``
        }
      order by date_trunc('milliseconds', r.created_at, 'UTC') desc, r.id desc
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
      source: FeedbackSource;
    }[]>`
      select u.email, f.user_id, f.photo_id, p.sha256, p.filename, f.verdict, f.score_at_time,
             f.created_at, f.source
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
          source: row.source,
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

  // ---- albums and vector isolation v6 (agent A) -------------------------------------------

  async createAlbum(input: AlbumInsert): Promise<AlbumRow> {
    let row: AlbumSql | undefined;
    try {
      const rows = await this.sql<AlbumSql[]>`
        insert into albums (
          id, event_id, slug, name, kind, recognition, moderation, visibility,
          max_photos_per_user, uploads_open, retention_days
        )
        values (
          coalesce(${input.id ?? null}::uuid, gen_random_uuid()),
          ${input.eventId}, ${input.slug}, ${input.name}, ${input.kind},
          ${input.recognition ?? false}, ${input.moderation ?? "post"},
          ${input.visibility ?? "participants"}, ${input.maxPhotosPerUser ?? null},
          ${input.uploadsOpen ?? true}, ${input.retentionDays ?? null}
        )
        returning ${this.sql.unsafe(ALBUM_COLUMNS)}
      `;
      row = rows[0];
    } catch (error) {
      throw albumError(error);
    }
    if (!row) throw new Error("Album insert failed");
    const album = mapAlbum(row);
    if (album.recognition) await this.ensureAlbumVectorIndex(album.id);
    return album;
  }

  async findAlbum(id: string): Promise<AlbumRow | null> {
    const rows = await this.sql<AlbumSql[]>`
      select ${this.sql.unsafe(ALBUM_COLUMNS)} from albums where id = ${id}
    `;
    return rows[0] ? mapAlbum(rows[0]) : null;
  }

  async findAlbumBySlug(eventId: string, slug: string): Promise<AlbumRow | null> {
    const rows = await this.sql<AlbumSql[]>`
      select ${this.sql.unsafe(ALBUM_COLUMNS)} from albums
      where event_id = ${eventId} and slug = ${slug}
    `;
    return rows[0] ? mapAlbum(rows[0]) : null;
  }

  async listAlbums(eventId: string): Promise<AlbumRow[]> {
    const rows = await this.sql<AlbumSql[]>`
      select ${this.sql.unsafe(ALBUM_COLUMNS)} from albums
      where event_id = ${eventId}
      order by created_at, id
    `;
    return rows.map(mapAlbum);
  }

  async findDefaultAlbum(eventId: string): Promise<AlbumRow | null> {
    return this.findAlbumBySlug(eventId, DEFAULT_ALBUM_SLUG);
  }

  async listRecognitionAlbumIds(eventId: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from albums
      where event_id = ${eventId} and recognition
      order by created_at, id
    `;
    return rows.map((row) => row.id);
  }

  async updateAlbum(id: string, patch: AlbumPatch): Promise<AlbumRow | null> {
    let row: AlbumSql | undefined;
    try {
      // A `recognition` change after the first upload is refused by the trigger of
      // migration 009 (SQLSTATE ALBRI), not here: no upload route can side-step it.
      const rows = await this.sql<AlbumSql[]>`
        update albums set
          name = coalesce(${patch.name ?? null}, name),
          recognition = coalesce(${patch.recognition ?? null}, recognition),
          moderation = coalesce(${patch.moderation ?? null}, moderation),
          visibility = coalesce(${patch.visibility ?? null}, visibility),
          max_photos_per_user = ${
            patch.maxPhotosPerUser === undefined
              ? this.sql`max_photos_per_user`
              : this.sql`${patch.maxPhotosPerUser}::int`
          },
          uploads_open = coalesce(${patch.uploadsOpen ?? null}, uploads_open),
          retention_days = ${
            patch.retentionDays === undefined
              ? this.sql`retention_days`
              : this.sql`${patch.retentionDays}::int`
          }
        where id = ${id}
        returning ${this.sql.unsafe(ALBUM_COLUMNS)}
      `;
      row = rows[0];
    } catch (error) {
      throw albumError(error);
    }
    if (!row) return null;
    const album = mapAlbum(row);
    if (album.recognition) await this.ensureAlbumVectorIndex(album.id);
    return album;
  }

  async markAlbumFirstUpload(albumId: string, at: Date = new Date()): Promise<void> {
    await this.sql`
      update albums set first_upload_at = ${at}
      where id = ${albumId} and first_upload_at is null
    `;
  }

  async findPhotoByAlbumSha(albumId: string, sha256: string): Promise<PhotoRow | null> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos where album_id = ${albumId} and sha256 = ${sha256}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  /**
   * The album's partial HNSW index over `face_vectors` (migration 011). A no-op when the
   * function is absent (a database migrated before 011, or without pgvector).
   */
  private async ensureAlbumVectorIndex(albumId: string): Promise<void> {
    const rows = await this.sql<{ present: boolean }[]>`
      select to_regprocedure('public.face_vectors_album_index(uuid)') is not null as present
    `;
    if (rows[0]?.present !== true) return;
    await this.sql`select face_vectors_album_index(${albumId})`;
  }

  // ---- auth v6 (agent B): identities, event codes, lazy e-mail verification -------------

  async findUserByIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<UserRow | null> {
    const rows = await this.sql<UserSql[]>`
      select u.id, u.email, u.role, u.created_at
      from user_identities i join users u on u.id = i.user_id
      where i.provider = ${provider} and i.subject = ${subject}
    `;
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async insertIdentity(input: {
    userId: string;
    provider: IdentityProvider;
    subject: string;
    email: string | null;
  }): Promise<void> {
    try {
      await this.sql`
        insert into user_identities (user_id, provider, subject, email)
        values (${input.userId}, ${input.provider}, ${input.subject}, ${input.email})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError();
      throw error;
    }
  }

  async createEventCode(input: {
    eventId: string;
    code: string;
    label?: string | null;
    maxUses?: number | null;
    expiresAt?: Date | null;
  }): Promise<EventCodeRow> {
    try {
      const rows = await this.sql<EventCodeSql[]>`
        insert into event_codes (event_id, code, label, max_uses, expires_at)
        values (
          ${input.eventId},
          ${input.code},
          ${input.label ?? null},
          ${input.maxUses ?? null},
          ${input.expiresAt ?? null}
        )
        returning event_id, code, label, max_uses, uses, expires_at, created_at
      `;
      const row = rows[0];
      if (!row) throw new Error("Event code insert failed");
      return mapEventCode(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateKeyError();
      throw error;
    }
  }

  async findEventCode(eventId: string, code: string): Promise<EventCodeRow | null> {
    const rows = await this.sql<EventCodeSql[]>`
      select event_id, code, label, max_uses, uses, expires_at, created_at
      from event_codes where event_id = ${eventId} and code = ${code}
    `;
    return rows[0] ? mapEventCode(rows[0]) : null;
  }

  async claimEventCode(code: string): Promise<EventCodeRow | null> {
    // One statement: the `uses < max_uses` test and the increment cannot interleave, so a
    // code with `max_uses = 1` is handed out once even under concurrent registrations
    // (Postgres re-evaluates the where clause against the row the other writer committed).
    //
    // The primary key is (event_id, code) and registration only sends the code, so the
    // subselect pins one event: without it an update would touch the same code in every
    // event at once. The subselect filters on validity as well, so the usual case — one
    // event owning the code — behaves exactly as the plain update did.
    const rows = await this.sql<EventCodeSql[]>`
      update event_codes
      set uses = uses + 1
      where code = ${code}
        and (expires_at is null or expires_at > now())
        and (max_uses is null or uses < max_uses)
        and event_id = (
          select event_id from event_codes
          where code = ${code}
            and (expires_at is null or expires_at > now())
            and (max_uses is null or uses < max_uses)
          order by created_at, event_id
          limit 1
        )
      returning event_id, code, label, max_uses, uses, expires_at, created_at
    `;
    return rows[0] ? mapEventCode(rows[0]) : null;
  }

  async markEmailVerified(userId: string, at: Date = new Date()): Promise<void> {
    await this.sql`
      update users set email_verified_at = ${at}
      where id = ${userId} and email_verified_at is null
    `;
  }

  async findEmailVerifiedAt(userId: string): Promise<Date | null> {
    const rows = await this.sql<{ email_verified_at: Date | null }[]>`
      select email_verified_at from users where id = ${userId}
    `;
    return rows[0]?.email_verified_at ?? null;
  }

  // ---- admin console v6 (agent D) -------------------------------------------------------

  async listEventCodes(eventId: string): Promise<EventCodeRow[]> {
    const rows = await this.sql<EventCodeSql[]>`
      select event_id, code, label, max_uses, uses, expires_at, created_at
      from event_codes
      where event_id = ${eventId}
      order by created_at desc, code
    `;
    return rows.map(mapEventCode);
  }

  async updateEventCode(
    eventId: string,
    code: string,
    patch: EventCodePatch,
  ): Promise<EventCodeRow | null> {
    // `coalesce` is wrong here: every field is nullable and null means "clear it", so the
    // untouched case has to be the column itself (same shape as `updateAlbum`).
    const rows = await this.sql<EventCodeSql[]>`
      update event_codes set
        label = ${patch.label === undefined ? this.sql`label` : this.sql`${patch.label}::text`},
        max_uses = ${
          patch.maxUses === undefined ? this.sql`max_uses` : this.sql`${patch.maxUses}::int`
        },
        expires_at = ${
          patch.expiresAt === undefined
            ? this.sql`expires_at`
            : this.sql`${patch.expiresAt}::timestamptz`
        }
      where event_id = ${eventId} and code = ${code}
      returning event_id, code, label, max_uses, uses, expires_at, created_at
    `;
    return rows[0] ? mapEventCode(rows[0]) : null;
  }

  async revokeEventCode(eventId: string, code: string): Promise<EventCodeRow | null> {
    const rows = await this.sql<EventCodeSql[]>`
      update event_codes set expires_at = now()
      where event_id = ${eventId} and code = ${code}
      returning event_id, code, label, max_uses, uses, expires_at, created_at
    `;
    return rows[0] ? mapEventCode(rows[0]) : null;
  }

  async addAlbumPhotographer(albumId: string, userId: string): Promise<void> {
    await this.sql`
      insert into album_photographers (album_id, user_id)
      values (${albumId}, ${userId})
      on conflict (album_id, user_id) do nothing
    `;
  }

  async removeAlbumPhotographer(albumId: string, userId: string): Promise<boolean> {
    const rows = await this.sql<{ album_id: string }[]>`
      delete from album_photographers
      where album_id = ${albumId} and user_id = ${userId}
      returning album_id
    `;
    return rows.length > 0;
  }

  // ---- privacy and retention scheduling v6 (agent G) ---------------------------------------

  async findConsentState(userId: string, eventId: string): Promise<ConsentState> {
    const vectors = await this.queryVectorAvailable();
    const [consents, galleries] = await Promise.all([
      this.sql<{ granted_at: Date; text_version: string; withdrawn_at: Date | null }[]>`
        select granted_at, text_version, withdrawn_at from consents
        where user_id = ${userId} and event_id = ${eventId}
        order by granted_at desc, id desc
      `,
      this.sql<{
        id: string;
        matched_at: Date | null;
        anchors: number;
        has_vector: boolean;
        photos: number;
      }[]>`
        select g.id,
               g.matched_at,
               cardinality(g.anchor_face_ids) as anchors,
               ${vectors ? this.sql`(g.query_embedding is not null)` : this.sql`false`} as has_vector,
               (select count(*)::int from gallery_items gi where gi.gallery_id = g.id) as photos
        from galleries g
        where g.user_id = ${userId} and g.event_id = ${eventId}
      `,
    ]);
    const active = consents.find((row) => row.withdrawn_at === null) ?? null;
    const withdrawn = consents.find((row) => row.withdrawn_at !== null)?.withdrawn_at ?? null;
    const gallery = galleries[0];
    return {
      grantedAt: active?.granted_at ?? null,
      textVersion: active?.text_version ?? null,
      withdrawnAt: withdrawn,
      gallery: gallery
        ? {
            photos: gallery.photos,
            selfieVector: gallery.has_vector,
            anchors: Number(gallery.anchors ?? 0),
            matchedAt: gallery.matched_at,
          }
        : null,
    };
  }

  async withdrawConsent(input: { userId: string; eventId: string }): Promise<ConsentWithdrawal> {
    const vectors = await this.queryVectorAvailable();
    const faceVectorsTable = await this.faceVectorsAvailable();
    return inTransaction(this.sql, async (tx) => {
      const consents = await tx<{ id: string }[]>`
        update consents set withdrawn_at = now()
        where user_id = ${input.userId} and event_id = ${input.eventId} and withdrawn_at is null
        returning id
      `;
      const galleries = await tx<{
        id: string;
        anchor_face_ids: string[];
        selfie_key: string | null;
        has_vector: boolean;
      }[]>`
        select id, anchor_face_ids, selfie_key,
               ${vectors ? this.sql`(query_embedding is not null)` : this.sql`false`} as has_vector
        from galleries
        where user_id = ${input.userId} and event_id = ${input.eventId}
        for update
      `;
      const gallery = galleries[0];
      const anchors = gallery?.anchor_face_ids ?? [];
      // The faces this person was identified as: the gallery's anchors plus the face behind
      // every gallery item. Both are a person-to-template link made by the system, so both go.
      const itemFaces = gallery
        ? await tx<{ external_id: string }[]>`
            select f.external_id
            from gallery_items gi join faces f on f.id = gi.face_id
            where gi.gallery_id = ${gallery.id}
          `
        : [];
      const externalFaceIds = [...new Set([...anchors, ...itemFaces.map((row) => row.external_id)])];
      let galleryItems = 0;
      if (gallery) {
        const removed = await tx`delete from gallery_items where gallery_id = ${gallery.id}`;
        galleryItems = removed.count;
        // The row carries query_embedding (the selfie template), the anchors and selfie_key:
        // deleting it removes all three at once.
        await tx`delete from galleries where id = ${gallery.id}`;
      }
      let faceVectors = 0;
      if (faceVectorsTable && externalFaceIds.length > 0) {
        // face_vectors.external_face_id is a uuid; anchors and faces.external_id are text and
        // may hold a non-uuid id (the fake engine), which never has a row here.
        const uuids = externalFaceIds.filter((id) => UUID_TEXT.test(id));
        if (uuids.length > 0) {
          const removed = await tx`
            delete from face_vectors
            where event_id = ${input.eventId} and external_face_id = any(${uuids}::uuid[])
          `;
          faceVectors = removed.count;
        }
      }
      if (externalFaceIds.length > 0) {
        // Another participant's gallery may be anchored on one of these faces (a false match,
        // or two people in one crop). The template is gone, so the dangling anchor goes too —
        // exactly what purgePhoto does for a deleted photo. Their gallery_items, their selfie
        // vector and their photos are untouched.
        await tx`
          update galleries
          set anchor_face_ids = coalesce(
            (select array_agg(x) from unnest(anchor_face_ids) x where x <> all(${externalFaceIds}::text[])),
            '{}'::text[]
          )
          where event_id = ${input.eventId} and anchor_face_ids && ${externalFaceIds}::text[]
        `;
      }
      const feedback = await tx`
        delete from gallery_feedback
        where user_id = ${input.userId} and event_id = ${input.eventId}
      `;
      // match_runs holds the raw cosines of this person's selfie against named faces; the hits
      // cascade with the run (migration 006).
      const matchRuns = await tx`
        delete from match_runs where user_id = ${input.userId} and event_id = ${input.eventId}
      `;
      return {
        consents: consents.length,
        galleryDeleted: gallery !== undefined,
        galleryItems,
        selfieVector: gallery?.has_vector === true,
        anchors: anchors.length,
        faceVectors,
        externalFaceIds,
        selfieKeys: gallery?.selfie_key ? [gallery.selfie_key] : [],
        feedback: feedback.count,
        matchRuns: matchRuns.count,
      };
    });
  }

  async claimRetentionWindow(input: {
    eventId: string;
    windowStart: Date;
    windowSeconds: number;
  }): Promise<boolean> {
    // Exactly once per (event, window): the `where` of the upsert is re-evaluated against the
    // row the other writer committed, so the second caller gets no row back (migration 015).
    const rows = await this.sql<{ event_id: string }[]>`
      insert into retention_schedule (event_id, window_start, window_seconds, last_outcome, runs)
      values (${input.eventId}, ${input.windowStart}, ${input.windowSeconds}, 'enqueued', 1)
      on conflict (event_id) do update
        set window_start = excluded.window_start,
            window_seconds = excluded.window_seconds,
            claimed_at = now(),
            updated_at = now(),
            runs = retention_schedule.runs + 1,
            last_outcome = 'enqueued',
            last_job_id = null,
            last_error = null
        where retention_schedule.window_start < excluded.window_start
      returning event_id
    `;
    return rows.length > 0;
  }

  // ---- event membership + tagging v6 (agent E) -------------------------------------------

  async addEventMember(input: {
    userId: string;
    eventId: string;
    source: EventMemberSource;
  }): Promise<EventMemberRow> {
    // Idempotent and non-destructive: a second call keeps the first row, `source` included,
    // so the provenance recorded is how the person FIRST came to belong to the event. The
    // `do update set user_id = excluded.user_id` is a no-op that makes the insert always
    // return a row, which an `on conflict do nothing` would not.
    const rows = await this.sql<EventMemberSql[]>`
      insert into event_members (user_id, event_id, source)
      values (${input.userId}, ${input.eventId}, ${input.source})
      on conflict (user_id, event_id) do update set user_id = excluded.user_id
      returning user_id, event_id, source, taggable,
                taggable_consent_version, taggable_consent_at, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error("event_members insert returned no row");
    return mapEventMember(row);
  }

  async isEventMember(userId: string, eventId: string): Promise<boolean> {
    const rows = await this.sql<{ ok: number }[]>`
      select 1 as ok from event_members
      where user_id = ${userId} and event_id = ${eventId}
    `;
    return rows.length > 0;
  }

  async listAlbumPhotographers(albumId: string): Promise<AlbumPhotographerRow[]> {
    const rows = await this.sql<
      { album_id: string; user_id: string; email: string; created_at: Date }[]
    >`
      select ap.album_id, ap.user_id, u.email, ap.created_at
      from album_photographers ap join users u on u.id = ap.user_id
      where ap.album_id = ${albumId}
      order by u.email
    `;
    return rows.map((row) => ({
      albumId: row.album_id,
      userId: row.user_id,
      email: row.email,
      createdAt: row.created_at,
    }));
  }

  async findEventMember(userId: string, eventId: string): Promise<EventMemberRow | null> {
    const rows = await this.sql<EventMemberSql[]>`
      select user_id, event_id, source, taggable,
             taggable_consent_version, taggable_consent_at, created_at
      from event_members where user_id = ${userId} and event_id = ${eventId}
    `;
    return rows[0] ? mapEventMember(rows[0]) : null;
  }

  async findTagProfile(userId: string, eventId: string): Promise<TagProfileRow | null> {
    // The join is an inner one on purpose: no membership row means no tagging profile, and
    // no way to opt in. That is the honest answer now that membership is recorded.
    const rows = await this.sql<TagProfileSql[]>`
      select m.user_id, m.event_id, m.taggable, u.display_name,
             m.taggable_consent_version, m.taggable_consent_at
      from event_members m
      join users u on u.id = m.user_id
      where m.user_id = ${userId} and m.event_id = ${eventId}
    `;
    return rows[0] ? mapTagProfile(rows[0]) : null;
  }

  async setTagProfile(
    userId: string,
    eventId: string,
    input: {
      taggable: boolean;
      displayName?: string | null;
      consentTextVersion?: string | null;
    },
  ): Promise<TagProfileRow | null> {
    const current = await this.findTagProfile(userId, eventId);
    if (!current) return null;
    const name =
      input.displayName === undefined ? current.displayName : normalizeDisplayName(input.displayName);
    // `taggable = true` needs a display name, supplied now or already stored. A taggable row
    // with no name could never be found by the autocomplete anyway, and leaving it possible
    // invites a later "fall back to the e-mail" patch.
    if (input.taggable && !name) return null;
    // The consent pair is the present state: stamped on an opt-in, nulled on an opt-out. The
    // history lives in `audit_log`.
    const consent = nextTagConsent(current, input);
    if (input.taggable && !consent.version) return null;
    // Two writes: the flag and its consent on the membership row, the name on the user. The
    // name is global, so it is only written when the caller actually supplied one.
    if (name !== current.displayName) {
      await this.sql`update users set display_name = ${name} where id = ${userId}`;
    }
    const updated = await this.sql`
      update event_members
      set taggable = ${input.taggable},
          taggable_consent_version = ${consent.version},
          taggable_consent_at = ${consent.at}
      where user_id = ${userId} and event_id = ${eventId}
      returning user_id
    `;
    if (updated.length === 0) return null;
    // Re-read rather than compose a RETURNING across the two tables: one extra round trip on
    // a route a participant hits by hand, in exchange for one definition of the row.
    return this.findTagProfile(userId, eventId);
  }

  async searchTaggableUsers(input: {
    eventId: string;
    prefix: string;
    limit: number;
  }): Promise<TaggableUserRow[]> {
    // Second line of defence: the API already refuses a short query, and this makes a future
    // caller that forgets to get nothing rather than the whole roster.
    const prefix = input.prefix.trim().toLowerCase();
    if (prefix.length < TAG_SEARCH_MIN_PREFIX) return [];
    // Two membership tests, both non-biometric:
    //   * `event_members` for THIS event — so a person who opted in at event A is not
    //     suggested at event B (that is `event_members_taggable_idx`);
    //   * `m.taggable`, the per-event opt-in, which is the consent for tagging.
    // A recognition consent is NOT required and must never be added back: decision 2 freezes
    // that a crowd album is never biometric, so its participants never grant one, and tagging
    // is the only way they can find themselves there.
    const rows = await this.sql<{ id: string; display_name: string }[]>`
      select u.id, u.display_name
      from users u
      join event_members m on m.user_id = u.id
      where m.event_id = ${input.eventId}
        and m.taggable
        and u.display_name is not null
        and lower(u.display_name) like ${`${escapeLike(prefix)}%`}
      order by lower(u.display_name) asc, u.id asc
      limit ${input.limit}
    `;
    return rows.map((row) => ({ userId: row.id, displayName: row.display_name }));
  }

  async insertPhotoTag(input: {
    photoId: string;
    userId: string;
    taggedBy: string;
  }): Promise<PhotoTagRow | null> {
    // One statement, and the opt-in is a `where` on the source rows, so a concurrent opt-out
    // cannot be raced. The event is taken from the photo itself, so the per-event opt-in is
    // checked against the event the photo actually belongs to and not against one the caller
    // named. `on conflict do nothing` keeps a 'removed' row untouched.
    const rows = await this.sql<PhotoTagSql[]>`
      insert into photo_tags (photo_id, user_id, tagged_by)
      select p.id, m.user_id, ${input.taggedBy}::uuid
      from photos p
      join event_members m
        on m.event_id = p.event_id and m.user_id = ${input.userId} and m.taggable
      join users u on u.id = m.user_id and u.display_name is not null
      where p.id = ${input.photoId}
      on conflict (photo_id, user_id) do nothing
      returning photo_id, user_id, tagged_by, state, created_at
    `;
    return rows[0] ? mapPhotoTag(rows[0]) : null;
  }

  async findPhotoTag(photoId: string, userId: string): Promise<PhotoTagRow | null> {
    const rows = await this.sql<PhotoTagSql[]>`
      select photo_id, user_id, tagged_by, state, created_at from photo_tags
      where photo_id = ${photoId} and user_id = ${userId}
    `;
    return rows[0] ? mapPhotoTag(rows[0]) : null;
  }

  async removePhotoTag(photoId: string, userId: string): Promise<PhotoTagRow | null> {
    const rows = await this.sql<PhotoTagSql[]>`
      update photo_tags set state = 'removed'
      where photo_id = ${photoId} and user_id = ${userId} and state = 'active'
      returning photo_id, user_id, tagged_by, state, created_at
    `;
    return rows[0] ? mapPhotoTag(rows[0]) : null;
  }

  async listActivePhotoTagsForUser(userId: string, eventId: string): Promise<PhotoTagRow[]> {
    // Scoped to the event, because the opt-in is: opting out of event A must not remove the
    // tags the same person accepted at event B.
    const rows = await this.sql<PhotoTagSql[]>`
      select pt.photo_id, pt.user_id, pt.tagged_by, pt.state, pt.created_at
      from photo_tags pt
      join photos p on p.id = pt.photo_id
      where pt.user_id = ${userId} and pt.state = 'active' and p.event_id = ${eventId}
      order by pt.created_at desc, pt.photo_id asc
    `;
    return rows.map(mapPhotoTag);
  }

  async listTaggedPhotosForUser(userId: string, eventId: string): Promise<TaggedPhotoRow[]> {
    const rows = await this.sql<{
      photo_id: string;
      event_id: string;
      thumb_key: string;
      web_key: string;
      tagged_by: string | null;
      created_at: Date;
    }[]>`
      select pt.photo_id, p.event_id, t.s3_key as thumb_key, w.s3_key as web_key,
             pt.tagged_by, pt.created_at
      from photo_tags pt
      join photos p on p.id = pt.photo_id
      join derivatives t on t.photo_id = pt.photo_id and t.kind = 'thumb'
      join derivatives w on w.photo_id = pt.photo_id and w.kind = 'web'
      where pt.user_id = ${userId} and pt.state = 'active' and p.event_id = ${eventId}
      order by pt.created_at desc, pt.photo_id asc
    `;
    return rows.map((row) => ({
      photoId: row.photo_id,
      eventId: row.event_id,
      thumbKey: row.thumb_key,
      webKey: row.web_key,
      taggedBy: row.tagged_by,
      createdAt: row.created_at,
    }));
  }

  async isAlbumPhotographerAllowed(albumId: string, userId: string): Promise<boolean> {
    // One statement: an album with no list is unrestricted (v5 behaviour), an album with a
    // list only lets through the users on it.
    const rows = await this.sql<{ allowed: boolean }[]>`
      select (
        not exists (select 1 from album_photographers where album_id = ${albumId})
        or exists (
          select 1 from album_photographers
          where album_id = ${albumId} and user_id = ${userId}
        )
      ) as allowed
    `;
    return rows[0]?.allowed === true;
  }

  async eventStatus(eventId: string): Promise<EventStatus> {
    // Event-scoped and exact: unlike `metrics()` these numbers are read while two people
    // watch the screen on the event day, so an approximation from pg_stat is not enough.
    const counters = await this.sql<{
      photos: number;
      photos_uploaded: number;
      photos_processing: number;
      photos_indexed: number;
      photos_error: number;
      originals_pending: number;
      faces: number;
      galleries: number;
      galleries_matched: number;
      selfies_waiting: number;
    }[]>`
      select
        (select count(*)::int from photos where event_id = ${eventId}) as photos,
        (select count(*)::int from photos where event_id = ${eventId} and status = 'uploaded')
          as photos_uploaded,
        (select count(*)::int from photos where event_id = ${eventId} and status = 'processing')
          as photos_processing,
        (select count(*)::int from photos where event_id = ${eventId} and status = 'indexed')
          as photos_indexed,
        (select count(*)::int from photos where event_id = ${eventId} and status = 'error')
          as photos_error,
        (select count(*)::int from photos
          where event_id = ${eventId} and original_status = 'pending') as originals_pending,
        (select count(*)::int from faces where event_id = ${eventId}) as faces,
        (select count(*)::int from galleries where event_id = ${eventId}) as galleries,
        (select count(*)::int from galleries
          where event_id = ${eventId} and matched_at is not null) as galleries_matched,
        (select count(*)::int from galleries
          where event_id = ${eventId} and query_embedding is not null and matched_at is null)
          as selfies_waiting
    `;
    const albums = await this.sql<{
      id: string;
      slug: string;
      name: string;
      kind: AlbumKind;
      recognition: boolean;
      moderation: AlbumModeration;
      uploads_open: boolean;
      first_upload_at: Date | null;
      photos: number;
    }[]>`
      select a.id, a.slug, a.name, a.kind, a.recognition, a.moderation, a.uploads_open,
             a.first_upload_at,
             (select count(*)::int from photos p where p.album_id = a.id) as photos
      from albums a
      where a.event_id = ${eventId}
      order by a.created_at, a.id
    `;
    const row = counters[0];
    return {
      photos: row?.photos ?? 0,
      photosByStatus: {
        uploaded: row?.photos_uploaded ?? 0,
        processing: row?.photos_processing ?? 0,
        indexed: row?.photos_indexed ?? 0,
        error: row?.photos_error ?? 0,
      },
      originalsPending: row?.originals_pending ?? 0,
      faces: row?.faces ?? 0,
      galleries: row?.galleries ?? 0,
      galleriesMatched: row?.galleries_matched ?? 0,
      selfiesWaiting: row?.selfies_waiting ?? 0,
      albums: albums.map(
        (album): EventStatusAlbum => ({
          id: album.id,
          slug: album.slug,
          name: album.name,
          kind: album.kind,
          recognition: album.recognition,
          moderation: album.moderation,
          uploadsOpen: album.uploads_open,
          photos: Number(album.photos),
          firstUploadAt: album.first_upload_at,
        }),
      ),
    };
  }

  // ---- crowd upload and moderation v6 (agent C) -----------------------------------------

  async countAlbumPhotosByUploader(albumId: string, uploaderId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from photos
      where album_id = ${albumId}
        and photographer_id = ${uploaderId}
        and moderation_state in ('approved', 'pending')
    `;
    return rows[0]?.count ?? 0;
  }

  async countAlbumUploadsSince(
    albumId: string,
    uploaderId: string,
    since: Date,
  ): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from upload_sessions
      where album_id = ${albumId}
        and photographer_id = ${uploaderId}
        and created_at >= ${since}
    `;
    return rows[0]?.count ?? 0;
  }

  async recordRetentionRun(input: {
    eventId: string;
    outcome: RetentionOutcome;
    jobId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.sql`
      update retention_schedule
      set last_outcome = ${input.outcome},
          last_job_id = ${input.jobId ?? null},
          last_error = ${input.error ?? null},
          updated_at = now()
      where event_id = ${input.eventId}
    `;
  }

  async listRetentionStatus(): Promise<RetentionStatusRow[]> {
    const rows = await this.sql<RetentionStatusSql[]>`
      select e.id as event_id,
             e.slug,
             e.retention_days,
             s.window_start,
             s.window_seconds,
             s.claimed_at,
             coalesce(s.runs, 0) as runs,
             s.last_outcome,
             s.last_job_id,
             s.last_error,
             j.id as job_id,
             j.status as job_status,
             j.last_error as job_error,
             j.finished_at as job_finished_at
      from events e
      left join retention_schedule s on s.event_id = e.id
      left join lateral (
        select id, status, last_error, finished_at
        from jobs
        where type = 'retention' and payload ->> 'eventId' = e.id::text
        order by created_at desc, id desc
        limit 1
      ) j on true
      order by e.created_at, e.id
    `;
    return rows.map(mapRetentionStatus);
  }

  async listAlbumPhotosCreatedBefore(
    albumId: string,
    cutoff: Date,
    limit?: number,
  ): Promise<PhotoRow[]> {
    const rows = await this.sql<PhotoSql[]>`
      select ${this.sql.unsafe(PHOTO_COLUMNS)}
      from photos
      where album_id = ${albumId} and created_at < ${cutoff}
      order by created_at
      ${limit === undefined ? this.sql`` : this.sql`limit ${limit}`}
    `;
    return rows.map(mapPhoto);
  }

  async claimRetentionAlarmMail(input: {
    eventId: string;
    alarm: RetentionAlarmMail;
    window: Date;
  }): Promise<boolean> {
    // Same shape as the window claim: the `where` is re-evaluated against the row the other
    // writer committed, so the second caller gets nothing back and sends nothing.
    const rows = await this.sql<{ event_id: string }[]>`
      update retention_schedule
      set notified_alarm = ${input.alarm},
          notified_window = ${input.window},
          updated_at = now()
      where event_id = ${input.eventId}
        and (notified_window is null
             or notified_window < ${input.window}
             or notified_alarm is distinct from ${input.alarm})
      returning event_id
    `;
    return rows.length > 0;
  }

  async clearRetentionAlarmMail(eventId: string): Promise<RetentionAlarmMail | null> {
    // `returning notified_alarm` would hand back the *new* value (null): RETURNING in an
    // update sees the row after the change. The caller needs what the alarm was, to name it
    // in the "resolved" message, so the old value is read in a CTE. `for update` makes the
    // pair atomic: a concurrent clear blocks, then re-checks the row, finds it already
    // cleared and updates nothing — so only one caller ever sends that one message.
    const rows = await this.sql<{ notified_alarm: RetentionAlarmMail }[]>`
      with previous as (
        select event_id, notified_alarm from retention_schedule
        where event_id = ${eventId} and notified_alarm is not null
        for update
      )
      update retention_schedule s
      set notified_alarm = null, notified_window = null, updated_at = now()
      from previous p
      where s.event_id = p.event_id
      returning p.notified_alarm
    `;
    return rows[0]?.notified_alarm ?? null;
  }

  async countPhotosByUploader(eventId: string, userId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from photos
      where event_id = ${eventId} and photographer_id = ${userId}
    `;
    return rows[0]?.count ?? 0;
  }

  async setPhotoModeration(input: {
    photoId: string;
    state: ModerationState;
    moderatorId?: string | null;
    at?: Date;
  }): Promise<PhotoRow | null> {
    const human = input.moderatorId ?? null;
    const at = input.at ?? new Date();
    // The automatic paths (screening hook, report threshold) leave `moderated_by` /
    // `moderated_at` untouched: an unruled photo must still read as unruled in the queue.
    const rows = await this.sql<PhotoSql[]>`
      update photos set
        moderation_state = ${input.state},
        moderated_by = coalesce(${human}::uuid, moderated_by),
        moderated_at = ${human === null ? this.sql`moderated_at` : this.sql`${at}::timestamptz`}
      where id = ${input.photoId}
      returning ${this.sql.unsafe(PHOTO_COLUMNS)}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  async insertReport(input: {
    photoId: string;
    reporterId: string;
    reason: ReportReason;
    note?: string | null;
  }): Promise<{ created: boolean; report: ReportRow }> {
    // One report per person per photo (`reports unique (photo_id, reporter_id)`), so a
    // repeated tap is an answer rather than an error — with ONE exception: a stored `not_me`
    // may be escalated to a counting reason.
    //
    // Without that exception, tapping "non sono io" would silently spend the person's only
    // report on this photo, and someone who first corrected a wrong match and then realised
    // the photo is genuinely inappropriate could never say so. The `where` clause makes the
    // escalation one-way: a counting reason is never replaced, least of all by `not_me`, so
    // this cannot be used to un-report something.
    const inserted = await this.sql<ReportSql[]>`
      insert into reports (photo_id, reporter_id, reason, note)
      values (${input.photoId}, ${input.reporterId}, ${input.reason}, ${input.note ?? null})
      on conflict (photo_id, reporter_id) do update
        set reason = excluded.reason,
            note = coalesce(excluded.note, reports.note),
            state = 'open',
            created_at = now()
        where reports.reason = 'not_me' and excluded.reason <> 'not_me'
      returning ${this.sql.unsafe(REPORT_COLUMNS)}
    `;
    const row = inserted[0];
    if (row) return { created: true, report: mapReport(row) };
    const existing = await this.sql<ReportSql[]>`
      select ${this.sql.unsafe(REPORT_COLUMNS)} from reports
      where photo_id = ${input.photoId} and reporter_id = ${input.reporterId}
    `;
    const previous = existing[0];
    if (!previous) throw new Error("Report insert failed");
    return { created: false, report: mapReport(previous) };
  }

  async countOpenReports(photoId: string): Promise<number> {
    // Counting reasons ONLY. A `not_me` report is recorded but never moves a photo: it is
    // the normal error mode of face matching, not an abuse signal, and it is answered
    // per-user through `gallery_feedback`. See MODERATION_COUNTING_REASONS.
    const rows = await this.sql<{ count: number }[]>`
      select count(distinct reporter_id)::int as count from reports
      where photo_id = ${photoId} and state = 'open'
        and reason = any(${[...MODERATION_COUNTING_REASONS]}::text[])
    `;
    return rows[0]?.count ?? 0;
  }

  async countOpenNotMeReports(photoId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(distinct reporter_id)::int as count from reports
      where photo_id = ${photoId} and state = 'open' and reason = 'not_me'
    `;
    return rows[0]?.count ?? 0;
  }

  async countReportsByUserSince(reporterId: string, since: Date): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from reports
      where reporter_id = ${reporterId} and created_at >= ${since}
    `;
    return rows[0]?.count ?? 0;
  }

  async closeReports(photoId: string): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      update reports set state = 'closed'
      where photo_id = ${photoId} and state = 'open'
      returning id
    `;
    return rows.length;
  }

  // ---- hardening v6 (agent H): password-reset tokens, migration 016 -----------------------

  async insertPasswordResetToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
  }): Promise<void> {
    await this.sql`
      insert into password_reset_tokens (user_id, token_hash, expires_at, ip)
      values (${input.userId}, ${input.tokenHash}, ${input.expiresAt}, ${input.ip})
    `;
  }

  async countPasswordResetTokensSince(input: {
    userId?: string;
    ip?: string;
    since: Date;
  }): Promise<number> {
    if (input.userId === undefined && input.ip === undefined) return 0;
    const rows = await this.sql<{ count: string }[]>`
      select count(*)::text as count from password_reset_tokens
      where created_at >= ${input.since}
        and (${input.userId ?? null}::uuid is null or user_id = ${input.userId ?? null})
        and (${input.ip ?? null}::text is null or ip = ${input.ip ?? null})
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** One statement: the `used_at is null` guard makes a replay (or a race) return null. */
  async consumePasswordResetToken(tokenHash: string): Promise<{ userId: string } | null> {
    const rows = await this.sql<{ user_id: string }[]>`
      update password_reset_tokens
      set used_at = now()
      where token_hash = ${tokenHash}
        and used_at is null
        and expires_at > now()
      returning user_id
    `;
    const row = rows[0];
    return row ? { userId: String(row.user_id) } : null;
  }

  async invalidatePasswordResetTokens(userId: string): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      update password_reset_tokens
      set used_at = now()
      where user_id = ${userId} and used_at is null
      returning id
    `;
    return rows.length;
  }

  async listOpenReports(photoId: string): Promise<ReportRow[]> {
    const rows = await this.sql<ReportSql[]>`
      select ${this.sql.unsafe(REPORT_COLUMNS)} from reports
      where photo_id = ${photoId} and state = 'open'
      order by created_at, id
    `;
    return rows.map(mapReport);
  }

  async listModerationPage(input: {
    albumId?: string;
    state?: ModerationState;
    includeNotMe?: boolean;
    limit: number;
    cursor?: UploadCursor;
  }): Promise<{ items: ModerationItem[]; nextCursor: UploadCursor | null }> {
    const cursor = input.cursor;
    const albumId = input.albumId ?? null;
    const state = input.state ?? null;
    // The queue is "everything a moderator still has to look at": not approved, or approved
    // with an open report whose reason COUNTS. `not_me` alone never queues a photo -- with
    // 6,000 participants wrong matches are the common case and they would bury two
    // moderators -- but the count is reported so a moderator looking at a photo for another
    // reason sees it, and `includeNotMe` asks for them on purpose.
    //
    // NOTE for anyone adding a `-- ...` comment INSIDE one of these tagged templates: a
    // backtick in it closes the template literal, and the parser then fails lines away with
    // a bewildering "',' expected". Name columns bare in SQL comments (moderation_state),
    // never in the backticks this file uses in its TypeScript comments. It has bitten twice.
    const rows = await this.sql<ModerationSql[]>`
      select p.id, p.album_id, p.event_id, p.photographer_id, p.moderation_state, p.created_at,
             coalesce(r.open_reports, 0)::int as open_reports,
             coalesce(r.reasons, '{}')::text[] as reasons,
             coalesce(r.not_me_reports, 0)::int as not_me_reports,
             thumb.s3_key as thumb_key,
             web.s3_key as web_key
      from photos p
      left join (
        select photo_id,
               count(distinct reporter_id) filter (
                 where reason = any(${[...MODERATION_COUNTING_REASONS]}::text[])
               ) as open_reports,
               count(distinct reporter_id) filter (where reason = 'not_me') as not_me_reports,
               array_agg(distinct reason order by reason) as reasons
        from reports where state = 'open'
        group by photo_id
      ) r on r.photo_id = p.id
      left join derivatives thumb on thumb.photo_id = p.id and thumb.kind = 'thumb'
      left join derivatives web on web.photo_id = p.id and web.kind = 'web'
      where (
          p.moderation_state <> 'approved'
          or coalesce(r.open_reports, 0) > 0
          ${input.includeNotMe ? this.sql`or coalesce(r.not_me_reports, 0) > 0` : this.sql``}
        )
        ${albumId ? this.sql`and p.album_id = ${albumId}::uuid` : this.sql``}
        ${state ? this.sql`and p.moderation_state = ${state}` : this.sql``}
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', p.created_at, 'UTC'), p.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : this.sql``
        }
      order by date_trunc('milliseconds', p.created_at, 'UTC') desc, p.id desc
      limit ${input.limit + 1}
    `;
    const items = rows.slice(0, input.limit).map(mapModerationItem);
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
    // `approved` only: a photo flipped to `pending` by the report threshold leaves the feed
    // on the next page load, with no second switch to keep in sync.
    const rows = await this.sql<AlbumPhotoSql[]>`
      select p.id, p.album_id, p.photographer_id, p.created_at,
             thumb.s3_key as thumb_key, web.s3_key as web_key
      from photos p
      join derivatives thumb on thumb.photo_id = p.id and thumb.kind = 'thumb'
      join derivatives web on web.photo_id = p.id and web.kind = 'web'
      where p.album_id = ${albumId} and p.moderation_state = 'approved'
        ${
          cursor
            ? this.sql`and (date_trunc('milliseconds', p.created_at, 'UTC'), p.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : this.sql``
        }
      order by date_trunc('milliseconds', p.created_at, 'UTC') desc, p.id desc
      limit ${input.limit + 1}
    `;
    const items = rows.slice(0, input.limit).map(mapAlbumPhoto);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, nextCursor };
  }

  async listAlbumPhotosByIds(albumId: string, ids: string[]): Promise<AlbumPhoto[]> {
    if (ids.length === 0) return [];
    // Same three conditions as `listAlbumPhotosPage`: this album, `approved`, both
    // derivatives. No ordering clause and so no `date_trunc` — an `id = any(...)` lookup is
    // served by the primary key.
    const rows = await this.sql<AlbumPhotoSql[]>`
      select p.id, p.album_id, p.photographer_id, p.created_at,
             thumb.s3_key as thumb_key, web.s3_key as web_key
      from photos p
      join derivatives thumb on thumb.photo_id = p.id and thumb.kind = 'thumb'
      join derivatives web on web.photo_id = p.id and web.kind = 'web'
      where p.album_id = ${albumId}
        and p.moderation_state = 'approved'
        and p.id = any(${ids}::uuid[])
    `;
    return rows.map(mapAlbumPhoto);
  }

  /** Whether migration 005 could create `face_vectors` (it needs pgvector). Cached like the column probe. */
  private faceVectorsAvailable(): Promise<boolean> {
    if (!this.faceVectorsChecked) {
      this.faceVectorsChecked = this.sql<{ present: boolean }[]>`
        select to_regclass('public.face_vectors') is not null as present
      `
        .then((rows) => rows[0]?.present === true)
        .catch((error: unknown) => {
          this.faceVectorsChecked = undefined;
          throw error;
        });
    }
    return this.faceVectorsChecked;
  }

  private faceVectorsChecked: Promise<boolean> | undefined;

  async listPhotoTags(photoId: string): Promise<PhotoTagWithNameRow[]> {
    const rows = await this.sql<(PhotoTagSql & { display_name: string | null })[]>`
      select pt.photo_id, pt.user_id, pt.tagged_by, pt.state, pt.created_at, u.display_name
      from photo_tags pt
      join users u on u.id = pt.user_id
      where pt.photo_id = ${photoId} and pt.state = 'active'
      order by pt.created_at asc, pt.user_id asc
    `;
    return rows.map((row) => ({ ...mapPhotoTag(row), displayName: row.display_name }));
  }

  async listAuditForTarget(target: string): Promise<AuditEntryRow[]> {
    const rows = await this.sql<{
      id: string;
      actor_id: string | null;
      action: string;
      target: string;
      meta: unknown;
      created_at: Date;
    }[]>`
      select id, actor_id, action, target, meta, created_at from audit_log
      where target = ${target}
      order by created_at asc, id asc
    `;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      target: row.target,
      // `audit_log.meta` is jsonb, and this driver hands it back as text, so it is parsed
      // here. An unreadable value becomes `{}` rather than throwing: a malformed audit row
      // must not break reading the rest of the trail.
      meta: parseAuditMeta(row.meta),
      createdAt: row.created_at,
    }));
  }
}

/** Maps the album constraints of migration 009 to their typed errors. */
function albumError(error: unknown): unknown {
  if (isUniqueViolation(error)) return new DuplicateKeyError();
  if (typeof error !== "object" || error === null || !("code" in error)) return error;
  const code = (error as { code?: unknown }).code;
  if (code === "ALBRI") return new AlbumRecognitionLockedError();
  const constraint = (error as { constraint_name?: unknown }).constraint_name;
  if (code === "23514" && constraint === "crowd_never_recognizes") {
    return new AlbumRecognitionNotAllowedError();
  }
  return error;
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
  sha256: string;
  status: PhotoStatus;
  original_key: string;
  content_type: string;
  bytes: string | number;
  original_status: OriginalStatus;
  indexed_at: Date | null;
  error: string | null;
  created_at: Date;
  album_id: string;
  moderation_state: ModerationState;
};
type AlbumSql = {
  id: string;
  event_id: string;
  slug: string;
  name: string;
  kind: AlbumKind;
  recognition: boolean;
  moderation: AlbumModeration;
  visibility: AlbumVisibility;
  max_photos_per_user: number | null;
  uploads_open: boolean;
  retention_days: number | null;
  first_upload_at: Date | null;
  created_at: Date;
};
type UploadSql = {
  id: string;
  event_id: string;
  photographer_id: string;
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
  album_id: string | null;
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
    sha256: row.sha256,
    status: row.status,
    originalKey: row.original_key,
    contentType: asContentType(row.content_type),
    bytes: Number(row.bytes),
    originalStatus: row.original_status,
    indexedAt: row.indexed_at,
    error: row.error,
    createdAt: row.created_at,
    albumId: row.album_id,
    moderationState: row.moderation_state,
  };
}
function mapAlbum(row: AlbumSql): AlbumRow {
  return {
    id: row.id,
    eventId: row.event_id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    recognition: row.recognition,
    moderation: row.moderation,
    visibility: row.visibility,
    maxPhotosPerUser: row.max_photos_per_user === null ? null : Number(row.max_photos_per_user),
    uploadsOpen: row.uploads_open,
    retentionDays: row.retention_days === null ? null : Number(row.retention_days),
    firstUploadAt: row.first_upload_at,
    createdAt: row.created_at,
  };
}
function mapUpload(row: UploadSql): UploadSessionRow {
  return {
    id: row.id,
    eventId: row.event_id,
    photographerId: row.photographer_id,
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
    albumId: row.album_id,
  };
}
function mapPhotoAdmin(row: PhotoAdminSql): PhotoAdminRow {
  return { ...mapPhoto(row), filename: row.filename ?? null, tags: row.tags ?? [] };
}

// ---- auth v6 (agent B) --------------------------------------------------------------------

type EventCodeSql = {
  event_id: string;
  code: string;
  label: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: Date | null;
  created_at: Date;
};

function mapEventCode(row: EventCodeSql): EventCodeRow {
  return {
    eventId: row.event_id,
    code: row.code,
    label: row.label,
    maxUses: row.max_uses === null ? null : Number(row.max_uses),
    uses: Number(row.uses),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// ---- crowd upload and moderation v6 (agent C) ---------------------------------------------

const REPORT_COLUMNS = "id, photo_id, reporter_id, reason, note, state, created_at";

type ReportSql = {
  id: string;
  photo_id: string;
  reporter_id: string;
  reason: ReportReason;
  note: string | null;
  state: "open" | "closed";
  created_at: Date;
};

type ModerationSql = {
  id: string;
  album_id: string;
  event_id: string;
  photographer_id: string;
  moderation_state: ModerationState;
  created_at: Date;
  open_reports: number;
  reasons: string[] | null;
  not_me_reports: number;
  thumb_key: string | null;
  web_key: string | null;
};

type AlbumPhotoSql = {
  id: string;
  album_id: string;
  photographer_id: string;
  created_at: Date;
  thumb_key: string;
  web_key: string;
};

function mapReport(row: ReportSql): ReportRow {
  return {
    id: row.id,
    photoId: row.photo_id,
    reporterId: row.reporter_id,
    reason: row.reason,
    note: row.note,
    state: row.state,
    createdAt: row.created_at,
  };
}

// ---- tagging v6 (agent E) -----------------------------------------------------------------

type EventMemberSql = {
  user_id: string;
  event_id: string;
  source: EventMemberSource;
  taggable: boolean;
  taggable_consent_version: string | null;
  taggable_consent_at: Date | null;
  created_at: Date;
};

type TagProfileSql = {
  user_id: string;
  event_id: string;
  taggable: boolean;
  display_name: string | null;
  taggable_consent_version: string | null;
  taggable_consent_at: Date | null;
};

function mapEventMember(row: EventMemberSql): EventMemberRow {
  return {
    userId: row.user_id,
    eventId: row.event_id,
    source: row.source,
    taggable: row.taggable,
    taggableConsentVersion: row.taggable_consent_version,
    taggableConsentAt: row.taggable_consent_at,
    createdAt: row.created_at,
  };
}

type PhotoTagSql = {
  photo_id: string;
  user_id: string;
  tagged_by: string | null;
  state: PhotoTagState;
  created_at: Date;
};

function mapTagProfile(row: TagProfileSql): TagProfileRow {
  return {
    userId: row.user_id,
    eventId: row.event_id,
    taggable: row.taggable,
    displayName: row.display_name,
    consentTextVersion: row.taggable_consent_version,
    consentAt: row.taggable_consent_at,
  };
}

function mapPhotoTag(row: PhotoTagSql): PhotoTagRow {
  return {
    photoId: row.photo_id,
    userId: row.user_id,
    taggedBy: row.tagged_by,
    state: row.state,
    createdAt: row.created_at,
  };
}

function mapModerationItem(row: ModerationSql): ModerationItem {
  return {
    photoId: row.id,
    albumId: row.album_id,
    eventId: row.event_id,
    uploaderId: row.photographer_id,
    moderationState: row.moderation_state,
    createdAt: row.created_at,
    openReports: Number(row.open_reports),
    reasons: (row.reasons ?? []) as ReportReason[],
    notMeReports: Number(row.not_me_reports),
    thumbKey: row.thumb_key,
    webKey: row.web_key,
  };
}

function mapAlbumPhoto(row: AlbumPhotoSql): AlbumPhoto {
  return {
    id: row.id,
    albumId: row.album_id,
    uploaderId: row.photographer_id,
    createdAt: row.created_at,
    thumbKey: row.thumb_key,
    webKey: row.web_key,
  };
}

// ---- privacy and retention scheduling v6 (agent G) ----------------------------------------

/** Anchors and `faces.external_id` are text; `face_vectors.external_face_id` is a uuid. */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RetentionStatusSql = {
  event_id: string;
  slug: string;
  retention_days: number;
  window_start: Date | null;
  window_seconds: number | null;
  claimed_at: Date | null;
  runs: number;
  last_outcome: RetentionOutcome | null;
  last_job_id: string | null;
  last_error: string | null;
  job_id: string | null;
  job_status: "queued" | "running" | "done" | "error" | null;
  job_error: string | null;
  job_finished_at: Date | null;
};

function mapRetentionStatus(row: RetentionStatusSql): RetentionStatusRow {
  return {
    eventId: row.event_id,
    slug: row.slug,
    retentionDays: Number(row.retention_days),
    windowStart: row.window_start,
    windowSeconds: row.window_seconds === null ? null : Number(row.window_seconds),
    claimedAt: row.claimed_at,
    runs: Number(row.runs ?? 0),
    lastOutcome: row.last_outcome,
    lastJobId: row.last_job_id,
    lastError: row.last_error,
    lastJob:
      row.job_id && row.job_status
        ? {
            id: row.job_id,
            status: row.job_status,
            error: row.job_error,
            finishedAt: row.job_finished_at,
          }
        : null,
  };
}

/** `audit_log.meta` comes back as text from this driver; a non-object is reported as `{}`. */
function parseAuditMeta(value: unknown): Record<string, unknown> {
  const parsed = (() => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  })();
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
