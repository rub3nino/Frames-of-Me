import { randomInt } from "node:crypto";
import type { Hono } from "hono";
import {
  adminAlbumPhotographerBodySchema,
  createAlbumBodySchema,
  createEventCodeBodySchema,
  EVENT_CODE_ALPHABET,
  EVENT_CODE_GROUP,
  updateAlbumBodySchema,
  updateEventCodeBodySchema,
  type AdminEventCode,
  type EventCodeStatus,
  type OpsLinkKey,
} from "@rephoto/contracts";
import {
  AlbumRecognitionLockedError,
  AlbumRecognitionNotAllowedError,
  DuplicateKeyError,
  type AlbumRow,
  type EventCodeRow,
  type EventRow,
} from "@rephoto/db";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { readJson, requireRole, requireUser } from "./http.js";

/**
 * v6 D — admin console (docs/v6-spec.md §D).
 *
 * A file of its own, registered from `routes.ts` with a single line, because four other
 * agents edit that file in the same wave. Everything here is admin-only except
 * `GET /v1/me/albums`, which a photographer reads about themselves.
 *
 * What is deliberately NOT here:
 *
 *  - the moderation queue API (`GET /v1/admin/moderation`,
 *    `POST /v1/admin/photos/:id/moderate`) and migration 010: agent C owns both. The
 *    console's moderation screen is written against the shapes in the spec and degrades to
 *    an explanatory message while those routes are absent.
 *  - consent revocation: agent G owns it. The participants route reports the consent state
 *    and the seam is marked below; nothing here withdraws a consent.
 *  - any API integration with Resend / PostHog / Sentry / Coolify / Authentik / R2. The
 *    operations page is links from the environment and nothing else (spec D, frozen).
 */
