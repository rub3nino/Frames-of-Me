/**
 * v6 G (agent G) — the privacy routes: consent withdrawal (by the participant and by an
 * admin) and the retention schedule the admin status screen reads.
 *
 * Why a file of its own: four other agents edit `routes.ts` in the same wave, so this
 * package adds exactly one line there (`registerPrivacyRoutes(app, deps)`).
 *
 * The gap this closes: `consents.withdrawn_at` has existed since migration 001 and is read
 * on every selfie (`hasActiveConsent`), but nothing in the codebase ever wrote it. A
 * participant asking to stop being recognised could only be served with hand-written SQL,
 * which is the open point "Revoca self-service del partecipante" of docs/DPIA.md §10.
 *
 * What a withdrawal deletes, and what survives it, is decided and documented in
 * docs/DPIA.md §3 bis; `Database.withdrawConsent` performs it in one transaction.
 */
import type { Hono } from "hono";
import {
  adminConsentWithdrawBodySchema,
  consentWithdrawBodySchema,
  retentionAlarm,
  retentionWindowStart,
} from "@rephoto/contracts";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { readJson, requireRole, requireUser } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPrivacyRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  /** "I miei dati": the participant's own consent and what of theirs is stored. */
  app.get("/v1/events/:slug/privacy", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const [state, uploads] = await Promise.all([
      deps.db.findConsentState(user.id, event.id),
      deps.db.countPhotosByUploader(event.id, user.id),
    ]);
    return c.json(privacyState(event, state, uploads));
  });

  /** The participant withdraws their own consent. Idempotent: a second call deletes nothing. */
  app.post("/v1/events/:slug/consent/withdraw", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadEvent(deps, c.req.param("slug"));
    const body = consentWithdrawBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    return c.json(await withdraw(deps, { userId: user.id, eventId: event.id, actorId: user.id }));
  });

  /**
   * An admin withdraws for a participant who asked by other means (e-mail, help desk).
   * The audit row names the admin as the actor and the participant as the target.
   */
  app.post("/v1/admin/participants/:id/consent/withdraw", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const userId = parseUuid(c.req.param("id"));
    const body = adminConsentWithdrawBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    const target = await deps.db.findUserById(userId);
    if (!target || target.role !== "participant") throw new ApiError(404, MESSAGES.notFound);
    const event = await deps.db.findEventById(body.data.eventId);
    if (!event) throw new ApiError(404, MESSAGES.notFound);
    return c.json(
      await withdraw(deps, {
        userId: target.id,
        eventId: event.id,
        actorId: actor.id,
        ...(body.data.note === undefined ? {} : { note: body.data.note }),
      }),
    );
  });

  /**
   * The retention schedule, per event: when the scheduler last enqueued a run, which window
   * that run belonged to, when the next window opens, how the last `retention` job ended and
   * whether something needs attention (`alarm`). The scheduler itself lives in the worker
   * (apps/worker/src/retention-scheduler.ts).
   */
  app.get("/v1/admin/retention/schedule", async (c) => {
    const actor = requireUser(c);
    requireRole(actor, ["admin"]);
    const windowSeconds = deps.env.RETENTION_WINDOW_HOURS * 3600;
    const now = Date.now();
    const current = retentionWindowStart(now, windowSeconds);
    const rows = await deps.db.listRetentionStatus();
    return c.json({
      enabled: deps.env.RETENTION_SCHEDULER,
      windowSeconds,
      events: rows.map((row) => {
        const ranThisWindow =
          row.windowStart !== null && row.windowStart.getTime() >= current;
        const nextRunAt = new Date(ranThisWindow ? current + windowSeconds * 1000 : now);
        return {
          eventId: row.eventId,
          slug: row.slug,
          retentionDays: row.retentionDays,
          lastRunAt: row.claimedAt?.toISOString() ?? null,
          windowStart: row.windowStart?.toISOString() ?? null,
          nextRunAt: nextRunAt.toISOString(),
          runs: row.runs,
          outcome: row.lastOutcome,
          jobId: row.lastJob?.id ?? null,
          jobStatus: row.lastJob?.status ?? null,
          jobError: row.lastJob?.error ?? null,
          jobFinishedAt: row.lastJob?.finishedAt?.toISOString() ?? null,
          alarm: retentionAlarm(row, {
            now,
            windowSeconds,
            enabled: deps.env.RETENTION_SCHEDULER,
          }),
        };
      }),
    });
  });
}

