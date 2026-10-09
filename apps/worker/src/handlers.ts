import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  DEFAULT_MATCH_THRESHOLD,
  jobDedupeKey,
  objectKeys,
  type AttachPayload,
  type EmailPayload,
  type Env,
  type JobType,
  type LivenessAction,
  type MatchPayload,
  type ResetPayload,
  type RetentionPayload,
  type VerifyPayload,
} from "@rephoto/contracts";
import type { Database, EventRow, MatchHitInsert, PhotoRow } from "@rephoto/db";
import type { EmbedSelfieResult, FaceEngine, SearchHit, SelfieFace } from "@rephoto/face-engine/types";
import type { Mailer } from "@rephoto/api/mailer";
import type { ObjectStore } from "@rephoto/api/object-store";
import type { JobQueue } from "@rephoto/api/queue";
import type { FaceServiceBreaker } from "./breaker.js";
import type { FaceServiceGate } from "./face-compat.js";

/** Rekognition Bytes API rejects images over 5 MB. S3Object allows 15 MB; we send bytes. */
const REKOGNITION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The face service refuses bodies above 8 MiB (packages/face-engine/src/insightface.ts). */
const FACE_SERVICE_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DETECTION_JPEG_QUALITY = 85;
const RETENTION_PHOTO_BATCH = 50;
const DELETE_FACES_CHUNK = 1000;
/** Derivatives are immutable per photo id, so browsers may cache them for a day. */
const DERIVATIVE_CACHE_CONTROL = "public, max-age=86400, immutable";
/** Anchors kept per gallery: the external ids of the best distinct-photo hits. */
const ANCHOR_COUNT = 5;
/** With this many anchors or more, an anchor-only attach needs two agreeing anchors. */
const ANCHOR_QUORUM_FROM = 3;
const ANCHOR_QUORUM = 2;
/** MATCH_LOG: the engine is asked for everything down to this cosine; the gallery keeps ≥ MIN. */
const MATCH_LOG_MIN_COSINE = 0.25;
/** A second selfie face at least this fraction of the largest one means "two people". */
const SECOND_FACE_AREA_RATIO = 0.5;
/** A gallery is told about new photos at most once per window. */
const NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Decode bomb guard: sharp refuses inputs above this many pixels (120 MP covers every
 * current camera; a 60 MiB JPEG could otherwise expand to gigabytes of raw pixels).
 */
const MAX_INPUT_PIXELS = 120_000_000;

/** `photos.error` set by `verify`: the uploaded original does not match its declaration, or is gone. */
const SHA_MISMATCH = "sha256 mismatch";
const ORIGINAL_MISSING = "original missing";

const MAIL_SUBJECTS: Record<EmailPayload["kind"], string> = {
  ready: "Le tue foto sono pronte",
  new: "Ci sono nuove foto per te",
  // v6 E (agent E): a tag is a person<->photo link someone else asserted, so the tagged
  // person is told about it. Enqueued by the tag route, sent by `sendGalleryMail` unchanged.
  tagged: "Ti hanno taggato in una foto",
};

/** A failure that retrying cannot fix: the job fails terminally on the first attempt. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Face service answers that retrying cannot change: the bytes are not an image the
 * service accepts (400), too large (413) or the request itself was invalid (422).
 * 5xx and connection failures are `FaceServiceUnavailable` and stay retryable.
 */
const FACE_SERVICE_DEFINITIVE_STATUSES = new Set([400, 413, 422]);

export function isNonRetryable(error: unknown): error is NonRetryableError {
  if (error instanceof NonRetryableError) return true;
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  if (error.name === "NonRetryableError") return true;
  return (
    error.name === "FaceServiceError" &&
    "status" in error &&
    typeof error.status === "number" &&
    FACE_SERVICE_DEFINITIVE_STATUSES.has(error.status)
  );
}

/** Why `match` rejected the selfie before searching (also `galleries.last_match_reason`). */
export type SelfieRejectReason = "no_face" | "face_too_small" | "low_quality" | "multiple_faces";

export type JobLogEntry = {
  ts: string;
  job: string;
  type: string;
  ms: number;
  outcome: "done" | "requeued" | "retry" | "error" | "invalid";
  error?: string;
  /** `match` only: the selfie failed the engine's liveness check and got an empty gallery. */
  liveness?: "rejected";
  /**
   * `match` only: `rejected` = the selfie failed a quality gate (`reason` says which);
   * `withdrawn` = the consent was withdrawn after the job was enqueued (v6 G).
   */
  match?: "rejected" | "withdrawn";
  reason?: SelfieRejectReason;
  /** `match` only: photos in the rebuilt gallery. */
  hits?: number;
  /** With `LOG_IDS=true`: the ids of the job payload. */
  photoId?: string;
  userId?: string;
  eventId?: string;
};

/** Extra fields a handler wants on its job log line. */
export type JobNote = Pick<JobLogEntry, "liveness" | "match" | "reason" | "hits">;

export type WorkerDeps = {
  env: Env;
  db: Database;
  objects: ObjectStore;
  mailer: Mailer;
  queue: JobQueue;
  faces: FaceEngine;
  /** One line per finished job. Defaults to a JSON line on stdout. */
  log?: (entry: JobLogEntry) => void;
  /** Face service circuit breaker; one per process. Absent = no breaker (tests). */
  breaker?: FaceServiceBreaker;
  /** How often an in-flight job refreshes `claimed_at`. Default 2 minutes. */
  heartbeatMs?: number;
  /**
   * v6 hardening H2 (agent H): standing refusal to claim the jobs that post to
   * `/v1/embed?max_faces=` (`index` and `match`) when the face service's build cannot serve
   * what the worker will ask of it (see src/face-compat.ts). Unlike the breaker this does
   * not close by itself — only a new deploy clears it.
   */
  faceGate?: FaceServiceGate;
};