export function registerAdminV6Routes(app: Hono<AppEnv>, deps: AppDeps): void {
  // ---- event codes ----------------------------------------------------------------------
  //
  // The blocking deliverable: without this there is no way to create a registration code
  // and nobody can sign up on the event day. The code is the anti-bot gate of
  // `POST /v1/auth/register`, which uppercases what the form sends, so a code is stored
  // uppercase and compared as such.

  app.post("/v1/admin/events/:id/codes", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const body = createEventCodeBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const expiresAt = body.data.expiresAt ? new Date(body.data.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new ApiError(400, MESSAGES.validation);
    // An explicit code is taken as typed (uppercased); without one we mint a readable one
    // and retry on the astronomically unlikely collision with an existing code.
    const explicit = body.data.code ? normalizeCode(body.data.code) : null;
    let row: EventCodeRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
      const code = explicit ?? mintCode();
      try {
        row = await deps.db.createEventCode({
          eventId: event.id,
          code,
          label: body.data.label,
          maxUses: body.data.maxUses,
          expiresAt,
        });
      } catch (error) {
        if (!(error instanceof DuplicateKeyError)) throw error;
        if (explicit) throw new ApiError(409, MESSAGES.eventCodeExists);
      }
    }
    if (!row) throw new ApiError(409, MESSAGES.conflict);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "event_code.created",
      target: `event:${event.id}`,
      // The code value itself is the printable secret; the audit row keeps the label and
      // the limits, not the secret.
      meta: { label: row.label, maxUses: row.maxUses, expiresAt: row.expiresAt?.toISOString() ?? null },
    });
    return c.json({ code: adminEventCode(row) }, 201);
  });

  app.get("/v1/admin/events/:id/codes", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const codes = await deps.db.listEventCodes(event.id);
    return c.json({ codes: codes.map(adminEventCode) });
  });

  app.patch("/v1/admin/events/:id/codes/:code", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const code = normalizeCode(c.req.param("code"));
    const body = updateEventCodeBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const patch: Parameters<typeof deps.db.updateEventCode>[2] = {};
    if (body.data.label !== undefined) patch.label = body.data.label;
    if (body.data.maxUses !== undefined) patch.maxUses = body.data.maxUses;
    if (body.data.expiresAt !== undefined) {
      const at = body.data.expiresAt === null ? null : new Date(body.data.expiresAt);
      if (at && Number.isNaN(at.getTime())) throw new ApiError(400, MESSAGES.validation);
      patch.expiresAt = at;
    }
    const row = await deps.db.updateEventCode(event.id, code, patch);
    if (!row) throw new ApiError(404, MESSAGES.notFound);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "event_code.updated",
      target: `event:${event.id}`,
      meta: { label: row.label, maxUses: row.maxUses, expiresAt: row.expiresAt?.toISOString() ?? null },
    });
    return c.json({ code: adminEventCode(row) });
  });

  app.delete("/v1/admin/events/:id/codes/:code", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const code = normalizeCode(c.req.param("code"));
    // Revoking is `expires_at = now()` rather than a delete or a third state: agent B's
    // `claimEventCode` already refuses an expired code in the same statement that
    // increments `uses`, so a revoked code cannot be handed out by any path, and the row
    // keeps how many people had already used it. The timestamp is the database's `now()`,
    // not this process's clock: an api running a second ahead of the server would otherwise
    // leave a revoked code live for that second.
    const row = await deps.db.revokeEventCode(event.id, code);
    if (!row) throw new ApiError(404, MESSAGES.notFound);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "event_code.revoked",
      target: `event:${event.id}`,
      meta: { uses: row.uses, label: row.label },
    });
    return c.json({ code: adminEventCode(row) });
  });

  // ---- albums ---------------------------------------------------------------------------
  //
  // The two frozen rules (decisions 2 and 3) are enforced by the database — the
  // `crowd_never_recognizes` check and the `recognition` trigger of migration 009 — and
  // mapped here to a 409 with the reason in Italian. Nothing in this file works around
  // them: the console explains them, the database refuses them.

  app.get("/v1/admin/events/:id/albums", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const albums = await deps.db.listAlbums(event.id);
    return c.json({ albums: albums.map(publicAlbum) });
  });

  app.post("/v1/admin/events/:id/albums", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const body = createAlbumBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    let album: AlbumRow;
    try {
      album = await deps.db.createAlbum({ eventId: event.id, ...body.data });
    } catch (error) {
      throw albumApiError(error);
    }
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "album.created",
      target: `album:${album.id}`,
      meta: { eventId: event.id, slug: album.slug, kind: album.kind, recognition: album.recognition },
    });
    return c.json({ album: publicAlbum(album) }, 201);
  });

  app.get("/v1/admin/albums/:albumId", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    return c.json({ album: publicAlbum(await loadAlbum(deps, c.req.param("albumId"))) });
  });

  app.patch("/v1/admin/albums/:albumId", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const current = await loadAlbum(deps, c.req.param("albumId"));
    const body = updateAlbumBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    let album: AlbumRow | null;
    try {
      album = await deps.db.updateAlbum(current.id, body.data);
    } catch (error) {
      throw albumApiError(error);
    }
    if (!album) throw new ApiError(404, MESSAGES.notFound);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "album.updated",
      target: `album:${album.id}`,
      meta: { ...body.data },
    });
    return c.json({ album: publicAlbum(album) });
  });

  // ---- photographer authorization per album ---------------------------------------------
  //
  // Migration 017. The event-level grant (`event_photographers`, v5) stays in front of this
  // one: an album with no row is open to every photographer of the event, an album with
  // rows only to those listed. `db.isAlbumPhotographerAllowed` is the single reader, and the
  // upload route calls it right after `isEventPhotographer` (see `GET /v1/me/albums`, which
  // is what the upload UI reads to know where it may upload).

  app.get("/v1/admin/albums/:albumId/photographers", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const album = await loadAlbum(deps, c.req.param("albumId"));
    const rows = await deps.db.listAlbumPhotographers(album.id);
    return c.json({
      photographers: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        createdAt: row.createdAt.toISOString(),
      })),
      restricted: rows.length > 0,
    });
  });

  app.post("/v1/admin/albums/:albumId/photographers", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const album = await loadAlbum(deps, c.req.param("albumId"));
    const body = adminAlbumPhotographerBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const email = body.data.email.toLowerCase();
    const user = await deps.db.findUserByEmailRole(email, "photographer");
    if (!user) throw new ApiError(404, MESSAGES.notFound);
    // The album grant narrows the event grant, so it is worthless without it: give the
    // event grant too rather than authorizing an album the photographer cannot reach.
    if (!(await deps.db.isEventPhotographer(album.eventId, user.id))) {
      await deps.db.addEventPhotographer(album.eventId, user.id);
    }
    await deps.db.addAlbumPhotographer(album.id, user.id);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "album.photographer_added",
      target: `album:${album.id}`,
      meta: { userId: user.id, email },
    });
    return c.json({ userId: user.id, email, albumId: album.id }, 201);
  });

  app.delete("/v1/admin/albums/:albumId/photographers/:userId", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const album = await loadAlbum(deps, c.req.param("albumId"));
    const userId = parseUuid(c.req.param("userId"));
    const removed = await deps.db.removeAlbumPhotographer(album.id, userId);
    if (!removed) throw new ApiError(404, MESSAGES.notFound);
    await deps.db.insertAudit({
      actorId: actor.id,
      action: "album.photographer_removed",
      target: `album:${album.id}`,
      meta: { userId },
    });
    return c.json({ removed: true });
  });

  /**
   * The albums the caller may upload to in an event: the event grant first, then the
   * per-album narrowing. Admins see every album of the event. This is the read the upload
   * UI uses, and the same pair of checks an upload route must make before accepting bytes.
   */
  app.get("/v1/me/albums", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer", "admin"]);
    const eventId = c.req.query("eventId");
    if (!eventId) throw new ApiError(400, MESSAGES.validation);
    const event = await loadEvent(deps, eventId);
    const albums = await deps.db.listAlbums(event.id);
    if (user.role === "admin") return c.json({ albums: albums.map(publicAlbum) });
    if (!(await deps.db.isEventPhotographer(event.id, user.id))) {
      throw new ApiError(403, MESSAGES.forbidden);
    }
    const allowed: AlbumRow[] = [];
    for (const album of albums) {
      if (await deps.db.isAlbumPhotographerAllowed(album.id, user.id)) allowed.push(album);
    }
    return c.json({ albums: allowed.map(publicAlbum) });
  });

  // ---- live event status ------------------------------------------------------------------
  //
  // One screen, auto-refreshing: it extends `GET /v1/admin/metrics` (which stays as it is,
  // four agents are in that file) with the per-event numbers the event day needs. The queue
  // view, the oldest queued age per job type and the last 20 job errors come from the same
  // `metricsExtras()` the v5 status panel reads.

  app.get("/v1/admin/events/:id/status", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const event = await loadEvent(deps, c.req.param("id"));
    const [status, extras, faceService] = await Promise.all([
      deps.db.eventStatus(event.id),
      deps.db.metricsExtras(),
      probeFaceService(deps),
    ]);
    const match = extras.jobsByType.find((row) => row.type === "match");
    return c.json({
      event: { id: event.id, slug: event.slug, name: event.name },
      photos: status.photos,
      photosByStatus: status.photosByStatus,
      originalsPending: status.originalsPending,
      faces: status.faces,
      galleries: status.galleries,
      galleriesMatched: status.galleriesMatched,
      selfiesWaiting: status.selfiesWaiting,
      matchJobsPending: match ? match.queued + match.running : 0,
      albums: status.albums.map((album) => ({
        id: album.id,
        slug: album.slug,
        name: album.name,
        kind: album.kind,
        recognition: album.recognition,
        moderation: album.moderation,
        uploadsOpen: album.uploadsOpen,
        photos: album.photos,
        firstUploadAt: album.firstUploadAt?.toISOString() ?? null,
      })),
      jobsByType: extras.jobsByType,
      oldestQueuedSeconds: extras.oldestQueuedSeconds,
      lastErrors: extras.lastErrors.map((row) => ({
        id: row.id,
        type: row.type,
        error: row.error,
        at: row.at.toISOString(),
      })),
      faceService,
      at: new Date().toISOString(),
    });
  });

  // ---- participants -----------------------------------------------------------------------

  /**
   * Lookup by email: the participant, their consent state and a summary of their personal
   * match gallery. The gallery itself is served by `GET /v1/admin/galleries?email=` (v5),
   * untouched — the console reuses it instead of growing a second read of
   * `galleries`/`gallery_items`.
   *
   * SEAM (agent G): consent revocation. `revocable` is reported so the console can show the
   * control, and `canRevoke` is false until agent G lands the withdrawal path
   * (`consents.withdrawn_at` + what it implies for vectors and galleries). Nothing here
   * withdraws a consent; deleting the participant is the only destructive action offered,
   * through the existing `DELETE /v1/admin/participants/:id`.
   */
  app.get("/v1/admin/participants/lookup", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const eventId = c.req.query("eventId");
    const rawEmail = c.req.query("email");
    if (!eventId || !rawEmail) throw new ApiError(400, MESSAGES.validation);
    const event = await loadEvent(deps, eventId);
    const email = rawEmail.trim().toLowerCase();
    const user = await deps.db.findUserByEmail(email, "participant");
    if (!user) throw new ApiError(404, MESSAGES.notFound);
    const [consent, gallery, onList] = await Promise.all([
      deps.db.hasActiveConsent(user.id, event.id),
      deps.db.findGalleryByUser(user.id, event.id),
      deps.db.isEventParticipant(event.id, email),
    ]);
    return c.json({
      user: { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt.toISOString() },
      consent: { active: consent, canRevoke: false },
      onParticipantList: onList,
      emailVerifiedAt: (await deps.db.findEmailVerifiedAt(user.id))?.toISOString() ?? null,
      gallery: gallery
        ? {
            id: gallery.id,
            matchedAt: gallery.matchedAt?.toISOString() ?? null,
            reason: gallery.reason,
            hasQueryVector: gallery.hasQueryVector,
            anchors: gallery.anchorFaceIds.length,
          }
        : null,
    });
  });

  // ---- operations -------------------------------------------------------------------------

  app.get("/v1/admin/ops-links", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const configured: Array<{ key: OpsLinkKey; label: string; url: string | undefined }> = [
      { key: "resend", label: "Resend (email)", url: deps.env.OPS_LINK_RESEND },
      { key: "posthog", label: "PostHog (prodotto)", url: deps.env.OPS_LINK_POSTHOG },
      { key: "sentry", label: "Sentry (errori)", url: deps.env.OPS_LINK_SENTRY },
      { key: "coolify", label: "Coolify (deploy)", url: deps.env.OPS_LINK_COOLIFY },
      { key: "authentik", label: "Authentik (identità)", url: deps.env.OPS_LINK_AUTHENTIK },
      { key: "r2", label: "R2 (oggetti)", url: deps.env.OPS_LINK_R2 },
    ];
    return c.json({
      links: configured
        .filter((entry): entry is { key: OpsLinkKey; label: string; url: string } =>
          typeof entry.url === "string" && entry.url.length > 0,
        )
        .map((entry) => ({ key: entry.key, label: entry.label, url: entry.url })),
    });
  });
}

