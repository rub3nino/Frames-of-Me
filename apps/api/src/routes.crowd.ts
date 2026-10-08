/**
 * v6 section C (agent C): crowd upload, reports and moderation.
 *
 * A separate file on purpose: `routes.ts` is edited by five agents at once in this wave, so
 * everything new lives here and `registerRoutes` adds a single call to
 * {@link registerCrowdRoutes}.
 *
 * What this file is, in one paragraph. A participant uploads into a `crowd` album through the
 * same resumable `upload_sessions` machinery the photographer routes use; four clauses decide
 * whether they may (C2). Moderation is `post` by default — the photo is `approved` on arrival
 * and visible at once — and `photos.moderation_state` is a column SEPARATE from
 * `photos.status`: the first is this state machine, the second is the processing pipeline, and
 * they are never merged. A screening hook may answer `auto_rejected` before publication. Any
 * participant can report a photo; once REPORT_AUTO_PENDING distinct people have an open report
 * on it the photo flips to `pending` and leaves the album feed until a moderator rules.
 * Rejecting purges the object through the existing `purgePhoto`. And `uploads_open = false` is
 * the event-day kill switch: every upload route here answers 423 while it is off, read per
 * request so flipping it needs no restart.
 *
 * Video is out of scope for v6 (decision 4, frozen): `albumUploadInitBodySchema` accepts only
 * `image/jpeg` / `image/png`, and anything else — `video/mp4` included — is a 400.
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import {
  ALBUM_UPLOAD_RATE_LIMIT,
  albumDownloadBodySchema,
  albumPhotosQuerySchema,
  albumUploadInitBodySchema,
  moderateBodySchema,
  moderationQuerySchema,
  MULTIPART_THRESHOLD_BYTES,
  objectKeys,
  countsTowardModeration,
  reportBodySchema,
  REPORT_RATE_LIMIT,
  uploadCompleteBodySchema,
  uploadPartBodySchema,
  jobDedupeKey,
  type ModerationState,
} from "@rephoto/contracts";
import {
  DuplicateKeyError,
  type AlbumRow,
  type EventRow,
  type PhotoRow,
  type UploadSessionRow,
} from "@rephoto/db";
import type { AppDeps, AppEnv } from "./deps.js";
import { incrementSharedLimit } from "./distributed-rate-limit.js";
import { ApiError, MESSAGES } from "./errors.js";
import { decodeCursor, encodeCursor, readJson, requireRole, requireUser, since } from "./http.js";
import { purgePhoto } from "./purge.js";
import { rateLimitExempt } from "./routes.js";
import { noopScreening } from "./screening.js";

export function registerCrowdRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  // --- C2: participant upload into a crowd album ------------------------------------------

  app.post("/v1/albums/:albumId/uploads/init", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const album = await crowdAlbumForUpload(deps, c.req.param("albumId"), user.id, user.email);
    const body = albumUploadInitBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const input = body.data;

    // The burst gate, ported from main's `PUBLIC_UPLOAD_RATE_LIMIT`. This path had NO rate
    // limit at all: `assertBelowCap` below bounds the total an uploader may hold in the
    // album, which is a different property and does nothing whatever when
    // `max_photos_per_user` is null — the column's default.
    await assertUploadRate(deps, c.get("ip"), album, user.id);

    // Clause 4 of C2: approved + pending in this album, below the album's cap. Checked here
    // and again at complete, because an init is cheap to repeat and the cap must hold on the
    // row count, not on the number of sessions opened.
    await assertBelowCap(deps, album, user.id);

    // Dedup is per album (`photos unique (album_id, sha256)`, migration 009): the same
    // forwarded WhatsApp image in the official album is a different photo, and in THIS album
    // it is an answer rather than an error.
    const existing = await deps.db.findPhotoByAlbumSha(album.id, input.sha256);
    if (existing) {
      return c.json(
        { status: "already-uploaded" as const, photoId: existing.id, albumId: album.id },
        200,
      );
    }

    const uploadId = randomUUID();
    const objectKey = objectKeys.original(album.eventId, randomUUID());
    const multipart = input.bytes > MULTIPART_THRESHOLD_BYTES;
    const s3UploadId = multipart
      ? await deps.objects.createMultipartUpload(objectKey, input.contentType)
      : null;
    await deps.db.insertUploadSession({
      id: uploadId,
      eventId: album.eventId,
      // `photos.photographer_id` means "uploader" since v6 (migration 009's comment): for a
      // crowd album it is the participant.
      photographerId: user.id,
      s3UploadId,
      objectKey,
      sha256: input.sha256,
      contentType: input.contentType,
      bytes: input.bytes,
      stage: "original",
      filename: input.filename,
      albumId: album.id,
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

  app.post("/v1/albums/:albumId/uploads/:id/parts", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const album = await crowdAlbumForUpload(deps, c.req.param("albumId"), user.id, user.email);
    const session = await ownCrowdUpload(deps, c.req.param("id"), user.id, album.id);
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

  app.post("/v1/albums/:albumId/uploads/:id/complete", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const album = await crowdAlbumForUpload(deps, c.req.param("albumId"), user.id, user.email);
    const session = await ownCrowdUpload(deps, c.req.param("id"), user.id, album.id);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    const parsed = uploadCompleteBodySchema.safeParse(await readJson(c));
    if (!parsed.success) throw new ApiError(400, MESSAGES.validation);
    const parts = parsed.data.parts;
    if (session.s3UploadId) {
      if (parts.length === 0) throw new ApiError(400, MESSAGES.validation);
      await deps.objects.completeMultipartUpload(session.objectKey, session.s3UploadId, parts);
    } else if (parts.length !== 0) {
      throw new ApiError(400, MESSAGES.validation);
    }
    const stored = await deps.objects.head(session.objectKey);
    if (!stored || stored.bytes <= 0) {
      await discard(deps, session);
      throw new ApiError(400, MESSAGES.validation);
    }
    if (session.bytes !== null && stored.bytes !== session.bytes) {
      await discard(deps, session);
      throw new ApiError(400, MESSAGES.sizeMismatch);
    }
    // Ported from main's fda8d64, and this is the higher-risk of the two paths because it is
    // the one open to participants. `albumUploadInitBodySchema` restricts the declared type
    // to image/jpeg or image/png and the PUT is signed for it, but S3 stores whatever
    // `Content-Type` the client actually sent: without this check the signed URL is a way for
    // any signed-in participant to park arbitrary bytes in the bucket.
    if (stored.contentType !== session.contentType) {
      await discard(deps, session);
      throw new ApiError(400, MESSAGES.validation);
    }
    // The cap again, on the row count this time: two inits in flight must not both land.
    try {
      await assertBelowCap(deps, album, user.id);
    } catch (error) {
      await discard(deps, session);
      throw error;
    }

    const photoId = randomUUID();
    let photo: PhotoRow;
    try {
      photo = await deps.db.insertPhoto({
        id: photoId,
        eventId: session.eventId,
        photographerId: user.id,
        sha256: session.sha256,
        originalKey: session.objectKey,
        contentType: session.contentType,
        bytes: stored.bytes,
        originalStatus: "present",
        filename: session.filename,
        // The album carried from init (`upload_sessions.album_id`, migration 010).
        albumId: session.albumId ?? album.id,
      });
    } catch (error) {
      if (!(error instanceof DuplicateKeyError)) throw error;
      // Same bytes won the race under another session: this object will never be referenced.
      await discard(deps, session);
      const winner = await deps.db.findPhotoByAlbumSha(album.id, session.sha256);
      if (!winner) throw error;
      return c.json(
        { status: "already-uploaded" as const, photoId: winner.id, albumId: album.id },
        200,
      );
    }

    // C2, the screening hook: it runs BEFORE publication and is the only thing that may
    // contradict post-moderation. The v6 default passes everything.
    const screening = deps.screening ?? noopScreening;
    const verdict = await screening.screen({
      photoId: photo.id,
      albumId: album.id,
      eventId: album.eventId,
      uploaderId: user.id,
      sha256: session.sha256,
      contentType: session.contentType,
      bytes: stored.bytes,
      objectKey: session.objectKey,
      album,
    });
    // `pre` moderation is not a photo queue in v6 (decision 6, frozen: no pre-moderation
    // queue for photos), but an album set to `pre` by the admin console must not publish on
    // arrival either, so it starts `pending`. `off` and `post` publish at once.
    const initial: ModerationState =
      verdict.state === "auto_rejected"
        ? "auto_rejected"
        : album.moderation === "pre"
          ? "pending"
          : "approved";
    if (initial !== "approved") {
      // Automatic path: no `moderated_by` / `moderated_at`, so the queue still reads
      // "nobody has ruled".
      await deps.db.setPhotoModeration({ photoId: photo.id, state: initial });
      await deps.db.insertAudit({
        actorId: null,
        action: initial === "auto_rejected" ? "moderation.auto_rejected" : "moderation.pending",
        target: `photo:${photo.id}`,
        meta: {
          albumId: album.id,
          ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
        },
      });
    }

    await deps.db.markUploadSession(session.id, "completed");
    if (initial === "auto_rejected") {
      // Withheld before publication: no derivatives, no index, and the bytes go straight
      // back out. `purgePhoto` is the one deletion path (it also clears faces and anchors).
      await purgePhoto(deps, photo.id);
      return c.json({ photoId: photo.id, status: "auto_rejected" as const }, 201);
    }
    await deps.queue.enqueue("derive", { photoId: photo.id }, {
      dedupeKey: jobDedupeKey("derive", { photoId: photo.id }) ?? undefined,
    });
    return c.json(
      { photoId: photo.id, status: "uploaded" as const, moderationState: initial },
      201,
    );
  });

  // --- C2: the album feed a participant sees ----------------------------------------------

  app.get("/v1/albums/:albumId/photos", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant", "photographer", "admin"]);
    const album = await loadAlbum(deps, c.req.param("albumId"));
    if (user.role === "participant") {
      // `visibility = 'staff'` is an album only the staff may read; `participants` and
      // `link` are both readable by a participant of the event (a link album is simply not
      // listed for them, which is the admin console's business, not this route's).
      if (album.visibility === "staff") throw new ApiError(403, MESSAGES.forbidden);
      await assertEventMember(deps, album, user.id, user.email);
    }
    const query = albumPhotosQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const cursor = query.data.cursor ? decodeCrowdCursor(query.data.cursor) : undefined;
    if (cursor === null) throw new ApiError(400, MESSAGES.validation);
    const limit = query.data.limit;
    const page = await deps.db.listAlbumPhotosPage(album.id, {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const photos = [];
    for (const row of page.items) {
      photos.push({
        id: row.id,
        albumId: row.albumId,
        uploaderId: row.uploaderId,
        createdAt: row.createdAt.toISOString(),
        thumbUrl: await deps.objects.presignGet(row.thumbKey),
        webUrl: await deps.objects.presignGet(row.webKey),
        mine: row.uploaderId === user.id,
      });
    }
    const used = await deps.db.countAlbumPhotosByUploader(album.id, user.id);
    return c.json({
      photos,
      nextCursor: page.nextCursor ? encodeCrowdCursor(page.nextCursor) : null,
      quota: { used, max: album.maxPhotosPerUser },
    });
  });

  // --- the crowd download, with main's IDOR guard -----------------------------------------

  app.post("/v1/albums/:albumId/photos/download", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant", "photographer", "admin"]);
    const album = await loadAlbum(deps, c.req.param("albumId"));
    // Exactly the gate of `GET /v1/albums/:albumId/photos`: a download must never see more
    // than the feed it is a download OF.
    if (user.role === "participant") {
      if (album.visibility === "staff") throw new ApiError(403, MESSAGES.forbidden);
      await assertEventMember(deps, album, user.id, user.email);
    }
    const body = albumDownloadBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const photos = await deps.db.listAlbumPhotosByIds(album.id, body.data.photoIds);
    // Main's IDOR guard (`listPublicPhotosByIds` + this comparison), and the reason it is a
    // comparison rather than a filter: anything the lookup did not return — an id in the
    // official album, an id in another event's album, a photo the report threshold withheld,
    // a photo whose derivatives have not landed — makes the WHOLE batch a 404. Returning the
    // subset that happened to qualify would turn this route into an oracle for which uuids
    // exist and which are approved, one id per request.
    if (photos.length !== new Set(body.data.photoIds).size) {
      throw new ApiError(404, MESSAGES.notFound);
    }
    // Derivatives only: see `crowdDownloadVariantSchema`. `original` is a 400 at the schema.
    const urls = await Promise.all(
      photos.map(async (photo) => ({
        photoId: photo.id,
        url: await deps.objects.presignGet(photo.webKey),
      })),
    );
    await deps.db.insertAudit({
      actorId: user.id,
      action: "album.download",
      target: `album:${album.id}`,
      meta: { eventId: album.eventId, photos: urls.length, variant: body.data.variant },
    });
    return c.json({ urls });
  });

  // --- C2: the report button --------------------------------------------------------------

  app.post("/v1/photos/:id/report", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const photo = await deps.db.findPhoto(parseUuidParam(c.req.param("id")));
    if (!photo) throw new ApiError(404, MESSAGES.notFound);
    const album = await deps.db.findAlbum(photo.albumId);
    if (!album) throw new ApiError(404, MESSAGES.notFound);
    await assertEventMember(deps, album, user.id, user.email);
    // Nothing already withheld can be reported again: there is nothing left to withhold.
    if (photo.moderationState === "rejected" || photo.moderationState === "auto_rejected") {
      throw new ApiError(404, MESSAGES.photoNotVisible);
    }
    const body = reportBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const perUser = deps.env.REPORT_PER_USER;
    if (perUser > 0) {
      const recent = await deps.db.countReportsByUserSince(
        user.id,
        since(REPORT_RATE_LIMIT.windowSeconds),
      );
      if (recent >= perUser) throw new ApiError(429, MESSAGES.rateLimited);
    }
    const reason = body.data.reason;
    const { created } = await deps.db.insertReport({
      photoId: photo.id,
      reporterId: user.id,
      reason,
      note: body.data.note ?? null,
    });
    // `not_me` is the recognition system's normal error mode, not an abuse signal: it is
    // answered PER USER through `gallery_feedback` — the same row the gallery's own
    // "Non sono io" button writes — so the photo is hidden for this person and for nobody
    // else. The report row stays (someone may genuinely want a wrong match looked at) but it
    // never counts. See MODERATION_COUNTING_REASONS in the contracts.
    const hiddenForYou = reason === "not_me" ? await hideForReporter(deps, photo, user.id) : false;
    // Counting reasons only: a `not_me` report cannot move this number.
    const openReports = await deps.db.countOpenReports(photo.id);
    let state: ModerationState = photo.moderationState;
    // The threshold is read from the env on every request, so the event-day value can be
    // raised or lowered without a restart.
    const threshold = deps.env.REPORT_AUTO_PENDING;
    if (state === "approved" && openReports >= threshold) {
      const updated = await deps.db.setPhotoModeration({ photoId: photo.id, state: "pending" });
      state = updated?.moderationState ?? "pending";
      await deps.db.insertAudit({
        actorId: null,
        action: "moderation.auto_pending",
        target: `photo:${photo.id}`,
        meta: { albumId: album.id, openReports, threshold },
      });
    }
    if (created) {
      await deps.db.insertAudit({
        actorId: user.id,
        action: "moderation.report",
        target: `photo:${photo.id}`,
        meta: { albumId: album.id, reason, counts: countsTowardModeration(reason) },
      });
    }
    return c.json({
      status: created ? ("recorded" as const) : ("already-reported" as const),
      state,
      openReports,
      counts: countsTowardModeration(reason),
      hiddenForYou,
    });
  });

  // --- C2: the staff moderation queue -----------------------------------------------------

  app.get("/v1/admin/moderation", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["admin"]);
    const query = moderationQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const cursor = query.data.cursor ? decodeCrowdCursor(query.data.cursor) : undefined;
    if (cursor === null) throw new ApiError(400, MESSAGES.validation);
    const page = await deps.db.listModerationPage({
      ...(query.data.albumId ? { albumId: query.data.albumId } : {}),
      ...(query.data.state ? { state: query.data.state } : {}),
      includeNotMe: query.data.includeNotMe,
      limit: query.data.limit,
      ...(cursor ? { cursor } : {}),
    });
    const items = [];
    for (const row of page.items) {
      items.push({
        photoId: row.photoId,
        albumId: row.albumId,
        eventId: row.eventId,
        uploaderId: row.uploaderId,
        moderationState: row.moderationState,
        createdAt: row.createdAt.toISOString(),
        openReports: row.openReports,
        reasons: row.reasons,
        notMeReports: row.notMeReports,
        thumbUrl: row.thumbKey ? await deps.objects.presignGet(row.thumbKey) : null,
        webUrl: row.webKey ? await deps.objects.presignGet(row.webKey) : null,
      });
    }
    return c.json({
      items,
      nextCursor: page.nextCursor ? encodeCrowdCursor(page.nextCursor) : null,
    });
  });

  app.post("/v1/admin/photos/:id/moderate", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["admin"]);
    const photoId = parseUuidParam(c.req.param("id"));
    const photo = await deps.db.findPhoto(photoId);
    if (!photo) throw new ApiError(404, MESSAGES.notFound);
    const body = moderateBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const state = body.data.state;
    const updated = await deps.db.setPhotoModeration({
      photoId: photo.id,
      state,
      moderatorId: user.id,
    });
    if (!updated) throw new ApiError(404, MESSAGES.notFound);
    // A ruling settles the reports that caused it, whichever way it went: otherwise the same
    // open reports would flip the photo back to `pending` on the next report.
    const closed = state === "pending" ? 0 : await deps.db.closeReports(photo.id);
    await deps.db.insertAudit({
      actorId: user.id,
      action: `moderation.${state}`,
      target: `photo:${photo.id}`,
      meta: {
        albumId: photo.albumId,
        eventId: photo.eventId,
        from: photo.moderationState,
        closedReports: closed,
      },
    });
    // Rejecting purges the object through the existing path: faces, anchors, derivatives,
    // original and the photo row.
    if (state === "rejected") {
      await purgePhoto(deps, photo.id);
      return c.json({ photoId: photo.id, state, purged: true });
    }
    return c.json({ photoId: photo.id, state, purged: false });
  });
}

// ---- crowd upload and moderation v6 (agent C) helpers -------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidParam(raw: string | undefined): string {
  if (!raw || !UUID_PATTERN.test(raw)) throw new ApiError(404, MESSAGES.notFound);
  return raw;
}

async function loadAlbum(deps: AppDeps, raw: string | undefined): Promise<AlbumRow> {
  const album = await deps.db.findAlbum(parseUuidParam(raw));
  if (!album) throw new ApiError(404, MESSAGES.notFound);
  return album;
}

async function loadAlbumEvent(deps: AppDeps, album: AlbumRow): Promise<EventRow> {
  const event = await deps.db.findEventById(album.eventId);
  if (!event) throw new ApiError(404, MESSAGES.notFound);
  return event;
}

/**
 * The allowlist half of clause 3: an `access = 'list'` event checks the imported participant
 * list, exactly as the selfie route does. For an `access = 'open'` event this is a no-op —
 * "open" is the policy decision that any signed-in participant may take part.
 *
 * Kept separate from {@link assertEventMember} because the upload path needs it on its own:
 * see the comment there.
 */