export type WorkerJob =
  | { type: "derive"; photoId: string }
  | { type: "index"; photoId: string }
  | ({ type: "attach" } & AttachPayload)
  | ({ type: "match" } & MatchPayload)
  | ({ type: "email" } & EmailPayload)
  | ({ type: "retention" } & RetentionPayload)
  | ({ type: "verify" } & VerifyPayload)
  | ({ type: "reset" } & ResetPayload);

export async function runJob(job: WorkerJob, deps: WorkerDeps): Promise<JobNote | undefined> {
  if (job.type === "derive") {
    await derivePhoto(job.photoId, deps);
    return;
  }
  if (job.type === "index") {
    await indexPhoto(job.photoId, deps);
    return;
  }
  if (job.type === "attach") {
    await attachPhoto(job.photoId, deps);
    return;
  }
  if (job.type === "match") {
    return matchSelfie(job, deps);
  }
  if (job.type === "retention") {
    await retainEvent(job, deps);
    return;
  }
  if (job.type === "verify") {
    await verifyOriginal(job.photoId, deps);
    return;
  }
  if (job.type === "reset") {
    await resetEvent(job, deps);
    return;
  }
  await sendGalleryMail(job, deps);
}

/** Enqueue with the type's dedupe key, so an active duplicate collapses into one job. */
function enqueue(deps: WorkerDeps, type: JobType, payload: unknown): Promise<string> {
  const dedupeKey = jobDedupeKey(type, payload);
  return deps.queue.enqueue(type, payload, dedupeKey ? { dedupeKey } : undefined);
}

async function derivePhoto(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  await deps.db.setPhotoStatus(photo.id, "processing");
  if (photo.originalStatus === "pending") {
    // Web-first upload: the browser already stored the web derivative; only the thumb is
    // missing. The original's sha256 is checked by `verify` once the original arrives.
    const webKey = objectKeys.web(photo.id);
    const web = await deps.objects.get(webKey);
    if (!web) throw new Error("Web derivative missing");
    let thumb: Uint8Array;
    try {
      thumb = await renderDerivative(web.body, 480);
    } catch (error) {
      // The web object is client-made and never validated by the api: when sharp cannot
      // decode it, it is not an image and must never be served, so drop it with the photo.
      if (isNonRetryable(error)) await deps.objects.delete(webKey);
      throw error;
    }
    const thumbKey = objectKeys.thumb(photo.id);
    await deps.objects.put(thumbKey, thumb, "image/jpeg", { cacheControl: DERIVATIVE_CACHE_CONTROL });
    await deps.db.upsertDerivative({ photoId: photo.id, kind: "thumb", s3Key: thumbKey });
    await enqueue(deps, "index", { photoId: photo.id });
    return;
  }
  const original = await deps.objects.get(photo.originalKey);
  if (!original) throw new Error("Original missing");
  if (sha256Hex(original.body) !== photo.sha256) {
    throw new NonRetryableError("sha256 mismatch");
  }
  const thumb = await renderDerivative(original.body, 480);
  const web = await renderDerivative(original.body, 1600);
  const thumbKey = objectKeys.thumb(photo.id);
  const webKey = objectKeys.web(photo.id);
  await deps.objects.put(thumbKey, thumb, "image/jpeg", { cacheControl: DERIVATIVE_CACHE_CONTROL });
  await deps.objects.put(webKey, web, "image/jpeg", { cacheControl: DERIVATIVE_CACHE_CONTROL });
  await deps.db.upsertDerivative({ photoId: photo.id, kind: "thumb", s3Key: thumbKey });
  await deps.db.upsertDerivative({ photoId: photo.id, kind: "web", s3Key: webKey });
  await enqueue(deps, "index", { photoId: photo.id });
}

/**
 * The original of a web-first photo arrived: check it against what the client declared at
 * the web stage. A mismatch drops the object and reopens the original stage; the photo stays
 * searchable through its web derivative either way.
 */
async function verifyOriginal(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo || photo.originalStatus !== "present") return;
  const original = await deps.objects.get(photo.originalKey);
  if (!original) {
    // The api flipped the status but the object is gone: reopen the original stage so the
    // client sends it again. Nothing to retry here, the bytes will not reappear on their own.
    await deps.db.setOriginalStatus(photo.id, "pending");
    await deps.db.setPhotoErrorText(photo.id, ORIGINAL_MISSING);
    return;
  }
  const matches =
    original.body.byteLength === photo.bytes && sha256Hex(original.body) === photo.sha256;
  if (matches) {
    if (photo.error === SHA_MISMATCH || photo.error === ORIGINAL_MISSING) {
      await deps.db.setPhotoErrorText(photo.id, null);
    }
    return;
  }
  await deps.objects.delete(photo.originalKey);
  await deps.db.setOriginalStatus(photo.id, "pending");
  await deps.db.setPhotoErrorText(photo.id, SHA_MISMATCH);
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      verify: "mismatch",
      photoId: photo.id,
      eventId: photo.eventId,
    }),
  );
}