// ---- helpers (module level, agent D) --------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACE_SERVICE_PROBE_MS = 2_000;

function parseUuid(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiError(400, MESSAGES.validation);
  return value;
}

async function loadEvent(deps: AppDeps, rawId: string): Promise<EventRow> {
  const event = await deps.db.findEventById(parseUuid(rawId));
  if (!event) throw new ApiError(404, MESSAGES.notFound);
  return event;
}

async function loadAlbum(deps: AppDeps, rawId: string): Promise<AlbumRow> {
  const album = await deps.db.findAlbum(parseUuid(rawId));
  if (!album) throw new ApiError(404, MESSAGES.notFound);
  return album;
}

/** The two frozen album rules, as the database reports them, with the reason in Italian. */
function albumApiError(error: unknown): unknown {
  if (error instanceof AlbumRecognitionNotAllowedError) {
    return new ApiError(409, MESSAGES.albumCrowdNoRecognition);
  }
  if (error instanceof AlbumRecognitionLockedError) {
    return new ApiError(409, MESSAGES.albumRecognitionLocked);
  }
  if (error instanceof DuplicateKeyError) return new ApiError(409, MESSAGES.conflict);
  return error;
}

function publicAlbum(album: AlbumRow) {
  return {
    id: album.id,
    eventId: album.eventId,
    slug: album.slug,
    name: album.name,
    kind: album.kind,
    recognition: album.recognition,
    moderation: album.moderation,
    visibility: album.visibility,
    maxPhotosPerUser: album.maxPhotosPerUser,
    uploadsOpen: album.uploadsOpen,
    retentionDays: album.retentionDays,
    firstUploadAt: album.firstUploadAt?.toISOString() ?? null,
    createdAt: album.createdAt.toISOString(),
  };
}