async function assertOnEventList(deps: AppDeps, event: EventRow, email: string): Promise<void> {
  if (event.access !== "list") return;
  if (!(await deps.db.isEventParticipant(event.id, email.toLowerCase()))) {
    throw new ApiError(403, MESSAGES.notOnList);
  }
}

/**
 * Clause 3 of C2: the caller belongs to the album's event.
 *
 * This used to be `if (event.access !== "list") return;`, which on an `open` event authorised
 * ANY signed-in participant: a person registered at event A could list and report in event
 * B's crowd album. The event code gated registration once, but until `event_members`
 * (migration 013) the event it resolved to was never persisted, so there was nothing to
 * compare against. Now there is, and it is checked first.
 */
async function assertEventMember(
  deps: AppDeps,
  album: AlbumRow,
  userId: string,
  email: string,
): Promise<void> {
  const event = await loadAlbumEvent(deps, album);
  if (!(await deps.db.isEventMember(userId, event.id))) {
    throw new ApiError(403, MESSAGES.notEventMember);
  }
  // The allowlist is checked ON TOP of membership, not folded into it: `events.access` can be
  // switched to `list` after people have joined, and from that moment the allowlist is the
  // authoritative answer rather than the historical membership row.
  await assertOnEventList(deps, event, email);
}