async function indexPhoto(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  if (photo.originalKey.startsWith("selfies/")) {
    throw new Error("Refusing to index a selfie");
  }
  const album = await deps.db.findAlbum(photo.albumId);
  if (!album) throw new Error("Album missing");
  if (!album.recognition) {
    // v6 (decision 2, second half): an album without recognition is never embedded. No
    // bytes reach the face service, no vector is computed and none is stored; the photo
    // still completes its pipeline so it is served, counted and retained like any other.
    // There is nothing to attach either: no face row exists for it.
    await deps.db.setPhotoIndexed(photo.id);
    return;
  }
  const existing = await deps.db.listExternalIds(photo.id);
  if (photo.status === "indexed" && existing.length > 0) return;
  const imageBytes = await detectionBytes(photo, deps);
  if (existing.length > 0) {
    // Re-index: the old faces leave the engine and every gallery they anchored (v5, A1).
    await deps.faces.deleteFaces(photo.eventId, existing);
    await deps.db.removeAnchors(photo.eventId, existing);
  }
  const indexed = await deps.faces.indexPhoto({
    eventId: photo.eventId,
    photoId: photo.id,
    imageBytes,
    contentType: "image/jpeg",
    albumId: photo.albumId,
  });
  await deps.db.replaceFaces(
    photo.id,
    photo.eventId,
    indexed.map((face) => ({
      externalId: face.externalFaceId,
      bbox: {
        x: face.bbox.left,
        y: face.bbox.top,
        width: face.bbox.width,
        height: face.bbox.height,
      },
      confidence: unitInterval(face.confidence),
    })),
  );
  await deps.db.setPhotoIndexed(photo.id);
  await enqueue(deps, "attach", { photoId: photo.id });
}

/**
 * What `index` sends to the engine (v5, A3). `FACE_INDEX_SOURCE=web`: the stored web
 * derivative (1600 px), shrunk only when it exceeds the Rekognition byte limit.
 * `original`: a detection JPEG rendered from the original (or from the web derivative while
 * the original is pending) at `FACE_DETECT_LONG_EDGE`, so small faces in the back rows
 * survive detection. Nothing is cached: the bytes exist for one request.
 */
async function detectionBytes(photo: PhotoRow, deps: WorkerDeps): Promise<Uint8Array> {
  const web = await deps.objects.get(objectKeys.web(photo.id));
  if (!web) throw new Error("Web derivative missing");
  if (deps.env.FACE_INDEX_SOURCE !== "original") {
    return web.body.byteLength > REKOGNITION_MAX_IMAGE_BYTES
      ? await fitJpeg(web.body, REKOGNITION_MAX_IMAGE_BYTES)
      : web.body;
  }
  let source = web.body;
  if (photo.originalStatus === "present") {
    const original = await deps.objects.get(photo.originalKey);
    if (!original) throw new Error("Original missing");
    source = original.body;
  }
  const maxBytes =
    deps.env.FACE_ENGINE === "rekognition" ? REKOGNITION_MAX_IMAGE_BYTES : FACE_SERVICE_MAX_IMAGE_BYTES;
  try {
    return await fitJpeg(source, maxBytes, deps.env.FACE_DETECT_LONG_EDGE, DETECTION_JPEG_QUALITY);
  } catch (error) {
    if (isDecodeError(error)) throw new NonRetryableError("unsupported image");
    throw error;
  }
}

type AttachCandidate = { faceId: string; score: number };

/**
 * Adds a freshly indexed photo to the galleries it belongs to. Every face of the photo is
 * searched against the event collection: a hit whose external id anchors a gallery is a
 * candidate (cosine ≥ `INSIGHTFACE_ATTACH_MIN_COSINE`); so is every gallery whose stored
 * selfie vector is close enough to the face (`INSIGHTFACE_MIN_COSINE`), which covers
 * participants who scanned before any of their photos were uploaded (v5, A1).
 */
async function attachPhoto(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  // v6: an album without recognition holds no vector, so there is nothing to attach from.
  const album = await deps.db.findAlbum(photo.albumId);
  if (!album?.recognition) return;
  const faces = await deps.db.findFaceRowsByPhoto(photo.id);
  if (faces.length === 0) return;
  // Nothing to attach to yet (uploads usually start before the first selfie): skip the searches.
  if ((await deps.db.countAnchoredGalleries(photo.eventId)) === 0) return;
  const env = deps.env;
  // The selfie-vector path costs one engine read and one pgvector query per face: only when
  // some gallery of the event actually stores a vector.
  const faceEmbedding =
    deps.faces.faceEmbedding && (await deps.db.countGalleriesWithQueryVector(photo.eventId)) > 0
      ? deps.faces.faceEmbedding.bind(deps.faces)
      : undefined;
  // hit external id → the face of this photo that matched it, with the best score
  const hitsByExternal = new Map<string, AttachCandidate>();
  // gallery id → the best selfie-vector candidate among this photo's faces
  const queryCandidates = new Map<string, AttachCandidate & { gallery: GalleryRef }>();
  for (const face of faces) {
    const hits = await deps.faces.searchFaces({
      eventId: photo.eventId,
      externalFaceId: face.externalId,
      albumIds: [photo.albumId],
    });
    for (const hit of hits) {
      if (hit.photoId === photo.id) continue;
      const score = unitInterval(hit.similarity);
      const accepted =
        hit.cosine === undefined
          ? score >= DEFAULT_MATCH_THRESHOLD
          : hit.cosine >= env.INSIGHTFACE_ATTACH_MIN_COSINE;
      if (!accepted) continue;
      const previous = hitsByExternal.get(hit.externalFaceId);
      if (!previous || score > previous.score) {
        hitsByExternal.set(hit.externalFaceId, { faceId: face.id, score });
      }
    }
    if (!faceEmbedding) continue;
    const embedding = await faceEmbedding({ eventId: photo.eventId, externalFaceId: face.externalId });
    if (!embedding) continue;
    const galleries = await deps.db.findGalleriesByQueryVector(
      photo.eventId,
      embedding,
      env.INSIGHTFACE_MIN_COSINE,
    );
    for (const gallery of galleries) {
      const score = cosineScore(gallery.cosine, env);
      const previous = queryCandidates.get(gallery.id);
      if (!previous || score > previous.score) {
        queryCandidates.set(gallery.id, { faceId: face.id, score, gallery });
      }
    }
  }
  const byGallery = new Map<string, GalleryRef>();
  for (const candidate of queryCandidates.values()) byGallery.set(candidate.gallery.id, candidate.gallery);
  if (hitsByExternal.size > 0) {
    const anchored = await deps.db.findGalleriesByAnchors(photo.eventId, [...hitsByExternal.keys()]);
    for (const gallery of anchored) byGallery.set(gallery.id, gallery);
  }
  if (byGallery.size === 0) return;
  const event = await deps.db.findEventById(photo.eventId);
  if (!event) throw new Error("Event missing");
  const now = new Date();
  for (const gallery of byGallery.values()) {
    let anchorBest: AttachCandidate | null = null;
    let agreeing = 0;
    for (const anchor of gallery.anchorFaceIds) {
      const hit = hitsByExternal.get(anchor);
      if (!hit) continue;
      agreeing += 1;
      if (!anchorBest || hit.score > anchorBest.score) anchorBest = hit;
    }
    // Many anchors but only one of them agrees: too weak on its own.
    if (gallery.anchorFaceIds.length >= ANCHOR_QUORUM_FROM && agreeing < ANCHOR_QUORUM) anchorBest = null;
    const queryBest = queryCandidates.get(gallery.id) ?? null;
    const best =
      anchorBest && queryBest
        ? anchorBest.score >= queryBest.score
          ? anchorBest
          : queryBest
        : (anchorBest ?? queryBest);
    if (!best) continue;
    const inserted = await deps.db.addGalleryItems(gallery.id, [
      { photoId: photo.id, faceId: best.faceId, score: best.score, source: "attach" },
    ]);
    if (inserted === 0) continue;
    const notifiedAt = gallery.notifiedAt?.getTime() ?? 0;
    if (now.getTime() - notifiedAt < NOTIFY_WINDOW_MS) continue;
    await enqueue(deps, "email", {
      userId: gallery.userId,
      eventId: event.id,
      galleryPath: `/e/${event.slug}`,
      kind: "new",
    } satisfies EmailPayload);
    await deps.db.markGalleryNotified(gallery.id, now);
  }
}

