import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  consentBodySchema,
  galleryDownloadBodySchema,
  invitePhotographerBodySchema,
  MULTIPART_THRESHOLD_BYTES,
  objectKeys,
  requestLinkBodySchema,
  retentionBodySchema,
  SELFIE_FIELD_NAME,
  SELFIE_RATE_LIMIT,
  SESSION_COOKIE_NAME,
  uploadCompleteBodySchema,
  uploadInitBodySchema,
  uploadPartBodySchema,
  verifyBodySchema,
  type Role,
} from "@rephoto/contracts";
import { DuplicateKeyError } from "@rephoto/db";
import { newToken, sha256Hex } from "./crypto.js";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { readJson, requireRole, requireUser, since, webOrigin } from "./http.js";
import { purgePhoto } from "./purge.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAGIC_LINK_TTL_SECONDS = 20 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SELFIE_MAX_BYTES = 8_388_608;

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.post("/v1/auth/request-link", async (c) => {
    const body = requestLinkBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const email = body.data.email.toLowerCase();
    const role = body.data.role;
    const allowed =
      role === "participant" ||
      (await deps.db.findUserByEmailRole(email, role)) !== null;
    if (allowed) {
      await issueMagicLink(deps, email, role);
    }
    return c.json({ status: "sent" }, 202);
  });

  app.post("/v1/auth/verify", async (c) => {
    const body = verifyBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const consumed = await deps.db.consumeMagicLink(sha256Hex(body.data.token));
    if (!consumed) throw new ApiError(400, MESSAGES.linkInvalid);
    let user = await deps.db.findUserByEmailRole(consumed.email, consumed.role);
    if (!user) {
      if (consumed.role !== "participant") {
        throw new ApiError(400, MESSAGES.linkInvalid);
      }
      user = await deps.db.insertUser(consumed.email, "participant");
    }
    const token = newToken();
    await deps.db.insertSession({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    });
    setSessionCookie(c, deps, token);
    return c.json({ user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) await deps.db.deleteSession(sha256Hex(token));
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
      secure: deps.env.WEB_ORIGIN.startsWith("https:"),
    });
    return c.body(null, 204);
  });

  app.get("/v1/events/:slug", async (c) => {
    const event = await loadEvent(deps, c.req.param("slug"));
    return c.json({
      id: event.id,
      slug: event.slug,
      name: event.name,
      retentionDays: event.retentionDays,
    });
  });

  app.post("/v1/events/:slug/consent", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const body = consentBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const consent = await deps.db.insertConsent({
      userId: user.id,
      eventId: event.id,
      textVersion: body.data.textVersion,
      ip: c.get("ip"),
      userAgent: c.req.header("user-agent") ?? "",
    });
    return c.json(
      { id: consent.id, grantedAt: consent.grantedAt.toISOString() },
      201,
    );
  });

  app.post("/v1/events/:slug/selfie", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    if (!(await deps.db.hasActiveConsent(user.id, event.id))) {
      throw new ApiError(403, MESSAGES.consentRequired);
    }
    const recent = await deps.db.countMatchJobsSince(
      user.id,
      since(SELFIE_RATE_LIMIT.windowSeconds),
    );
    if (recent >= SELFIE_RATE_LIMIT.max) {
      throw new ApiError(429, MESSAGES.rateLimited);
    }
    const image = await readSelfie(c);
    const key = objectKeys.selfie(event.id, user.id, randomUUID());
    await deps.objects.put(key, image.bytes, image.contentType);
    await deps.queue.enqueue("match", {
      userId: user.id,
      eventId: event.id,
      selfieKey: key,
    });
    return c.json({ status: "queued" }, 202);
  });

  app.get("/v1/events/:slug/gallery", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const latest = await deps.db.latestMatchJob(user.id, event.id);
    const rows = (await deps.db.listGallery(user.id, event.id)).sort(
      (a, b) => b.score - a.score || a.photoId.localeCompare(b.photoId),
    );
    const status = galleryStatus(latest?.status ?? null, rows.length);
    const items = [];
    for (const row of rows) {
      const derivatives = await deps.db.listDerivatives(row.photoId);
      const thumb = derivatives.find((item) => item.kind === "thumb")?.s3Key;
      const web = derivatives.find((item) => item.kind === "web")?.s3Key;
      if (!thumb || !web) throw new ApiError(404, MESSAGES.notFound);
      items.push({
        photoId: row.photoId,
        thumbUrl: await deps.objects.presignGet(thumb),
        webUrl: await deps.objects.presignGet(web),
        score: row.score,
      });
    }
    return c.json({ status, items });
  });

  app.post("/v1/events/:slug/gallery/download", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const body = galleryDownloadBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const owned = new Set(
      (await deps.db.listGallery(user.id, event.id)).map((item) => item.photoId),
    );
    const urls = [];
    for (const photoId of body.data.photoIds) {
      if (!owned.has(photoId)) throw new ApiError(403, MESSAGES.forbidden);
      const photo = await deps.db.findPhoto(photoId);
      if (!photo || photo.eventId !== event.id) {
        throw new ApiError(403, MESSAGES.forbidden);
      }
      urls.push({
        photoId,
        url: await deps.objects.presignGet(photo.originalKey),
      });
    }
    return c.json({ urls });
  });

  app.post("/v1/uploads/init", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const body = uploadInitBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const existing = await deps.db.findPhotoBySha(event.id, body.data.sha256);
    if (existing) throw new ApiError(409, MESSAGES.conflict);
    const photoId = randomUUID();
    const objectKey = objectKeys.original(event.id, photoId);
    const multipart = body.data.bytes > MULTIPART_THRESHOLD_BYTES;
    const uploadId = randomUUID();
    const s3UploadId = multipart
      ? await deps.objects.createMultipartUpload(objectKey, body.data.contentType)
      : null;
    await deps.db.insertUploadSession({
      id: uploadId,
      eventId: event.id,
      photographerId: user.id,
      s3UploadId,
      objectKey,
      sha256: body.data.sha256,
      contentType: body.data.contentType,
    });
    if (multipart) {
      return c.json(
        {
          id: uploadId,
          objectKey,
          mode: "multipart" as const,
          partSize: MULTIPART_THRESHOLD_BYTES,
        },
        201,
      );
    }
    return c.json(
      {
        id: uploadId,
        objectKey,
        mode: "single" as const,
        url: await deps.objects.presignPut(objectKey, body.data.contentType),
      },
      201,
    );
  });

  app.post("/v1/uploads/:id/parts", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const session = await ownUpload(deps, c.req.param("id"), user.id);
    if (!session.s3UploadId) throw new ApiError(400, MESSAGES.validation);
    const body = uploadPartBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const url = await deps.objects.presignUploadPart(
      session.objectKey,
      session.s3UploadId,
      body.data.partNumber,
    );
    return c.json({ url, partNumber: body.data.partNumber });
  });

  app.post("/v1/uploads/:id/complete", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const session = await ownUpload(deps, c.req.param("id"), user.id);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    const body = uploadCompleteBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    if (session.s3UploadId) {
      if (body.data.parts.length === 0) throw new ApiError(400, MESSAGES.validation);
      await deps.objects.completeMultipartUpload(
        session.objectKey,
        session.s3UploadId,
        body.data.parts,
      );
    } else if (body.data.parts.length !== 0) {
      throw new ApiError(400, MESSAGES.validation);
    }
    const stored = await deps.objects.head(session.objectKey);
    if (!stored || stored.bytes <= 0) throw new ApiError(400, MESSAGES.validation);
    const photoId = photoIdFromKey(session.eventId, session.objectKey);
    try {
      await deps.db.insertPhoto({
        id: photoId,
        eventId: session.eventId,
        photographerId: user.id,
        sha256: session.sha256,
        originalKey: session.objectKey,
        contentType: session.contentType,
        bytes: stored.bytes,
      });
    } catch (error) {
      if (error instanceof DuplicateKeyError) {
        await deps.db.markUploadSession(session.id, "aborted");
        throw new ApiError(409, MESSAGES.conflict);
      }
      throw error;
    }
    await deps.queue.enqueue("derive", { photoId });
    await deps.db.markUploadSession(session.id, "completed");
    return c.json({ photoId, status: "uploaded" as const }, 201);
  });

  app.get("/v1/uploads", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const eventId = c.req.query("eventId") ?? "";
    if (!UUID.test(eventId)) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const uploads = await deps.db.listUploadSessions(user.id, event.id);
    return c.json({
      uploads: uploads.map((session) => ({
        id: session.id,
        objectKey: session.objectKey,
        sha256: session.sha256,
        contentType: session.contentType,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
      })),
    });
  });

  app.get("/v1/admin/metrics", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["admin"]);
    return c.json(await deps.db.metrics());
  });

  app.post("/v1/admin/photographers/invite", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const body = invitePhotographerBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const inviteId = await deps.db.insertInvite({
      email: body.data.email.toLowerCase(),
      eventId: event.id,
      tokenHash: sha256Hex(newToken()),
      role: "photographer",
      expiresAt: new Date(Date.now() + INVITE_TTL_SECONDS * 1000),
    });
    return c.json({ inviteId }, 201);
  });

  app.delete("/v1/admin/photos/:id", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const photoId = parseUuid(c.req.param("id"));
    const photo = await deps.db.findPhoto(photoId);
    if (!photo) throw new ApiError(404, MESSAGES.notFound);
    await purgePhoto(deps, photo.id);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "photo.deleted",
      target: `photo:${photo.id}`,
      meta: { eventId: photo.eventId },
    });
    return c.body(null, 204);
  });

  app.delete("/v1/admin/participants/:id", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const userId = parseUuid(c.req.param("id"));
    const deleted = await deps.db.deleteParticipant(userId);
    if (!deleted) throw new ApiError(404, MESSAGES.notFound);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "participant.deleted",
      target: `user:${userId}`,
      meta: {},
    });
    return c.body(null, 204);
  });

  app.post("/v1/admin/retention/run", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const body = retentionBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const jobId = await deps.queue.enqueue("retention", {
      eventId: event.id,
      actorId: actor.id,
    });
    return c.json({ jobId }, 202);
  });
}

function parseUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiError(400, MESSAGES.validation);
  return value;
}

async function loadEvent(deps: AppDeps, slug: string) {
  const event = await deps.db.findEventBySlug(slug);
  if (!event) throw new ApiError(404, MESSAGES.notFound);
  return event;
}

async function ownUpload(deps: AppDeps, id: string, photographerId: string) {
  const session = await deps.db.findUploadSession(parseUuid(id));
  if (!session || session.photographerId !== photographerId) {
    throw new ApiError(404, MESSAGES.notFound);
  }
  return session;
}

function photoIdFromKey(eventId: string, objectKey: string): string {
  const prefix = `originals/${eventId}/`;
  if (!objectKey.startsWith(prefix)) throw new ApiError(400, MESSAGES.validation);
  return parseUuid(objectKey.slice(prefix.length));
}

function galleryStatus(
  job: "queued" | "running" | "done" | "error" | null,
  itemCount: number,
): "empty" | "queued" | "ready" {
  if (job === "queued" || job === "running") return "queued";
  if (job === "done" || job === "error") return "ready";
  return itemCount === 0 ? "empty" : "ready";
}

async function issueMagicLink(deps: AppDeps, email: string, role: Role): Promise<void> {
  const token = newToken();
  await deps.db.insertMagicLink({
    email,
    role,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000),
  });
  await deps.mailer.send({
    to: email,
    subject: "Accedi a RePhoto",
    text: `${webOrigin(deps.env)}/verifica?token=${encodeURIComponent(token)}`,
  });
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  deps: AppDeps,
  token: string,
): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: deps.env.WEB_ORIGIN.startsWith("https:"),
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function readSelfie(
  c: Parameters<typeof getCookie>[0],
): Promise<{ bytes: Uint8Array; contentType: "image/jpeg" | "image/png" }> {
  const body = await c.req.parseBody();
  const image = body[SELFIE_FIELD_NAME];
  if (!(image instanceof File)) throw new ApiError(400, MESSAGES.validation);
  const contentType = image.type.split(";")[0]?.trim();
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new ApiError(400, MESSAGES.validation);
  }
  if (image.size <= 0 || image.size > SELFIE_MAX_BYTES) {
    throw new ApiError(400, MESSAGES.validation);
  }
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > SELFIE_MAX_BYTES) {
    throw new ApiError(400, MESSAGES.validation);
  }
  return { bytes, contentType };
}