/**
 * The four clauses of C2 that must all hold before an upload is authorised, in the order
 * that leaks the least: the album exists, it is a crowd album, uploads are open, and the
 * caller belongs to the event. The cap is clause 4 and is checked separately
 * ({@link assertBelowCap}) because `complete` re-checks it on the row count.
 *
 * `uploads_open` is read here, per request, from the album row: flipping the switch in the
 * admin console takes effect on the next call with no restart of anything.
 */
async function crowdAlbumForUpload(
  deps: AppDeps,
  raw: string | undefined,
  userId: string,
  email: string,
): Promise<AlbumRow> {
  const album = await loadAlbum(deps, raw);
  if (album.kind !== "crowd") throw new ApiError(403, MESSAGES.uploadNotCrowd);
  // 423 Locked: the event-day kill switch, and the only status that tells the client the
  // upload would have been fine at any other moment.
  if (!album.uploadsOpen) throw new ApiError(423, MESSAGES.uploadsClosed);

  // Clause 3, and the one place in v6 where membership is WRITTEN rather than read.
  //
  // Uploading into a crowd album is how people join one. The flow is a QR code or a share
  // link on the table: sign in with Google (which knows nothing about any event), open the
  // album, upload. Those accounts have no `event_members` row — only self-registration with
  // an event code and the 013 backfill create one — so gating this path on membership would
  // lock out the main event-day path. Instead it ENROLS, with `source: 'upload'`, so that
  // from the first upload onward the person is on the record for this event and the gates
  // below (the feed, the report button) have something honest to check.
  //
  // What still bounds it: `assertOnEventList` runs FIRST, so a gated (`access = 'list'`)
  // event refuses a non-allowlisted person and no stray membership row is written for an
  // event they cannot use. On an `access = 'open'` event any signed-in participant may
  // upload — that is what `open` means, it is agent C's frozen decision in C2, and a crowd
  // album is post-moderated and per-user capped. The cross-event hole that mattered was
  // READING other people's photos and REPORTING them, and those two are now hard gates.
  const event = await loadAlbumEvent(deps, album);
  await assertOnEventList(deps, event, email);
  await deps.db.addEventMember({ userId, eventId: event.id, source: "upload" });
  return album;
}