type GalleryRef = { id: string; userId: string; anchorFaceIds: string[]; notifiedAt: Date | null };

type MatchContext = {
  job: { type: "match" } & MatchPayload;
  event: EventRow;
  selfieSha256: string;
  liveness: string | null;
};

/**
 * Searches the event with the selfie and rebuilds the participant's gallery (v5, A1).
 * With `LIVENESS_CHECK=true` and an engine that can judge liveness, a rejected selfie gets
 * an empty gallery with reason `liveness` (the "ready" mail still goes out). With
 * `LIVENESS_REQUIRED=true` the check fails closed (v4 report F05): only a genuine positive
 * verdict serves a gallery; a missing model, an unavailable service or a non-live verdict
 * all reject. With an engine
 * that embeds selfies, the selfie is gated (no face, too small, low quality, two people)
 * before any search: a rejected selfie gets an empty gallery, a reason and no mail. On a
 * successful match the selfie vector is stored on the gallery so later uploads attach even
 * when nothing matched yet (`no_photos_yet`). The selfie object is deleted unless
 * `KEEP_SELFIES=true`, in which case its key is recorded on the gallery and the object kept
 * by the previous run (if any, and if different) is deleted so no selfie goes untracked.
 */
async function matchSelfie(
  job: { type: "match" } & MatchPayload,
  deps: WorkerDeps,
): Promise<JobNote | undefined> {
  // v6 G: the api requires an active consent before it accepts a selfie, but the job may sit
  // in the queue (or be re-enqueued by an admin rematch) while the participant withdraws.
  // Without this check the `match` would rebuild the gallery and store a new selfie vector
  // right after the withdrawal deleted both.
  //
  // The test is "withdrawn and not renewed", not "has an active consent": consent presence is
  // the api's gate, and a job for a user with no consent row at all is a pre-v6 fixture or an
  // operator action, not a withdrawal. A re-consent (a new row) lets the match run again.
  const consent = await deps.db.findConsentState(job.userId, job.eventId);
  if (consent.grantedAt === null && consent.withdrawnAt !== null) {
    await deps.objects.delete(job.selfieKey);
    return { match: "withdrawn" };
  }
  const selfie = await deps.objects.get(job.selfieKey);
  if (!selfie) throw new Error("Selfie object missing");
  const previousSelfieKey = await keptSelfieKey(job, deps);
  const imageBytes = await fitJpeg(selfie.body, REKOGNITION_MAX_IMAGE_BYTES);
  const event = await deps.db.findEventById(job.eventId);
  if (!event) throw new Error("Event missing");
  const context: MatchContext = { job, event, selfieSha256: sha256Hex(selfie.body), liveness: null };
  const rejectLiveness = async (): Promise<JobNote> => {
    context.liveness = "rejected";
    await emptyGallery(context, deps, "liveness", null, previousSelfieKey);
    await logMatchRun(context, deps, { reason: "liveness", selfieFaces: null, engineMs: null, hits: [] });
    await enqueue(deps, "email", {
      userId: job.userId,
      eventId: job.eventId,
      galleryPath: `/e/${event.slug}`,
      kind: "ready",
    } satisfies EmailPayload);
    return { liveness: "rejected" };
  };

  // v4 report F05: when challenge-response is on and this job carries a challenge, the
  // challenge IS the liveness proof — the worker verifies the server-dictated head-turn
  // sequence and that every frame is the same person before any search. Anything off rejects.
  const challengeMode =
    deps.env.LIVENESS_CHALLENGE && !!job.challengeId && !!job.frameKeys && job.frameKeys.length > 0;
  let challengeFrontal: EmbedSelfieResult | null = null;
  if (challengeMode) {
    const outcome = await verifyChallenge(job, deps);
    if (!outcome.ok) return rejectLiveness();
    challengeFrontal = outcome.frontal;
  }

  // Passive anti-spoofing (legacy / defense in depth). Skipped in challenge mode: the
  // challenge already proves liveness, so a missing passive model must not block a match.
  // Fails closed when LIVENESS_REQUIRED is set: a missing model (method "none"), an
  // unavailable service or a non-live verdict all reject, instead of a lenient fall-through.
  const required = deps.env.LIVENESS_REQUIRED && !challengeMode;
  const liveness =
    !challengeMode && (deps.env.LIVENESS_CHECK || required)
      ? deps.faces.checkLiveness?.bind(deps.faces)
      : undefined;
  if (required && !liveness) {
    // Required but the engine cannot judge liveness at all: never serve the gallery.
    return rejectLiveness();
  }
  if (liveness) {
    const verdict = await liveness({ imageBytes, contentType: "image/jpeg" });
    const live = required
      ? verdict.live === true && verdict.method !== "none"
      : verdict.live !== false;
    context.liveness = live ? "live" : "rejected";
    if (!live) return rejectLiveness();
  }
  const embedSelfie = deps.faces.embedSelfie?.bind(deps.faces);
  const searchByVector = deps.faces.searchByVector?.bind(deps.faces);
  // v6: only albums with recognition hold vectors, and the search is restricted to them so
  // the album filter is served by an index instead of applied after it (A3).
  const albumIds = await deps.db.listRecognitionAlbumIds(job.eventId);
  const started = Date.now();
  let hits: SearchHit[];
  let queryEmbedding: number[] | null = null;
  let selfieFaces: number | null = null;
  if (embedSelfie && searchByVector) {
    // Reuse the frontal frame already embedded during challenge verification.
    const embedded = challengeFrontal ?? (await embedSelfie({ imageBytes, contentType: "image/jpeg" }));
    selfieFaces = embedded.faces.length;
    const reason = selfieRejectReason(embedded, deps.env);
    if (reason) {
      await emptyGallery(context, deps, reason, null, previousSelfieKey);
      await logMatchRun(context, deps, { reason, selfieFaces, engineMs: Date.now() - started, hits: [] });
      return { match: "rejected", reason };
    }
    const largest = largestFace(embedded.faces);
    if (!largest) throw new Error("Selfie face missing after the gate");
    queryEmbedding = largest.embedding;
    hits = await searchByVector({
      eventId: job.eventId,
      embedding: queryEmbedding,
      minCosine: deps.env.MATCH_LOG ? MATCH_LOG_MIN_COSINE : deps.env.INSIGHTFACE_MIN_COSINE,
      albumIds,
    });
  } else {
    hits = await deps.faces.search({
      eventId: job.eventId,
      imageBytes,
      contentType: "image/jpeg",
      albumIds,
    });
  }
  const engineMs = Date.now() - started;
  const faceRows = await deps.db.findFacesByExternalIds(
    job.eventId,
    hits.map((hit) => hit.externalFaceId),
  );
  const faceByExternal = new Map(faceRows.map((face) => [face.externalId, face]));
  const photos = await deps.db.listPhotosByIds([...new Set(hits.map((hit) => hit.photoId))]);
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  type Best = { faceId: string; externalId: string; score: number; cosine: number | undefined };
  const best = new Map<string, Best>();
  for (const hit of hits) {
    const face = faceByExternal.get(hit.externalFaceId);
    if (!face || face.photoId !== hit.photoId) continue;
    const photo = photoById.get(hit.photoId);
    if (!photo || photo.eventId !== job.eventId || photo.status !== "indexed") continue;
    const score = unitInterval(hit.similarity);
    const accepted =
      hit.cosine === undefined
        ? score >= DEFAULT_MATCH_THRESHOLD
        : hit.cosine >= deps.env.INSIGHTFACE_MIN_COSINE;
    if (!accepted) continue;
    const previous = best.get(hit.photoId);
    if (!previous || score > previous.score || (score === previous.score && (hit.cosine ?? 0) > (previous.cosine ?? 0))) {
      best.set(hit.photoId, { faceId: face.id, externalId: face.externalId, score, cosine: hit.cosine });
    }
  }
  const ranked = [...best.entries()].sort(
    (a, b) => b[1].score - a[1].score || (b[1].cosine ?? 0) - (a[1].cosine ?? 0),
  );
  // Anchors: only sure hits (cosine ≥ ANCHOR_MIN); engines without a cosine keep the top five.
  const anchors = ranked
    .filter(([, item]) => item.cosine === undefined || item.cosine >= deps.env.INSIGHTFACE_ANCHOR_MIN_COSINE)
    .slice(0, ANCHOR_COUNT)
    .map(([, item]) => item.externalId);
  await deps.db.replaceGallery(
    job.userId,
    job.eventId,
    ranked.map(([photoId, item]) => ({
      photoId,
      faceId: item.faceId,
      score: item.score,
    })),
    anchors,
  );
  await deps.db.updateGalleryMatch(job.userId, job.eventId, {
    queryEmbedding,
    lastMatchReason: ranked.length === 0 ? "no_photos_yet" : null,
    selfieKey: deps.env.KEEP_SELFIES ? job.selfieKey : null,
  });
  const kept = new Map(ranked.map(([photoId, item]) => [photoId, item.externalId]));
  await logMatchRun(context, deps, {
    reason: ranked.length === 0 ? "no_photos_yet" : null,
    selfieFaces,
    engineMs,
    hits: hits.map((hit) => ({
      photoId: hit.photoId,
      externalFaceId: hit.externalFaceId,
      cosine: hit.cosine ?? unitInterval(hit.similarity),
      similarity: unitInterval(hit.similarity),
      kept: kept.get(hit.photoId) === hit.externalFaceId,
    })),
  });
  await settleSelfie(job, deps, previousSelfieKey);
  await enqueue(deps, "email", {
    userId: job.userId,
    eventId: job.eventId,
    galleryPath: `/e/${event.slug}`,
    kind: "ready",
  } satisfies EmailPayload);
  return { hits: ranked.length };
}