/** Uppercase and trimmed, exactly what `POST /v1/auth/register` compares against. */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** `ABCD-EFGH` from an alphabet with no look-alike characters. */
function mintCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < 2; group += 1) {
    let value = "";
    for (let index = 0; index < EVENT_CODE_GROUP; index += 1) {
      value += EVENT_CODE_ALPHABET[randomInt(EVENT_CODE_ALPHABET.length)];
    }
    groups.push(value);
  }
  return groups.join("-");
}

/** What `claimEventCode` would do with this code right now. Derived, never stored. */
function codeStatus(row: EventCodeRow, now: Date): EventCodeStatus {
  if (row.expiresAt !== null && row.expiresAt <= now) return "expired";
  if (row.maxUses !== null && row.uses >= row.maxUses) return "exhausted";
  return "active";
}

function adminEventCode(row: EventCodeRow): AdminEventCode {
  return {
    eventId: row.eventId,
    code: row.code,
    label: row.label,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    status: codeStatus(row, new Date()),
  };
}

/**
 * Same probe as the v5 status panel: a HEAD on the face service with a short timeout.
 * `null` when no face service is in use (`FACE_ENGINE` other than insightface).
 */
async function probeFaceService(deps: AppDeps): Promise<{ ok: boolean | null; ms: number | null }> {
  if (deps.env.FACE_ENGINE !== "insightface") return { ok: null, ms: null };
  const started = Date.now();
  try {
    const response = await fetch(`${deps.env.FACE_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(FACE_SERVICE_PROBE_MS),
    });
    return { ok: response.ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: null };
  }
}