/**
 * The burst gate on the crowd upload path, ported from main's `PUBLIC_UPLOAD_RATE_LIMIT`
 * (this path had no rate limit of any kind). Counts the sessions this uploader has started
 * in THIS album in the last hour, and 429s at `ALBUM_UPLOAD_MAX_PER_HOUR`.
 *
 * Why this flow gets the shared limiter rather than an in-process `Map` window like
 * self-registration or tagging: the three kinds of limiter in this repo are spelled out in
 * distributed-rate-limit.ts, and the decision for THIS flow is that the in-process kind is
 * not good enough. A `Map` window multiplies by the replica count, and unlike registration
 * (whose hard backstop is `event_codes.max_uses`, one statement in the database) a crowd
 * upload has no backstop at all on the default album: `max_photos_per_user` is nullable and
 * null means unlimited. The thing being bounded is bytes written to object storage by an
 * authenticated stranger, so the limit has to be real with any number of replicas.
 *
 * So: Upstash when it is configured (no query on the hot path), and a `upload_sessions`
 * count otherwise — which is exact and cross-replica on its own. The database is the
 * correctness floor and Redis is the optimisation, never the reverse. A Redis error is
 * logged and falls back rather than failing the upload, because the fallback is correct.
 */
async function assertUploadRate(
  deps: AppDeps,
  ip: string,
  album: AlbumRow,
  userId: string,
): Promise<void> {
  const max = deps.env.ALBUM_UPLOAD_MAX_PER_HOUR;
  if (max <= 0 || rateLimitExempt(deps, ip)) return;
  let started: number | null = null;
  try {
    started = await incrementSharedLimit({
      ...(deps.env.UPSTASH_REDIS_REST_URL ? { url: deps.env.UPSTASH_REDIS_REST_URL } : {}),
      ...(deps.env.UPSTASH_REDIS_REST_TOKEN ? { token: deps.env.UPSTASH_REDIS_REST_TOKEN } : {}),
      // Album, not event: sibling crowd albums have their own `uploads_open` and caps.
      key: `rephoto:album-upload:${album.id}:${userId}`,
      windowSeconds: ALBUM_UPLOAD_RATE_LIMIT.windowSeconds,
    });
  } catch (error) {
    console.error(`shared upload limiter unavailable: ${String(error)}`);
  }
  if (started === null) {
    // `+ 1` counts the request being authorised now, which the INCR above already did.
    started =
      (await deps.db.countAlbumUploadsSince(
        album.id,
        userId,
        since(ALBUM_UPLOAD_RATE_LIMIT.windowSeconds),
      )) + 1;
  }
  if (started > max) throw new ApiError(429, MESSAGES.rateLimited);
}

