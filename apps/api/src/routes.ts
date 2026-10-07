import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import {
  jobDedupeKey,
  acceptInviteBodySchema,
  consentBodySchema,
  decodeGalleryCursor,
  encodeGalleryCursor,
  eventPatchBodySchema,
  galleryDownloadBodySchema,
  galleryQuerySchema,
  galleryZipBodySchema,
  invitePhotographerBodySchema,
  MAGIC_LINK_RATE_LIMIT,
  MULTIPART_THRESHOLD_BYTES,
  objectKeys,
  participantsImportBodySchema,
  requestLinkBodySchema,
  retentionBodySchema,
  SELFIE_FIELD_NAME,
  SELFIE_LIVENESS_FIELD,
  SELFIE_RATE_LIMIT,
  selfieLivenessSchema,
  SESSION_COOKIE_NAME,
  uploadCompleteBodySchema,
  uploadInitBodySchema,
  uploadListQuerySchema,
  uploadLookupQuerySchema,
  uploadPartBodySchema,
  uploadSummaryQuerySchema,
  verifyBodySchema,
  type DownloadVariant,
  type Role,
  type SelfieLiveness,
} from "@rephoto/contracts";
import { DuplicateKeyError, type EventRow, type PhotoRow, type UserRow } from "@rephoto/db";
import { newToken, sha256Hex } from "./crypto.js";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import {
  decodeCursor,
  encodeCursor,
  readJson,
  requireRole,
  requireUser,
  since,
  webOrigin,
} from "./http.js";
import { purgePhoto } from "./purge.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAGIC_LINK_TTL_SECONDS = 20 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SELFIE_MAX_BYTES = 8_388_608;
const HEALTH_TIMEOUT_MS = 2_000;

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const health = async (c: Context<AppEnv>) => {
    if (await databaseHealthy(deps)) return c.json({ ok: true });
    return c.json({ ok: false }, 503);
  };
  app.get("/health", health);
  app.get("/v1/health", health);

  app.post("/v1/auth/request-link", async (c) => {
    const body = requestLinkBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const email = body.data.email.toLowerCase();
    const role = body.data.role;
    const ip = c.get("ip");
    const windowStart = since(MAGIC_LINK_RATE_LIMIT.windowSeconds);
    const byEmail = await deps.db.countMagicLinksSince({ email, since: windowStart });
    if (byEmail >= MAGIC_LINK_RATE_LIMIT.perEmail) {
      throw new ApiError(429, MESSAGES.rateLimited);
    }
    const byIp = await deps.db.countMagicLinksSince({ ip, since: windowStart });
    if (byIp >= MAGIC_LINK_RATE_LIMIT.perIp) {
      throw new ApiError(429, MESSAGES.rateLimited);
    }
    const allowed =
      role === "participant" ||
      (await deps.db.findUserByEmailRole(email, role)) !== null;
    if (allowed) {
      await issueMagicLink(deps, email, role, ip);
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
    await startSession(c, deps, user);
    return c.json({ user: publicUser(user) });
  });

  app.post("/v1/auth/accept-invite", async (c) => {
    const body = acceptInviteBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const invite = await deps.db.consumeInvite(sha256Hex(body.data.token));
    if (!invite) throw new ApiError(400, MESSAGES.linkInvalid);
    const email = invite.email.toLowerCase();
    let user = await deps.db.findUserByEmailRole(email, invite.role);
    if (!user) user = await deps.db.insertUser(email, invite.role);
    if (invite.role === "photographer") {
      await deps.db.addEventPhotographer(invite.eventId, user.id);
    }
    await startSession(c, deps, user);
    return c.json({ user: publicUser(user) });
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
    return c.json(publicEvent(event));
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
    if (
      event.access === "list" &&
      !(await deps.db.isEventParticipant(event.id, user.email.toLowerCase()))
    ) {
      throw new ApiError(403, MESSAGES.notOnList);
    }
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
    // The DPIA cites this: whether the selfie went through the browser liveness challenge.
    // The value is asserted by the client (a deterrent, not proof): the server cannot verify
    // the challenge ran. The server-side check, when enabled, is LIVENESS_CHECK in the worker.
    await deps.db.insertAudit({
      actorId: user.id,
      action: "selfie.submitted",
      target: `event:${event.id}`,
      meta: { liveness: image.liveness },
    });
    return c.json({ status: "queued" }, 202);
  });

  app.get("/v1/events/:slug/gallery", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const query = galleryQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const cursor = query.data.cursor ? decodeGalleryCursor(query.data.cursor) : undefined;
    if (cursor === null) throw new ApiError(400, MESSAGES.validation);
    const limit = query.data.limit;
    const [latest, gallery, page] = await Promise.all([
      deps.db.latestMatchJob(user.id, event.id),
      deps.db.findGalleryByUser(user.id, event.id),
      deps.db.listGalleryPage(user.id, event.id, { limit, ...(cursor ? { cursor } : {}) }),
    ]);
    const status = galleryStatus(latest?.status ?? null, gallery !== null, page.total);
    const items = [];
    for (const row of page.items) {
      items.push({
        photoId: row.photoId,
        thumbUrl: await deps.objects.presignGet(row.thumbKey),
        webUrl: await deps.objects.presignGet(row.webKey),
        score: row.score,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        originalReady: row.originalReady,
      });
    }
    const last = page.items[page.items.length - 1];
    const nextCursor =
      page.items.length === limit && last
        ? encodeGalleryCursor({ score: last.score, photoId: last.photoId })
        : null;
    return c.json({ status, total: page.total, items, nextCursor });
  });

  app.post("/v1/events/:slug/gallery/download", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const body = galleryDownloadBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const photos = await ownedPhotos(deps, user, event, body.data.photoIds);
    const urls = [];
    for (const photo of photos) {
      urls.push({
        photoId: photo.id,
        url: await deps.objects.presignGet(variantKey(photo, body.data.variant)),
      });
    }
    return c.json({ urls });
  });

  app.post("/v1/events/:slug/gallery/zip", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    if (!isTrustedFormOrigin(c, deps)) throw new ApiError(403, MESSAGES.forbidden);
    const event = await loadEvent(deps, c.req.param("slug"));
    const request = await readZipRequest(c);
    const photos = await ownedPhotos(deps, user, event, request.photoIds);
    const entries = photos.map((photo, index) => ({
      key: variantKey(photo, request.variant),
      name: zipEntryName(event.slug, index + 1, photo, request.variant),
    }));

    const archive = new ZipArchive({ zlib: { level: 0 }, store: true });
    archive.on("warning", (warning) => {
      console.error(`zip warning: ${String(warning.message).slice(0, 200)}`);
    });
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      archive.abort();
    };
    const feed = (async () => {
      let missing = 0;
      for (const entry of entries) {
        if (aborted) return;
        const object = await deps.objects.stream(entry.key);
        if (!object) {
          missing += 1;
          continue;
        }
        if (aborted) {
          // The client went away while the object was being fetched: release its connection.
          object.body.destroy();
          return;
        }
        await appendEntry(archive, object.body, entry.name);
      }
      if (missing > 0) {
        console.error(`zip for event ${event.id}: ${missing} missing object(s) skipped`);
      }
      await archive.finalize();
    })();
    feed.catch(abort);

    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename="rephoto-${safeFilenamePart(event.slug)}.zip"`,
    );
    c.header("Cache-Control", "no-store");
    return stream(
      c,
      async (body) => {
        body.onAbort(abort);
        await Promise.all([body.pipe(Readable.toWeb(archive) as ReadableStream), feed]);
      },
      async (error) => {
        abort();
        console.error(`zip stream failed: ${error.message.slice(0, 300)}`);
      },
    );
  });

  app.post("/v1/uploads/init", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const body = uploadInitBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    if (!(await deps.db.isEventPhotographer(event.id, user.id))) {
      throw new ApiError(403, MESSAGES.forbidden);
    }
    const input = body.data;
    const uploadId = randomUUID();
    if (input.stage === "web") {
      // Web stage: the 1600 px JPEG goes straight to the web derivative key; the photo row
      // is created at complete with the original's sha256/bytes and original_status = pending.
      const existing = await deps.db.findPhotoBySha(event.id, input.sha256);
      if (existing) throw new ApiError(409, MESSAGES.conflict);
      const photoId = randomUUID();
      const objectKey = objectKeys.web(photoId);
      await deps.db.insertUploadSession({
        id: uploadId,
        eventId: event.id,
        photographerId: user.id,
        s3UploadId: null,
        objectKey,
        sha256: input.sha256,
        contentType: input.contentType,
        bytes: input.bytes,
        stage: "web",
        originalContentType: input.originalContentType,
        originalBytes: input.originalBytes,
      });
      return c.json(
        {
          id: uploadId,
          objectKey,
          mode: "single" as const,
          url: await deps.objects.presignPut(objectKey, input.contentType, input.bytes),
        },
        201,
      );
    }
    let objectKey: string;
    let photoId: string | null = null;
    if (input.photoId) {
      // Original stage of a web-first photo: the row exists and still waits for its bytes.
      const photo = await deps.db.findPhoto(input.photoId);
      if (!photo || photo.photographerId !== user.id || photo.eventId !== event.id) {
        throw new ApiError(404, MESSAGES.notFound);
      }
      // An original that already arrived is a conflict, not a validation error: the client treats it as sent.
      if (photo.originalStatus !== "pending") throw new ApiError(409, MESSAGES.conflict);
      if (photo.sha256 !== input.sha256 || photo.bytes !== input.bytes) {
        throw new ApiError(400, MESSAGES.validation);
      }
      objectKey = photo.originalKey;
      photoId = photo.id;
    } else {
      const existing = await deps.db.findPhotoBySha(event.id, input.sha256);
      if (existing) throw new ApiError(409, MESSAGES.conflict);
      objectKey = objectKeys.original(event.id, randomUUID());
    }
    const multipart = input.bytes > MULTIPART_THRESHOLD_BYTES;
    const s3UploadId = multipart
      ? await deps.objects.createMultipartUpload(objectKey, input.contentType)
      : null;
    await deps.db.insertUploadSession({
      id: uploadId,
      eventId: event.id,
      photographerId: user.id,
      s3UploadId,
      objectKey,
      sha256: input.sha256,
      contentType: input.contentType,
      bytes: input.bytes,
      stage: "original",
      photoId,
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
        url: await deps.objects.presignPut(objectKey, input.contentType, input.bytes),
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
    const discard = async (status: 400 | 404, message: string): Promise<never> => {
      await deps.db.markUploadSession(session.id, "aborted");
      await deps.objects.delete(session.objectKey);
      throw new ApiError(status, message);
    };
    if (session.stage === "original" && session.photoId) {
      // Original of a web-first photo: no re-derive or re-index, only a deferred sha256 check.
      // The row is read right before the flip so a repeated complete (same session retried,
      // or a second session for the same photo) sees the status the earlier one left.
      const photo = await deps.db.findPhoto(session.photoId);
      if (!photo || photo.photographerId !== user.id) await discard(404, MESSAGES.notFound);
      else if (stored.bytes !== photo.bytes) await discard(400, MESSAGES.sizeMismatch);
      else if (photo.originalStatus !== "pending") {
        // Already received: same answer, no second verify (the object key is the same one).
        await deps.db.markUploadSession(session.id, "completed");
        return c.json({ photoId: photo.id, status: "original_received" as const }, 201);
      } else {
        await deps.db.setOriginalStatus(photo.id, "present");
        await deps.queue.enqueue("verify", { photoId: photo.id }, {
          dedupeKey: jobDedupeKey("verify", { photoId: photo.id }) ?? undefined,
        });
        if (photo.status === "error") {
          // The client-made web object failed to derive (not an image, or lost): now that the
          // original is here, rebuild thumb+web from it and index again.
          await deps.db.setPhotoErrorText(photo.id, null);
          await deps.queue.enqueue("derive", { photoId: photo.id }, {
            dedupeKey: jobDedupeKey("derive", { photoId: photo.id }) ?? undefined,
          });
        }
        await deps.db.markUploadSession(session.id, "completed");
        return c.json({ photoId: photo.id, status: "original_received" as const }, 201);
      }
    }
    if (session.bytes !== null && stored.bytes !== session.bytes) {
      await discard(400, MESSAGES.sizeMismatch);
    }
    const web = session.stage === "web";
    if (web && (session.originalContentType === null || session.originalBytes === null)) {
      await discard(400, MESSAGES.validation);
    }
    const photoId = web
      ? photoIdFromWebKey(session.objectKey)
      : photoIdFromKey(session.eventId, session.objectKey);
    try {
      await deps.db.insertPhoto({
        id: photoId,
        eventId: session.eventId,
        photographerId: user.id,
        sha256: session.sha256,
        originalKey: web ? objectKeys.original(session.eventId, photoId) : session.objectKey,
        contentType: web ? session.originalContentType ?? session.contentType : session.contentType,
        bytes: web ? session.originalBytes ?? stored.bytes : stored.bytes,
        originalStatus: web ? "pending" : "present",
      });
    } catch (error) {
      if (!(error instanceof DuplicateKeyError)) throw error;
      if (await deps.db.findPhoto(photoId)) {
        // A concurrent completion of this same session already inserted the photo.
        await deps.db.markUploadSession(session.id, "completed");
        return c.json({ photoId, status: "uploaded" as const }, 201);
      }
      // Same bytes completed first under another session: this object will never be referenced.
      await deps.db.markUploadSession(session.id, "aborted");
      await deps.objects.delete(session.objectKey);
      throw new ApiError(409, MESSAGES.conflict);
    }
    if (web) {
      await deps.db.upsertDerivative({ photoId, kind: "web", s3Key: session.objectKey });
    }
    await deps.queue.enqueue("derive", { photoId }, {
      dedupeKey: jobDedupeKey("derive", { photoId }) ?? undefined,
    });
    await deps.db.markUploadSession(session.id, "completed");
    return c.json({ photoId, status: "uploaded" as const }, 201);
  });

  app.get("/v1/uploads", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const query = uploadListQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(query.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const cursor = query.data.cursor ? decodeUploadCursor(query.data.cursor) : undefined;
    if (cursor === null) throw new ApiError(400, MESSAGES.validation);
    const page = await deps.db.listUploadSessionsPage(user.id, event.id, {
      limit: query.data.limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      uploads: page.items.map((session) => ({
        id: session.id,
        objectKey: session.objectKey,
        sha256: session.sha256,
        contentType: session.contentType,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor
        ? encodeCursor([page.nextCursor.createdAt.toISOString(), page.nextCursor.id])
        : null,
    });
  });

  app.get("/v1/uploads/lookup", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const query = uploadLookupQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const photo = await deps.db.findOwnPhotoBySha(user.id, query.data.eventId, query.data.sha256);
    if (!photo) throw new ApiError(404, MESSAGES.notFound);
    return c.json({ photoId: photo.id, originalStatus: photo.originalStatus, status: photo.status });
  });

  app.get("/v1/uploads/summary", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const query = uploadSummaryQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(query.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    return c.json(await deps.db.uploadSummary(user.id, event.id));
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
    const email = body.data.email.toLowerCase();
    const token = newToken();
    const inviteId = await deps.db.insertInvite({
      email,
      eventId: event.id,
      tokenHash: sha256Hex(token),
      role: "photographer",
      expiresAt: new Date(Date.now() + INVITE_TTL_SECONDS * 1000),
    });
    const existing = await deps.db.findUserByEmailRole(email, "photographer");
    if (existing) await deps.db.addEventPhotographer(event.id, existing.id);
    await deps.mailer.send({
      to: email,
      subject: `Invito a caricare foto: ${event.name}`,
      text: `${webOrigin(deps.env)}/invito?token=${encodeURIComponent(token)}`,
    });
    return c.json({ inviteId }, 201);
  });

  app.post("/v1/admin/participants/import", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const body = participantsImportBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    const inserted = await deps.db.upsertEventParticipants(event.id, body.data.emails);
    return c.json({ inserted });
  });

  app.patch("/v1/admin/events/:id", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const eventId = parseUuid(c.req.param("id"));
    const body = eventPatchBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const event = await deps.db.updateEvent(eventId, body.data);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    return c.json(publicEvent(event));
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
    const payload = { eventId: event.id, actorId: actor.id };
    const jobId = await deps.queue.enqueue("retention", payload, {
      dedupeKey: jobDedupeKey("retention", payload) ?? undefined,
    });
    return c.json({ jobId }, 202);
  });
}

function parseUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiError(400, MESSAGES.validation);
  return value;
}

function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, role: user.role };
}

function publicEvent(event: EventRow) {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    retentionDays: event.retentionDays,
    access: event.access,
  };
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

/** The requested photos, in request order, all owned by the caller's gallery; else 403. */
/**
 * CSRF guard for the form-posted ZIP. Browsers send `Origin: null` on a
 * navigation POST when the page's referrer policy hides the referrer, so a
 * null origin is accepted only when the browser also marks the request
 * same-origin via Sec-Fetch-Site.
 */
function isTrustedFormOrigin(c: Context<AppEnv>, deps: AppDeps): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined || origin === webOrigin(deps.env)) return true;
  return origin === "null" && c.req.header("sec-fetch-site") === "same-origin";
}

async function ownedPhotos(
  deps: AppDeps,
  user: UserRow,
  event: EventRow,
  photoIds: string[],
): Promise<PhotoRow[]> {
  const wanted = [...new Set(photoIds)];
  const rows = await deps.db.listOwnedPhotos(user.id, event.id, wanted);
  const byId = new Map(rows.map((photo) => [photo.id, photo]));
  const photos: PhotoRow[] = [];
  for (const id of wanted) {
    const photo = byId.get(id);
    if (!photo || photo.eventId !== event.id) throw new ApiError(403, MESSAGES.forbidden);
    photos.push(photo);
  }
  return photos;
}

/** The original falls back to the web derivative while the original bytes are still pending. */
function variantKey(photo: PhotoRow, variant: DownloadVariant): string {
  if (variant === "web" || photo.originalStatus === "pending") return objectKeys.web(photo.id);
  return photo.originalKey;
}

/** The extension follows the object actually served (see `variantKey`). */
function zipEntryName(
  slug: string,
  index: number,
  photo: PhotoRow,
  variant: DownloadVariant,
): string {
  const original = variant === "original" && photo.originalStatus === "present";
  const extension = original && photo.contentType === "image/png" ? "png" : "jpg";
  return `${safeFilenamePart(slug)}-${String(index).padStart(4, "0")}.${extension}`;
}

function safeFilenamePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "foto";
}

async function readZipRequest(
  c: Context<AppEnv>,
): Promise<{ photoIds: string[]; variant: DownloadVariant }> {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  let candidate: unknown;
  if (contentType === "application/json") {
    candidate = await readJson(c);
  } else if (
    contentType === "application/x-www-form-urlencoded" ||
    contentType === "multipart/form-data"
  ) {
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new ApiError(400, MESSAGES.validation);
    }
    const ids = typeof form.ids === "string" ? form.ids : "";
    candidate = {
      photoIds: ids
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
      ...(typeof form.variant === "string" && form.variant.length > 0
        ? { variant: form.variant }
        : {}),
    };
  } else {
    throw new ApiError(400, MESSAGES.validation);
  }
  const body = galleryZipBodySchema.safeParse(candidate);
  if (!body.success) throw new ApiError(400, MESSAGES.validation);
  return body.data;
}

/** Appends one entry and resolves once archiver has finished consuming it. */
function appendEntry(archive: ZipArchive, source: Readable, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      source.off("error", onError);
    };
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      source.destroy();
      reject(error);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    source.on("error", onError);
    archive.append(source, { name });
  });
}

function photoIdFromKey(eventId: string, objectKey: string): string {
  const prefix = `originals/${eventId}/`;
  if (!objectKey.startsWith(prefix)) throw new ApiError(400, MESSAGES.validation);
  return parseUuid(objectKey.slice(prefix.length));
}

function photoIdFromWebKey(objectKey: string): string {
  const match = /^web\/([^/]+)\.jpg$/.exec(objectKey);
  if (!match || !match[1]) throw new ApiError(400, MESSAGES.validation);
  return parseUuid(match[1]);
}

function decodeUploadCursor(raw: string): { createdAt: Date; id: string } | null {
  const parts = decodeCursor(raw, 2);
  if (!parts) return null;
  const [createdAtText, id] = parts;
  const createdAt = new Date(createdAtText ?? "");
  if (!id || Number.isNaN(createdAt.getTime()) || !UUID.test(id)) return null;
  return { createdAt, id };
}

function galleryStatus(
  job: "queued" | "running" | "done" | "error" | null,
  hasGallery: boolean,
  total: number,
): "empty" | "queued" | "ready" {
  if (job === "queued" || job === "running") return "queued";
  if (hasGallery) return "ready";
  if (job === "done" || job === "error") return "ready";
  return total === 0 ? "empty" : "ready";
}

async function databaseHealthy(deps: AppDeps): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health timeout")), HEALTH_TIMEOUT_MS);
  });
  try {
    await Promise.race([deps.db.ping(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function issueMagicLink(
  deps: AppDeps,
  email: string,
  role: Role,
  ip: string,
): Promise<void> {
  const token = newToken();
  await deps.db.insertMagicLink({
    email,
    role,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000),
    ip: ip === "unknown" ? null : ip,
  });
  await deps.mailer.send({
    to: email,
    subject: "Accedi a RePhoto",
    text: `${webOrigin(deps.env)}/verifica?token=${encodeURIComponent(token)}`,
  });
}

async function startSession(c: Context<AppEnv>, deps: AppDeps, user: UserRow): Promise<void> {
  const token = newToken();
  await deps.db.insertSession({
    userId: user.id,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: deps.env.WEB_ORIGIN.startsWith("https:"),
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function readSelfie(c: Context<AppEnv>): Promise<{
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
  liveness: SelfieLiveness;
}> {
  const body = await c.req.parseBody();
  const image = body[SELFIE_FIELD_NAME];
  if (!(image instanceof File)) throw new ApiError(400, MESSAGES.validation);
  // Optional: absent means the plain file picker (v3 clients); anything else must be a known value.
  let liveness: SelfieLiveness = "file";
  const livenessField = body[SELFIE_LIVENESS_FIELD];
  if (livenessField !== undefined) {
    const parsed = selfieLivenessSchema.safeParse(livenessField);
    if (!parsed.success) throw new ApiError(400, MESSAGES.validation);
    liveness = parsed.data;
  }
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
  return { bytes, contentType, liveness };
}
