import { createHash, randomUUID } from "node:crypto";
import type { JobType, PhotoStatus, Role } from "@rephoto/contracts";
import { JOB_MAX_ATTEMPTS } from "@rephoto/contracts";
import { isUniqueViolation, type Sql } from "./sql.js";
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
  }

  async findEventBySlug(slug: string): Promise<EventRow | null> {
    const rows = await this.sql<EventSql[]>`
      select id, slug, name, retention_days, created_at from events where slug = ${slug}
    `;
    return rows[0] ? mapEvent(rows[0]) : null;
  }

  async findEventById(id: string): Promise<EventRow | null> {
    const rows = await this.sql<EventSql[]>`
      select id, slug, name, retention_days, created_at from events where id = ${id}
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

  async insertMagicLink(input: {
    email: string;
    role: Role;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.sql`
      insert into magic_links (email, role, token_hash, expires_at)
      values (${input.email}, ${input.role}, ${input.tokenHash}, ${input.expiresAt})
    `;
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

  async countRecentMatchJobs(userId: string, since: Date): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from jobs
      where type = 'match' and payload->>'userId' = ${userId} and created_at >= ${since}
    `;
    return rows[0]?.count ?? 0;
  }

  async findPhotoBySha(eventId: string, sha256: string): Promise<PhotoRow | null> {
    const rows = await this.sql<PhotoSql[]>`
      select id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at
      from photos where event_id = ${eventId} and sha256 = ${sha256}
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
  }): Promise<void> {
    await this.sql`
      insert into upload_sessions (
        id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status
      ) values (
        ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.s3UploadId},
        ${input.objectKey}, ${input.sha256}, ${input.contentType}, 'open'
      )
    `;
  }

  async findUploadSession(id: string): Promise<UploadSessionRow | null> {
    const rows = await this.sql<UploadSql[]>`
      select id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status, created_at
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
      select id, event_id, photographer_id, s3_upload_id, object_key, sha256, content_type, status, created_at
      from upload_sessions
      where photographer_id = ${photographerId} and event_id = ${eventId}
      order by created_at desc
    `;
    return rows.map(mapUpload);
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
    try {
      const rows = await this.sql<PhotoSql[]>`
        insert into photos (id, event_id, photographer_id, sha256, status, original_key, content_type, bytes)
        values (
          ${input.id}, ${input.eventId}, ${input.photographerId}, ${input.sha256},
          'uploaded', ${input.originalKey}, ${input.contentType}, ${input.bytes}
        )
        returning id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at
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
      select id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at
      from photos where id = ${id}
    `;
    return rows[0] ? mapPhoto(rows[0]) : null;
  }

  async listPhotosByPhotographer(photographerId: string): Promise<PhotoRow[]> {
    const rows = await this.sql<PhotoSql[]>`
      select id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at
      from photos where photographer_id = ${photographerId}
    `;
    return rows.map(mapPhoto);
  }

  async setPhotoStatus(id: string, status: PhotoStatus): Promise<void> {
    await this.sql`update photos set status = ${status} where id = ${id}`;
  }

  async listPhotosCreatedBefore(eventId: string, cutoff: Date): Promise<PhotoRow[]> {
    const rows = await this.sql<PhotoSql[]>`
      select id, event_id, photographer_id, sha256, status, original_key, content_type, bytes, created_at
      from photos where event_id = ${eventId} and created_at < ${cutoff}
    `;
    return rows.map(mapPhoto);
  }

  async upsertDerivative(photoId: string, kind: "thumb" | "web", s3Key: string): Promise<void> {
    await this.sql`
      insert into derivatives (photo_id, kind, s3_key)
      values (${photoId}, ${kind}, ${s3Key})
      on conflict (photo_id, kind) do update set s3_key = excluded.s3_key
    `;
  }

  async derivativeKey(photoId: string, kind: "thumb" | "web"): Promise<string | null> {
    const rows = await this.sql<{ s3_key: string }[]>`
      select s3_key from derivatives where photo_id = ${photoId} and kind = ${kind}
    `;
    return rows[0]?.s3_key ?? null;
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

  async listExternalFaceIds(photoId: string): Promise<string[]> {
    const rows = await this.sql<{ external_id: string }[]>`
      select external_id from faces where photo_id = ${photoId}
    `;
    return rows.map((row) => row.external_id);
  }

  async findFaceId(photoId: string, externalId: string): Promise<string | null> {
    const rows = await this.sql<{ id: string }[]>`
      select id from faces where photo_id = ${photoId} and external_id = ${externalId}
    `;
    return rows[0]?.id ?? null;
  }

  async replaceGallery(
    userId: string,
    eventId: string,
    items: Array<{ photoId: string; faceId: string; score: number }>,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into galleries (user_id, event_id)
        values (${userId}, ${eventId})
        on conflict (user_id, event_id) do update set user_id = excluded.user_id
        returning id
      `;
      const galleryId = rows[0]?.id;
      if (!galleryId) throw new Error("Gallery upsert failed");
      await tx`delete from gallery_items where gallery_id = ${galleryId}`;
      for (const item of items) {
        await tx`
          insert into gallery_items (gallery_id, photo_id, face_id, score)
          values (${galleryId}, ${item.photoId}, ${item.faceId}, ${item.score})
        `;
      }
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

  async latestMatchStatus(userId: string, eventId: string): Promise<"empty" | "queued" | "ready"> {
    const rows = await this.sql<{ status: string }[]>`
      select status from jobs
      where type = 'match'
        and payload->>'userId' = ${userId}
        and payload->>'eventId' = ${eventId}
      order by created_at desc
    `;
    if (rows.some((row) => row.status === "queued" || row.status === "running")) return "queued";
    if (rows.length > 0) return "ready";
    const items = await this.listGallery(userId, eventId);
    return items.length > 0 ? "ready" : "empty";
  }

  async deletePhotoRecords(photoId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from gallery_items where photo_id = ${photoId}`;
      await tx`delete from faces where photo_id = ${photoId}`;
      await tx`delete from face_index where photo_id = ${photoId}`;
      await tx`delete from photos where id = ${photoId}`;
    });
  }

  async deleteParticipant(userId: string): Promise<void> {
    const user = await this.findUserById(userId);
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

  async insertAudit(input: {
    actorId: string | null;
    action: string;
    target: string;
    meta: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      insert into audit_log (actor_id, action, target, meta)
      values (${input.actorId}, ${input.action}, ${input.target}, ${this.sql.json(input.meta)})
    `;
  }

  async metrics(): Promise<{
    events: number;
    photos: number;
    faces: number;
    users: number;
    jobsQueued: number;
  }> {
    const rows = await this.sql<{
      events: number;
      photos: number;
      faces: number;
      users: number;
      jobs_queued: number;
    }[]>`
      select
        (select count(*)::int from events) as events,
        (select count(*)::int from photos) as photos,
        (select count(*)::int from faces) as faces,
        (select count(*)::int from users) as users,
        (select count(*)::int from jobs where status = 'queued') as jobs_queued
    `;
    const row = rows[0];
    return {
      events: row?.events ?? 0,
      photos: row?.photos ?? 0,
      faces: row?.faces ?? 0,
      users: row?.users ?? 0,
      jobsQueued: row?.jobs_queued ?? 0,
    };
  }

  async enqueueJob(type: JobType, payload: unknown): Promise<void> {
    await this.sql`
      insert into jobs (type, payload)
      values (${type}, ${this.sql.json(payload as Parameters<Sql["json"]>[0])})
    `;
  }

  async claimJob(): Promise<ClaimedJob | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{
        id: string;
        type: JobType;
        payload: unknown;
        attempts: number;
      }[]>`
        update jobs
        set status = 'running'
        where id = (
          select id from jobs
          where status = 'queued' and run_after <= now()
          order by created_at
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
    await this.sql`update jobs set status = 'done' where id = ${id}`;
  }

  async failJob(id: string, attempts: number, error: string): Promise<"queued" | "error"> {
    const next = attempts + 1;
    if (next >= JOB_MAX_ATTEMPTS) {
      await this.sql`
        update jobs set status = 'error', attempts = ${next}, last_error = ${error} where id = ${id}
      `;
      return "error";
    }
    const delaySeconds = next * 30;
    await this.sql`
      update jobs
      set status = 'queued',
          attempts = ${next},
          last_error = ${error},
          run_after = now() + (${delaySeconds} * interval '1 second')
      where id = ${id}
    `;
    return "queued";
  }
}

type UserSql = { id: string; email: string; role: Role; created_at: Date };
type EventSql = { id: string; slug: string; name: string; retention_days: number; created_at: Date };
type PhotoSql = {
  id: string;
  event_id: string;
  photographer_id: string;
  sha256: string;
  status: PhotoStatus;
  original_key: string;
  content_type: string;
  bytes: string | number;
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
  created_at: Date;
};

function mapUser(row: UserSql): UserRow {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at };
}
function mapEvent(row: EventSql): EventRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    retentionDays: row.retention_days,
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
    createdAt: row.created_at,
  };
}