/** Clause 4 of C2: approved + pending in this album, strictly below the album's cap. */
async function assertBelowCap(deps: AppDeps, album: AlbumRow, userId: string): Promise<void> {
  const max = album.maxPhotosPerUser;
  if (max === null) return;
  const used = await deps.db.countAlbumPhotosByUploader(album.id, userId);
  if (used >= max) throw new ApiError(403, MESSAGES.uploadQuotaReached);
}

/** The caller's own open session, in this album. Anything else is a 404. */
async function ownCrowdUpload(
  deps: AppDeps,
  raw: string | undefined,
  userId: string,
  albumId: string,
): Promise<UploadSessionRow> {
  const session = await deps.db.findUploadSession(parseUuidParam(raw));
  if (!session || session.photographerId !== userId || session.albumId !== albumId) {
    throw new ApiError(404, MESSAGES.notFound);
  }
  return session;
}

async function discard(deps: AppDeps, session: UploadSessionRow): Promise<void> {
  await deps.db.markUploadSession(session.id, "aborted");
  await deps.objects.delete(session.objectKey);
}

type CrowdCursor = { createdAt: Date; id: string };

function encodeCrowdCursor(cursor: CrowdCursor): string {
  return encodeCursor([cursor.createdAt.toISOString(), cursor.id]);
}