/**
 * The withdrawal itself, shared by the participant route and the admin one.
 *
 * Order matters. The transaction (`withdrawConsent`) marks the consent withdrawn and deletes
 * the gallery, its items, the selfie template, the anchors, the identified `face_vectors`
 * rows, the feedback and the match log. Then:
 *
 * - `FaceEngine.deleteFaces` removes the same faces from the engine's own store. With
 *   `FACE_ENGINE=insightface` — the engine of the event — that store *is* `face_vectors`,
 *   so the call is a no-op; it matters for the Rekognition alternative and the fake engine.
 *   A failure there is recorded in the audit row instead of losing the whole withdrawal:
 *   the data in our database is already gone, which is what the participant asked for.
 * - the kept selfie objects (`KEEP_SELFIES`) go from the object store.
 * - one `consent.withdrawn` audit row, with counts only. The face ids are deliberately NOT
 *   written to the audit: `faces.external_id` still exists on the photos that stay, so
 *   storing the ids would recreate exactly the person-to-face link the withdrawal removed.
 */
async function withdraw(
  deps: AppDeps,
  input: { userId: string; eventId: string; actorId: string; note?: string },
): Promise<{
  withdrawnAt: string;
  deleted: {
    consents: number;
    gallery: boolean;
    galleryItems: number;
    selfieVector: boolean;
    anchors: number;
    faceVectors: number;
    selfieObjects: number;
    feedback: number;
    matchRuns: number;
  };
}> {
  const result = await deps.db.withdrawConsent({ userId: input.userId, eventId: input.eventId });
  let engineError: string | null = null;
  if (result.externalFaceIds.length > 0) {
    try {
      await deps.faces.deleteFaces(input.eventId, result.externalFaceIds);
    } catch (error) {
      engineError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  }
  for (const key of result.selfieKeys) await deps.objects.delete(key);
  await deps.db.insertAudit({
    actorId: input.actorId,
    action: "consent.withdrawn",
    target: `user:${input.userId}`,
    meta: {
      eventId: input.eventId,
      consents: result.consents,
      gallery: result.galleryDeleted,
      galleryItems: result.galleryItems,
      selfieVector: result.selfieVector,
      anchors: result.anchors,
      faceVectors: result.faceVectors,
      identifiedFaces: result.externalFaceIds.length,
      selfieObjects: result.selfieKeys.length,
      feedback: result.feedback,
      matchRuns: result.matchRuns,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(engineError === null ? {} : { engineError }),
    },
  });
  if (engineError !== null) {
    // Never silent: the templates are gone from our database, but a Rekognition collection
    // may still hold them and no retry path exists (docs/DPIA.md §3 bis).
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        withdrawal: "engine-delete-failed",
        faces: result.externalFaceIds.length,
        error: engineError,
      }),
    );
  }
  // After the transaction: the stored `withdrawn_at` when this call (or an earlier one) set it.
  const state = await deps.db.findConsentState(input.userId, input.eventId);
  return {
    withdrawnAt: (state.withdrawnAt ?? new Date()).toISOString(),
    deleted: {
      consents: result.consents,
      gallery: result.galleryDeleted,
      galleryItems: result.galleryItems,
      selfieVector: result.selfieVector,
      anchors: result.anchors,
      faceVectors: result.faceVectors,
      selfieObjects: result.selfieKeys.length,
      feedback: result.feedback,
      matchRuns: result.matchRuns,
    },
  };
}

function privacyState(
  event: { slug: string; name: string },
  state: Awaited<ReturnType<AppDeps["db"]["findConsentState"]>>,
  uploads: number,
) {
  return {
    event: { slug: event.slug, name: event.name },
    consent:
      state.grantedAt && state.textVersion
        ? { grantedAt: state.grantedAt.toISOString(), textVersion: state.textVersion }
        : null,
    withdrawnAt: state.withdrawnAt?.toISOString() ?? null,
    gallery: state.gallery
      ? {
          photos: state.gallery.photos,
          selfieVector: state.gallery.selfieVector,
          anchors: state.gallery.anchors,
          matchedAt: state.gallery.matchedAt?.toISOString() ?? null,
        }
      : null,
    uploads,
  };
}

async function loadEvent(deps: AppDeps, slug: string) {
  const event = await deps.db.findEventBySlug(slug);
  if (!event) throw new ApiError(404, MESSAGES.notFound);
  return event;
}

/** Same guard as `routes.ts`, which does not export it. */
function parseUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiError(400, MESSAGES.validation);
  return value;
}