type ChallengeOutcome = { ok: true; frontal: EmbedSelfieResult } | { ok: false };

/**
 * Verifies a challenge-response submission (v4 report F05). The challenge is consumed once
 * (atomic), then every frame must hold exactly one face whose yaw matches the server-dictated
 * action, and every frame must be the same identity as the frontal frame. Returns the frontal
 * embedding for the match on success. The non-frontal frames are always deleted here; the
 * frontal frame is `job.selfieKey`, left for the normal selfie bookkeeping.
 */
async function verifyChallenge(
  job: { type: "match" } & MatchPayload,
  deps: WorkerDeps,
): Promise<ChallengeOutcome> {
  const embedSelfie = deps.faces.embedSelfie?.bind(deps.faces);
  const frameKeys = job.frameKeys ?? [];
  const turnKeys = frameKeys.slice(0, -1); // all but the frontal (frontal = job.selfieKey)
  const cleanup = async (): Promise<void> => {
    for (const key of turnKeys) await deps.objects.delete(key);
  };
  const fail = async (): Promise<ChallengeOutcome> => {
    await cleanup();
    return { ok: false };
  };
  if (!embedSelfie || !job.challengeId || frameKeys.length === 0) return fail();
  const challenge = await deps.db.findLivenessChallenge(job.challengeId);
  if (
    !challenge ||
    challenge.userId !== job.userId ||
    challenge.eventId !== job.eventId ||
    challenge.expiresAt.getTime() <= Date.now() ||
    challenge.actions.length !== frameKeys.length
  ) {
    return fail();
  }
  // One-shot: a lost race (already consumed) or a reused challenge fails closed.
  if (!(await deps.db.consumeLivenessChallenge(job.challengeId))) return fail();

  const frames: { action: LivenessAction; embedding: number[] }[] = [];
  let frontal: EmbedSelfieResult | null = null;
  let frontalEmbedding: number[] | null = null;
  for (let i = 0; i < frameKeys.length; i += 1) {
    const action = challenge.actions[i]!;
    const obj = await deps.objects.get(frameKeys[i]!);
    if (!obj) return fail();
    // Original bytes: the face service reads yaw from the frame as captured, and the frames
    // are already size-capped at upload (SELFIE_MAX_BYTES), so no re-encode is needed.
    const contentType = obj.contentType === "image/png" ? "image/png" : "image/jpeg";
    const embedded = await embedSelfie({ imageBytes: obj.body, contentType });
    if (embedded.faces.length !== 1) return fail(); // exactly one live face per frame
    const face = largestFace(embedded.faces);
    if (!face || !yawMatchesAction(action, face.yaw ?? null, deps.env)) return fail();
    frames.push({ action, embedding: face.embedding });
    if (action === "front") {
      frontal = embedded;
      frontalEmbedding = face.embedding;
    }
  }
  if (!frontal || !frontalEmbedding) return fail();
  // Identity consistency: no spliced victim photo — every turn frame is the frontal's person.
  for (const frame of frames) {
    if (frame.embedding === frontalEmbedding) continue;
    if (cosineSimilarity(frame.embedding, frontalEmbedding) < deps.env.LIVENESS_IDENTITY_MIN_COSINE) {
      return fail();
    }
  }
  await cleanup();
  return { ok: true, frontal };
}