function decodeCrowdCursor(raw: string): CrowdCursor | null {
  const parts = decodeCursor(raw, 2);
  if (!parts) return null;
  const [createdAtText, id] = parts;
  const createdAt = new Date(createdAtText ?? "");
  if (!id || Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) return null;
  return { createdAt, id };
}

/**
 * The per-user answer to `not_me`: the `gallery_feedback` row the gallery's own
 * "Non sono io" button writes, which is what hides the photo for this person (the web shows
 * `not_me` items under "Nascoste") and for nobody else.
 *
 * Only a photo that is really in the caller's own match gallery can be judged — the same
 * rule the gallery feedback route enforces — so a `not_me` on a crowd-album photo nobody
 * matched records the report and returns `hiddenForYou: false`, because there is no gallery
 * entry to hide.
 */
async function hideForReporter(
  deps: AppDeps,
  photo: PhotoRow,
  userId: string,
): Promise<boolean> {
  const owned = await deps.db.listOwnedPhotos(userId, photo.eventId, [photo.id]);
  if (owned.length === 0) return false;
  const item = (await deps.db.listGallery(userId, photo.eventId)).find(
    (row) => row.photoId === photo.id,
  );
  await deps.db.upsertFeedback({
    userId,
    eventId: photo.eventId,
    photoId: photo.id,
    verdict: "not_me",
    scoreAtTime: item?.score ?? null,
    // Still the recognition flow (migration 018): we only get here when the photo is in the
    // reporter's own match gallery, so "non sono io" is the same judgement about the matcher
    // the gallery button records, reached through the report sheet instead.
    source: "recognition",
  });
  return true;
}
