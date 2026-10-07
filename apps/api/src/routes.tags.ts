import type { Hono } from "hono";
import {
  DISPLAY_NAME_MAX_CHARS,
  TAG_SEARCH_LIMIT,
  TAG_SEARCH_MIN_CHARS,
  TAG_SEARCH_RATE_LIMIT,
  TAG_WRITE_RATE_LIMIT,
  tagCreateBodySchema,
  tagProfileBodySchema,
  tagSearchQuerySchema,
  type EmailPayload,
} from "@rephoto/contracts";
import type { EventRow, PhotoRow, TagProfileRow, UserRow } from "@rephoto/db";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { readJson, requireRole, requireUser } from "./http.js";

/**
 * v6 E (agent E): tagging.
 *
 * Tagging creates exactly the person<->photo link that face recognition creates, minus the
 * biometrics. It is therefore a privacy feature wearing a social feature's clothes, and every
 * default here is the conservative one:
 *
 *   * `event_members.taggable` is false until the participant says otherwise (migration 013).
 *     No route here flips it except the participant's own `PUT /tags/me`, which pins the
 *     Italian consent text (`TAG_CONSENT_TEXT`) and records the accepted version.
 *   * the opt-in is PER EVENT. It lives on the membership row, not on `users`: a global flag
 *     would mean consenting once, at one event, to being nameable at every event the
 *     deployment ever runs, and `TAG_CONSENT_TEXT` says "questo evento".
 *   * `event_members.taggable` IS the consent for tagging, and it is NOT the recognition
 *     consent in `consents`. Nothing here requires a `consents` row: decision 2 freezes that
 *     a `crowd` album is never biometric, so a participant whose only involvement is the
 *     crowd album never grants recognition consent — and tagging is the only way those people
 *     can find themselves in a non-biometric album. See `assertEventMember`.
 *   * removal is the existing `not_me` feedback flow: `DELETE /tags/:photoId` writes the same
 *     `gallery_feedback` row the gallery's "Non sono io" button writes, and marks the tag
 *     `removed`. Participants already understand that button; there is no second mechanism.
 *   * a removal is terminal. `photo_tags` keeps the row (primary key `(photo_id, user_id)`),
 *     so the tagger's second attempt hits the conflict and gets a 409 instead of silently
 *     re-creating the link.
 *   * every tag and every untag writes an `audit_log` row.
 *   * the tagged person is notified (an `email` job of kind `tagged`).
 *
 * THE AUTOCOMPLETE IS THE DANGEROUS PART. With 6 000 participants a loose `/tags/search`
 * publishes a searchable roster of everyone at the event. Five rules hold it shut, and
 * `apps/api/test/v6-tags.test.ts` has a test per rule because this is the kind of endpoint a
 * later "improvement" relaxes:
 *
 *   1. only members of THIS event who set `taggable` for THIS event and have a display name —
 *      the per-event opt-in is the whole control, which is why it is an explicit consent and
 *      not a side effect, and why a person who opted in at event A is invisible at event B;
 *   2. at least `TAG_SEARCH_MIN_CHARS` (3) characters — "", "a" and "ab" are refused by the
 *      schema, before any query runs, and the database layer refuses them again;
 *   3. only a **prefix** match, so the list cannot be walked with 3-character windows;
 *   4. display names only. The response schema is `.strict()` and has no `email` field;
 *   5. rate limited per session, and open only to members of the event.
 *
 * The routes live in their own file and `routes.ts` gains exactly one line, because four other
 * agents are editing `routes.ts` in parallel.
 */