/** Face-service yaw ([-1,1], positive = subject's own left) satisfies the dictated action. */
function yawMatchesAction(action: LivenessAction, yaw: number | null, env: Env): boolean {
  if (yaw === null || !Number.isFinite(yaw)) return false;
  switch (action) {
    case "left":
      return yaw >= env.LIVENESS_TURN_MIN_YAW;
    case "right":
      return yaw <= -env.LIVENESS_TURN_MIN_YAW;
    case "front":
      return Math.abs(yaw) <= env.LIVENESS_FRONT_MAX_YAW;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Empty gallery + reason; the selfie is deleted unless KEEP_SELFIES keeps it for inspection. */
async function emptyGallery(
  context: MatchContext,
  deps: WorkerDeps,
  reason: SelfieRejectReason | "liveness",
  queryEmbedding: number[] | null,
  previousSelfieKey: string | null,
): Promise<void> {
  const { job } = context;
  await deps.db.replaceGallery(job.userId, job.eventId, [], []);
  await deps.db.updateGalleryMatch(job.userId, job.eventId, {
    queryEmbedding,
    lastMatchReason: reason,
    selfieKey: deps.env.KEEP_SELFIES ? job.selfieKey : null,
  });
  await settleSelfie(job, deps, previousSelfieKey);
}

/**
 * KEEP_SELFIES: the selfie object the gallery currently tracks, when it is not the one of
 * this job (a rematch reuses the stored key). Null otherwise, and always when selfies are
 * not kept.
 */
async function keptSelfieKey(job: MatchPayload, deps: WorkerDeps): Promise<string | null> {
  if (!deps.env.KEEP_SELFIES) return null;
  const gallery = await deps.db.findGalleryByUser(job.userId, job.eventId);
  const key = gallery?.selfieKey ?? null;
  return key !== null && key !== job.selfieKey ? key : null;
}

/**
 * After the gallery records this job's selfie: without KEEP_SELFIES the object goes; with it,
 * the previously kept object (now untracked) goes instead.
 */
async function settleSelfie(
  job: MatchPayload,
  deps: WorkerDeps,
  previousSelfieKey: string | null,
): Promise<void> {
  if (!deps.env.KEEP_SELFIES) {
    await deps.objects.delete(job.selfieKey);
    return;
  }
  if (previousSelfieKey) await deps.objects.delete(previousSelfieKey);
}

async function logMatchRun(
  context: MatchContext,
  deps: WorkerDeps,
  run: { reason: string | null; selfieFaces: number | null; engineMs: number | null; hits: MatchHitInsert[] },
): Promise<void> {
  if (!deps.env.MATCH_LOG) return;
  const runId = await deps.db.insertMatchRun({
    userId: context.job.userId,
    eventId: context.job.eventId,
    liveness: context.liveness,
    reason: run.reason,
    selfieSha256: context.selfieSha256,
    selfieFaces: run.selfieFaces,
    engineMs: run.engineMs,
    hits: run.hits.length,
  });
  await deps.db.insertMatchHits(runId, run.hits);
}

/**
 * The selfie gate (v5, A1): no face, largest face long edge below `SELFIE_MIN_FACE_PX`
 * (in the pixels of the image the engine saw; skipped when the engine does not report a
 * size), quality below `SELFIE_MIN_QUALITY`, or a second face at least half the area of
 * the largest one.
 */
export function selfieRejectReason(
  embedded: EmbedSelfieResult,
  env: Pick<Env, "SELFIE_MIN_FACE_PX" | "SELFIE_MIN_QUALITY">,
): SelfieRejectReason | null {
  const largest = largestFace(embedded.faces);
  if (!largest) return "no_face";
  if (embedded.width > 0 && embedded.height > 0) {
    const longEdge = Math.max(largest.bbox.width * embedded.width, largest.bbox.height * embedded.height);
    if (longEdge < env.SELFIE_MIN_FACE_PX) return "face_too_small";
  }
  if (largest.quality < env.SELFIE_MIN_QUALITY) return "low_quality";
  const largestArea = faceArea(largest);
  for (const face of embedded.faces) {
    if (face === largest) continue;
    if (faceArea(face) >= SECOND_FACE_AREA_RATIO * largestArea) return "multiple_faces";
  }
  return null;
}

function faceArea(face: SelfieFace): number {
  return Math.max(0, face.bbox.width) * Math.max(0, face.bbox.height);
}

function largestFace(faces: readonly SelfieFace[]): SelfieFace | undefined {
  let best: SelfieFace | undefined;
  let bestArea = -1;
  for (const face of faces) {
    const area = faceArea(face);
    if (area > bestArea) {
      best = face;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Gallery score (0..1) of a raw cosine, the same mapping the InsightFace engine uses:
 * `MIN` ↔ 0.8, `SURE` ↔ 1.
 */
function cosineScore(
  cosine: number,
  env: Pick<Env, "INSIGHTFACE_MIN_COSINE" | "INSIGHTFACE_SURE_COSINE">,
): number {
  const span = env.INSIGHTFACE_SURE_COSINE - env.INSIGHTFACE_MIN_COSINE;
  const t = span > 0 ? (cosine - env.INSIGHTFACE_MIN_COSINE) / span : 1;
  return 0.8 + 0.2 * Math.min(1, Math.max(0, t));
}

/**
 * Retention of one event (v6 G: album-aware).
 *
 * `events.retention_days` is the event's clock; since migration 009 an album may set its own
 * `albums.retention_days`, shorter (a crowd album kept for a week) or longer. Every photo
 * belongs to exactly one album (`photos.album_id`, not null since 009), so the pass runs per
 * album with `album.retentionDays ?? event.retentionDays`. A crowd album needs nothing
 * special: it holds no vector at all, and `deletePhotosBefore` finds none to delete.
 *
 * The event-wide pass stays as the fallback for a database where the albums of an event are
 * somehow missing: without it a failed 009 backfill would silently mean no retention at all.
 */
async function retainEvent(
  job: { type: "retention" } & RetentionPayload,
  deps: WorkerDeps,
): Promise<void> {
  const event = await deps.db.findEventById(job.eventId);
  if (!event) return;
  const now = Date.now();
  const cutoffOf = (days: number): Date => new Date(now - days * 24 * 60 * 60 * 1000);
  const cutoff = cutoffOf(event.retentionDays);
  const albums = await deps.db.listAlbums(event.id);
  if (albums.length === 0) {
    await deletePhotosBefore(
      event,
      cutoff,
      job.actorId,
      { retention: true, scheduled: job.actorId === null },
      deps,
    );
  }
  for (const album of albums) {
    const days = album.retentionDays ?? event.retentionDays;
    await deletePhotosBefore(
      event,
      cutoffOf(days),
      job.actorId,
      { retention: true, albumId: album.id, retentionDays: days, scheduled: job.actorId === null },
      deps,
      album.id,
    );
  }
  // Galleries matched before the cutoff lose their biometric part (selfie vector, anchors)
  // and the kept selfie object, if any: the match itself is as old as the photos it found.
  for (const key of await deps.db.expireGalleryMatches(event.id, cutoff)) {
    await deps.objects.delete(key);
  }
  if ((await deps.db.countPhotos(event.id)) === 0) {
    await deps.faces.deleteCollection(event.id);
  }
}

/**
 * `reset` (v5, D): the event goes back to empty. Every photo leaves through the retention
 * loop (faces, anchors, objects, rows, one audit row per photo), then the galleries, the
 * match log and the engine collection are dropped, and so are the selfie objects kept with
 * `KEEP_SELFIES` (`galleries.selfie_key`). Participants and photographers stay.
 */
async function resetEvent(job: { type: "reset" } & ResetPayload, deps: WorkerDeps): Promise<void> {
  const event = await deps.db.findEventById(job.eventId);
  if (!event) return;
  // One second ahead of `now`: a photo inserted in the same millisecond must go too.
  const cutoff = new Date(Date.now() + 1000);
  const photos = await deletePhotosBefore(event, cutoff, job.actorId, { reset: true }, deps);
  for (const key of await deps.db.listGallerySelfieKeys(event.id)) {
    await deps.objects.delete(key);
  }
  const galleries = await deps.db.deleteGalleriesByEvent(event.id);
  const matchRuns = await deps.db.deleteMatchRunsByEvent(event.id);
  await deps.faces.deleteCollection(event.id);
  await deps.db.insertAudit({
    actorId: job.actorId,
    action: "event.reset",
    target: `event:${event.id}`,
    meta: { photos, galleries, matchRuns },
  });
}

/**
 * Deletes the photos created before `cutoff`, in batches; returns how many. With `albumId`
 * only that album's photos are considered (v6 G: `albums.retention_days`), otherwise the
 * whole event's.
 */
async function deletePhotosBefore(
  event: EventRow,
  cutoff: Date,
  actorId: string | null,
  auditMeta: Record<string, unknown>,
  deps: WorkerDeps,
  albumId?: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const photos = albumId
      ? await deps.db.listAlbumPhotosCreatedBefore(albumId, cutoff, RETENTION_PHOTO_BATCH)
      : await deps.db.listPhotosCreatedBefore(event.id, cutoff, RETENTION_PHOTO_BATCH);
    if (photos.length === 0) break;
    const photoIds = photos.map((photo) => photo.id);
    const externalIds = await deps.db.listExternalIdsForPhotos(photoIds);
    for (let offset = 0; offset < externalIds.length; offset += DELETE_FACES_CHUNK) {
      await deps.faces.deleteFaces(
        event.id,
        externalIds.slice(offset, offset + DELETE_FACES_CHUNK),
      );
    }
    if (externalIds.length > 0) {
      await deps.db.removeAnchors(event.id, externalIds);
    }
    const keys = [
      ...photos.map((photo) => photo.originalKey),
      ...(await deps.db.listDerivativeKeys(photoIds)),
    ];
    for (const key of keys) {
      await deps.objects.delete(key);
    }
    for (const photo of photos) {
      await deps.db.deletePhoto(photo.id);
      await deps.db.insertAudit({
        actorId,
        action: "photo.deleted",
        target: `photo:${photo.id}`,
        meta: { eventId: event.id, ...auditMeta },
      });
      deleted += 1;
    }
  }
  return deleted;
}

async function sendGalleryMail(
  job: { type: "email" } & EmailPayload,
  deps: WorkerDeps,
): Promise<void> {
  const user = await deps.db.findUserById(job.userId);
  if (!user) throw new Error("User missing");
  const origin = deps.env.WEB_ORIGIN.replace(/\/$/, "");
  const link = `${origin}${job.galleryPath}`;
  await deps.mailer.send({
    to: user.email,
    subject: MAIL_SUBJECTS[job.kind],
    text: link,
  });
}

/** Runs once a job has failed for good. `reason` is the last error text. */
export async function applyFinalFailure(
  job: WorkerJob,
  deps: WorkerDeps,
  reason: string,
): Promise<void> {
  if (job.type === "derive" || job.type === "index") {
    const photo = await deps.db.findPhoto(job.photoId);
    if (!photo) return;
    await deps.db.setPhotoError(photo.id, reason);
    return;
  }
  if (job.type === "match") {
    if (!deps.env.KEEP_SELFIES) {
      await deps.objects.delete(job.selfieKey);
      return;
    }
    // Kept for inspection: record it on the gallery (and drop the previously kept object) so
    // the admin tooling, `reset` and retention can find it.
    const previousSelfieKey = await keptSelfieKey(job, deps);
    await deps.db.updateGalleryMatch(job.userId, job.eventId, { selfieKey: job.selfieKey });
    await settleSelfie(job, deps, previousSelfieKey);
  }
  // `verify`: nothing to undo; the photo keeps serving its web derivative.
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decode failures are permanent: the bytes will not become an image on retry. */
async function renderDerivative(bytes: Uint8Array, maxEdge: number): Promise<Uint8Array> {
  try {
    return await renderJpeg(bytes, maxEdge);
  } catch (error) {
    if (isDecodeError(error)) throw new NonRetryableError("unsupported image");
    throw error;
  }
}

function isDecodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported image format|Input buffer|Input file|VipsJpeg|VipsPng|premature end|corrupt|pixel limit/i.test(
    message,
  );
}

async function renderJpeg(
  bytes: Uint8Array,
  maxEdge: number,
  quality = 80,
): Promise<Uint8Array> {
  const rendered = await sharp(Buffer.from(bytes), { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer();
  return new Uint8Array(rendered);
}

/**
 * EXIF-oriented JPEG at most `maxEdge` long and under `maxBytes`: the quality drops first,
 * then the edge, until it fits. Used for selfies (Rekognition's 5 MB) and detection images.
 */
async function fitJpeg(
  bytes: Uint8Array,
  maxBytes: number,
  maxEdge = 2048,
  quality = 85,
): Promise<Uint8Array> {
  let rendered = await renderJpeg(bytes, maxEdge, quality);
  while (rendered.byteLength > maxBytes && maxEdge > 480) {
    if (quality > 55) quality -= 10;
    else {
      maxEdge = Math.floor(maxEdge * 0.75);
      quality = 80;
    }
    rendered = await renderJpeg(bytes, maxEdge, quality);
  }
  if (rendered.byteLength > maxBytes) {
    throw new Error("Image exceeds the engine byte limit");
  }
  return rendered;
}

/** Face engine reports 0–100. Gallery score and face confidence are 0–1. */
function unitInterval(value: number): number {
  return value > 1 ? value / 100 : value;
}