export function registerTagRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  // In-process sliding windows, one pair per app, same shape as the registration limiter in
  // routes.ts. Keyed per session (see `sessionKey`): losing them on restart, or multiplying
  // them by the number of api replicas, only blunts a bot loop — the hard guarantees are the
  // opt-in column and the 3-character minimum, which are in the database and the schema.
  const searchLimiter = createTagLimiter(TAG_SEARCH_RATE_LIMIT.windowSeconds);
  const writeLimiter = createTagLimiter(TAG_WRITE_RATE_LIMIT.windowSeconds);

  /** The caller's own opt-in state and the photos they are tagged in. */
  app.get("/v1/events/:slug/tags/me", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    // No consent gate here on purpose: seeing the links other people made about you, and
    // removing them, must never depend on a consent you may have just withdrawn.
    const [profile, tagged] = await Promise.all([
      deps.db.findTagProfile(user.id, event.id),
      deps.db.listTaggedPhotosForUser(user.id, event.id),
    ]);
    const items = [];
    for (const row of tagged) {
      items.push({
        photoId: row.photoId,
        thumbUrl: await deps.objects.presignGet(row.thumbKey),
        webUrl: await deps.objects.presignGet(row.webKey),
        createdAt: row.createdAt.toISOString(),
      });
    }
    return c.json({ profile: publicTagProfile(profile), items });
  });

  /**
   * The opt-in for ONE event, and the only way `event_members.taggable` ever becomes true.
   *
   * Opting out is a withdrawal, so it is not only a flag: every still-active tag of the caller
   * on photos of THIS event is moved to `removed` and audited. Leaving old tags alive after an
   * opt-out would keep the person<->photo links the opt-out was meant to end — and scoping the
   * cascade to the event is the other half: opting out here must not touch the tags the same
   * person accepted at another event.
   */
  app.put("/v1/events/:slug/tags/me", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    const body = tagProfileBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    // Both directions: a non-member has nothing to opt into and nothing to opt out of. The
    // gate is event membership, NOT a recognition consent — see `assertEventMember`.
    await assertEventMember(deps, user, event);
    const input: {
      taggable: boolean;
      displayName?: string | null;
      consentTextVersion?: string | null;
    } = { taggable: body.data.taggable };
    if (body.data.displayName !== undefined) input.displayName = body.data.displayName;
    // The schema pins `consentTextVersion` to the current text on an opt-in, so reaching
    // here with `taggable: true` means the participant was shown these words.
    if (body.data.taggable) input.consentTextVersion = body.data.consentTextVersion;
    const profile = await deps.db.setTagProfile(user.id, event.id, input);
    // `setTagProfile` returns null when `taggable` is true with no display name, stored or
    // supplied: a findable row with no name is the shape that invites a "fall back to the
    // e-mail" patch later.
    if (!profile) throw new ApiError(400, MESSAGES.tagNameRequired);
    if (!profile.taggable) {
      for (const tag of await deps.db.listActivePhotoTagsForUser(user.id, event.id)) {
        const removed = await deps.db.removePhotoTag(tag.photoId, user.id);
        if (!removed) continue;
        await auditUntag(deps, {
          actorId: user.id,
          photoId: tag.photoId,
          userId: user.id,
          eventId: event.id,
          reason: "opt_out",
        });
      }
    }
    // The consent record: which Italian text the participant accepted, and when. The columns
    // on `event_members` hold the present state; this row is the history.
    await deps.db.insertAudit({
      actorId: user.id,
      action: profile.taggable ? "tag.optin" : "tag.optout",
      target: `user:${user.id}`,
      meta: {
        eventId: event.id,
        hasDisplayName: profile.displayName !== null,
        consentTextVersion: profile.consentTextVersion,
      },
    });
    return c.json(publicTagProfile(profile));
  });

  /**
   * The username autocomplete. Read the five rules in this file's header before changing
   * anything here, and keep the tests in `apps/api/test/v6-tags.test.ts` passing: each of
   * them exists because relaxing one of those rules publishes the event's roster.
   */
  app.get("/v1/events/:slug/tags/search", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    await assertEventMember(deps, user, event);
    // Rule 2. `tagSearchQuerySchema` requires `q` and at least TAG_SEARCH_MIN_CHARS trimmed
    // characters, so a missing, empty, 1-character or 2-character query is a 400 and no query
    // ever runs. It is NOT answered with an empty list, because an empty list is the kind of
    // answer a later refactor "fixes" into a full one.
    const query = tagSearchQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new ApiError(400, MESSAGES.validation);
    const term = query.data.q.trim();
    if (term.length < TAG_SEARCH_MIN_CHARS) throw new ApiError(400, MESSAGES.validation);
    // Rule 5: the budget is per session.
    if (!searchLimiter.allow(sessionKey(user), TAG_SEARCH_RATE_LIMIT.max)) {
      throw new ApiError(429, MESSAGES.rateLimited);
    }
    // Rules 1 and 3 are in the query itself: an `event_members` row for THIS event with
    // `taggable` set and a display name, matched on a prefix. The event scope is what stops
    // the autocomplete being a directory of the whole deployment.
    const rows = await deps.db.searchTaggableUsers({
      eventId: event.id,
      prefix: term,
      limit: TAG_SEARCH_LIMIT,
    });
    // Rule 4: `userId` and `displayName`, nothing else. Never spread a `UserRow` here.
    return c.json({
      items: rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName.slice(0, DISPLAY_NAME_MAX_CHARS),
      })),
    });
  });

  /** Tags a participant in a photo the caller can see. */
  app.post("/v1/events/:slug/tags", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    await assertEventMember(deps, user, event);
    const body = tagCreateBodySchema.safeParse(await readJson(c));
    if (!body.success) throw new ApiError(400, MESSAGES.validation);
    if (!writeLimiter.allow(sessionKey(user), TAG_WRITE_RATE_LIMIT.max)) {
      throw new ApiError(429, MESSAGES.rateLimited);
    }
    const photo = await visibleTagPhoto(deps, user, event, body.data.photoId);
    // The opt-in, checked before anything is written so the answer is the honest 403 rather
    // than a conflict. `insertPhotoTag` checks it again inside its single statement, which is
    // what actually holds under a concurrent opt-out.
    const target = await deps.db.findTagProfile(body.data.userId, event.id);
    // Membership of THIS event plus the per-event opt-in is the whole test — `findTagProfile`
    // returns null when there is no `event_members` row, so a person who opted in at another
    // event cannot be tagged here. A recognition consent is NOT required: a crowd-album
    // participant never grants one (decision 2) and tagging is the only way they can find
    // themselves in a non-biometric album.
    if (!target || !target.taggable || !target.displayName) {
      throw new ApiError(403, MESSAGES.tagNotAllowed);
    }
    const tag = await deps.db.insertPhotoTag({
      photoId: photo.id,
      userId: body.data.userId,
      taggedBy: user.id,
    });
    // Null means "a row for (photo, user) already exists" — active, or 'removed' because the
    // tagged person refused it. The two are one answer on purpose: a tagger must not learn
    // that someone removed their tag, and must not be able to re-create it either.
    if (!tag) throw new ApiError(409, MESSAGES.tagExists);
    await deps.db.insertAudit({
      actorId: user.id,
      action: "photo.tagged",
      target: `photo:${photo.id}`,
      meta: { eventId: event.id, userId: tag.userId, taggedBy: user.id },
    });
    // The tagged person is told. Enqueued (not sent inline) so the route never waits on SMTP,
    // and with the same dedupe key shape the worker uses, so a tagger working through fifty
    // photos collapses into one pending notification per person per event.
    await deps.queue.enqueue(
      "email",
      {
        userId: tag.userId,
        eventId: event.id,
        galleryPath: TAG_PAGE_PATH,
        kind: "tagged",
      } satisfies EmailPayload,
      { dedupeKey: `email:tagged:${tag.userId}:${event.id}` },
    );
    return c.json(
      {
        photoId: tag.photoId,
        userId: tag.userId,
        displayName: target.displayName,
        createdAt: tag.createdAt.toISOString(),
      },
      201,
    );
  });

  /**
   * Removal by the tagged person, through the existing `not_me` feedback flow.
   *
   * It writes the same `gallery_feedback` row the gallery's "Non sono io" button writes
   * (`upsertFeedback`, verdict `not_me`) and marks the tag `removed`. Only the tagged person
   * can call it: the tagger's own "undo" is not a thing, because a tag is an assertion about
   * someone else and only that someone else gets to retract it. (A tagger who regrets it can
   * ask the staff; the audit trail has the row.)
   */
  app.delete("/v1/events/:slug/tags/:photoId", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    const photoId = c.req.param("photoId");
    if (!UUID_RE.test(photoId)) throw new ApiError(400, MESSAGES.validation);
    const photo = await deps.db.findPhoto(photoId);
    if (!photo || photo.eventId !== event.id) throw new ApiError(404, MESSAGES.notFound);
    const removed = await deps.db.removePhotoTag(photoId, user.id);
    if (!removed) throw new ApiError(404, MESSAGES.notFound);
    // The reused mechanism: the same row, the same verdict, the same table as the gallery's
    // "Non sono io". `scoreAtTime` is null because a tag has no match score.
    await deps.db.upsertFeedback({
      userId: user.id,
      eventId: event.id,
      photoId,
      verdict: "not_me",
      scoreAtTime: null,
    });
    await auditUntag(deps, {
      actorId: user.id,
      photoId,
      userId: user.id,
      eventId: event.id,
      reason: "not_me",
    });
    return c.json({ photoId, verdict: "not_me" });
  });

  /** Who is tagged in a photo the caller can see. Display names only. */
  app.get("/v1/events/:slug/photos/:photoId/tags", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const event = await loadTagEvent(deps, c.req.param("slug"));
    const photoId = c.req.param("photoId");
    if (!UUID_RE.test(photoId)) throw new ApiError(400, MESSAGES.validation);
    const photo = await visibleTagPhoto(deps, user, event, photoId);
    const rows = await deps.db.listPhotoTags(photo.id);
    return c.json({
      items: rows.map((row) => ({
        photoId: row.photoId,
        userId: row.userId,
        displayName: row.displayName,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });
}

// ---- tagging v6 (agent E): module-level helpers --------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the notification mail points: the participant's tag area in the web app. */
const TAG_PAGE_PATH = "/tag";

/** Keys kept by the in-process tag limiters before they prune. Mirrors routes.ts. */
const TAG_RATE_LIMIT_KEYS_MAX = 20_000;

type TagLimiter = {
  /** True when the call is within `max` hits for `key` in the window, and counts it. */
  allow(key: string, max: number): boolean;
};

/** The same sliding window `routes.ts` uses for registrations, local to the tag routes. */
function createTagLimiter(windowSeconds: number): TagLimiter {
  const hits = new Map<string, number[]>();
  const windowMs = windowSeconds * 1000;
  return {
    allow(key, max) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const kept = (hits.get(key) ?? []).filter((at) => at > cutoff);
      if (kept.length >= max) {
        hits.set(key, kept);
        return false;
      }
      kept.push(now);
      hits.set(key, kept);
      if (hits.size > TAG_RATE_LIMIT_KEYS_MAX) {
        for (const [other, times] of hits) {
          if (times.length === 0 || times[times.length - 1]! <= cutoff) hits.delete(other);
        }
      }
      return true;
    },
  };
}

/**
 * The rate-limit key. The spec says "per session"; the key is the user id, which is strictly
 * tighter — every session of the same account shares one budget, so opening a second tab (or
 * scripting a hundred logins against one account) buys nothing.
 */
function sessionKey(user: UserRow): string {
  return `user:${user.id}`;
}

/** The caller's own opt-in state, in the shape `tagProfileSchema` describes. */
function publicTagProfile(profile: TagProfileRow | null): {
  taggable: boolean;
  displayName: string | null;
  consentTextVersion: string | null;
  consentAt: string | null;
} {
  return {
    taggable: profile?.taggable ?? false,
    displayName: profile?.displayName ?? null,
    consentTextVersion: profile?.consentTextVersion ?? null,
    consentAt: profile?.consentAt?.toISOString() ?? null,
  };
}

async function loadTagEvent(deps: AppDeps, slug: string): Promise<EventRow> {
  const event = await deps.db.findEventBySlug(slug);
  if (!event) throw new ApiError(404, MESSAGES.notFound);
  return event;
}

/**
 * Who belongs at this event, answered from the NON-BIOMETRIC membership record:
 * an `event_members` row, plus the allowlist when `events.access = 'list'`.
 *
 * It deliberately does NOT require an active `consents` row, although the selfie route does.
 * That row is consent to the BIOMETRIC comparison of a face against the event's photos, and
 * tagging is not that: decision 2 freezes that a `crowd` album is never biometric, so a
 * participant whose only involvement is the crowd album never grants recognition consent —
 * and tagging is the only way those people can find themselves in a non-biometric album.
 * Requiring it here made tagging unavailable to exactly the population it is for, and
 * conflated two different legal bases.
 *
 * `event_members.taggable`, with its own Italian text (`TAG_CONSENT_TEXT`) recorded at the
 * opt-in, is the consent for tagging. Do not add a `hasActiveConsent` check back into this
 * function; `apps/api/test/v6-tags.test.ts` has a named regression test that will fail if
 * you do.
 *
 * The allowlist check is kept on top of membership rather than folded into it: `events.access`
 * can be switched to `list` after people have joined, and from that moment the allowlist is
 * the authoritative answer, not the historical membership row.
 */
async function assertEventMember(deps: AppDeps, user: UserRow, event: EventRow): Promise<void> {
  if (!(await deps.db.isEventMember(user.id, event.id))) {
    throw new ApiError(403, MESSAGES.notEventMember);
  }
  if (
    event.access === "list" &&
    !(await deps.db.isEventParticipant(event.id, user.email.toLowerCase()))
  ) {
    throw new ApiError(403, MESSAGES.notOnList);
  }
}

/*
 * ---- FOR THE INTEGRATOR: the other call sites of this check ------------------------------
 *
 * `event_members` (migration 013) is a general primitive, not a tagging one. The same gap it
 * closes here is open in agent C's crowd routes, which are on `v6/crowd` and deliberately not
 * touched from this branch. Their `assertEventMember` (routes.crowd.ts) reads:
 *
 *     if (event.access !== "list") return;
 *     if (!(await deps.db.isEventParticipant(event.id, email.toLowerCase()))) ...
 *
 * so on an `open` event it authorises ANY signed-in participant. Its comment says that is
 * "what the event code already gated (B3)" — but the code gate ran once, at registration, and
 * until migration 013 the event it resolved was never persisted. A participant who registered
 * at event A could therefore upload to event B's crowd album, list its photos and report them.
 *
 * What that function should become, once both branches are merged:
 *
 *     if (!(await deps.db.isEventMember(userId, event.id))) {
 *       throw new ApiError(403, MESSAGES.notEventMember);
 *     }
 *     if (event.access === "list" && !(await deps.db.isEventParticipant(event.id, email))) {
 *       throw new ApiError(403, MESSAGES.notOnList);
 *     }
 *
 * It needs the caller's `user.id`, which it does not take today (it takes only the e-mail).
 * The three call sites are `crowdAlbumForUpload` (behind `uploads/init`, `uploads/:id/parts`
 * and `uploads/:id/complete`), `GET /v1/albums/:albumId/photos` and
 * `POST /v1/photos/:id/report`.
 *
 * Two more places worth a decision, both outside section E:
 *   * `POST /v1/events/:slug/selfie` (routes.ts) gates on a `consents` row, which the 013
 *     backfill maps to membership, so it is already equivalent — but it would read better as
 *     membership plus consent than as consent standing in for membership.
 *   * the crowd upload path should ALSO write a membership row (`source: 'upload'`), so a
 *     participant who arrives by a share link rather than by registration is recorded.
 */

/**
 * A photo the caller may tag on: one they uploaded themselves, or one already in their own
 * personal match gallery. Both are primitives that exist today; album-level visibility is
 * agent C's and agent D's area and is deliberately not second-guessed here. A participant who
 * cannot see a photo cannot tag anyone in it, and cannot read its tag list either.
 */
async function visibleTagPhoto(
  deps: AppDeps,
  user: UserRow,
  event: EventRow,
  photoId: string,
): Promise<PhotoRow> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo || photo.eventId !== event.id) throw new ApiError(404, MESSAGES.notFound);
  if (photo.photographerId === user.id) return photo;
  const owned = await deps.db.listOwnedPhotos(user.id, event.id, [photoId]);
  if (owned.length === 0) throw new ApiError(403, MESSAGES.forbidden);
  return photo;
}

/** One shape for every untag row, whichever path removed the tag. */
async function auditUntag(
  deps: AppDeps,
  input: {
    actorId: string;
    photoId: string;
    userId: string;
    eventId: string;
    reason: "not_me" | "opt_out";
  },
): Promise<void> {
  await deps.db.insertAudit({
    actorId: input.actorId,
    action: "photo.untagged",
    target: `photo:${input.photoId}`,
    meta: { eventId: input.eventId, userId: input.userId, reason: input.reason },
  });
}
