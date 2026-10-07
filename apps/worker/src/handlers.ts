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
  type MatchPayload,
  type RetentionPayload,
  type VerifyPayload,
} from "@rephoto/contracts";
import type { Database } from "@rephoto/db";
import type { FaceEngine } from "@rephoto/face-engine/types";
import type { Mailer } from "@rephoto/api/mailer";
import type { ObjectStore } from "@rephoto/api/object-store";
import type { JobQueue } from "@rephoto/api/queue";

/** Rekognition Bytes API rejects images over 5 MB. S3Object allows 15 MB; we send bytes. */
const REKOGNITION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RETENTION_PHOTO_BATCH = 50;
const DELETE_FACES_CHUNK = 1000;
/** Derivatives are immutable per photo id, so browsers may cache them for a day. */
const DERIVATIVE_CACHE_CONTROL = "public, max-age=86400, immutable";
/** Anchors kept per gallery: the external ids of the best distinct-photo hits. */
const ANCHOR_COUNT = 5;
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

export type JobLogEntry = {
  ts: string;
  job: string;
  type: string;
  ms: number;
  outcome: "done" | "requeued" | "retry" | "error" | "invalid";
  error?: string;
  /** `match` only: the selfie failed the engine's liveness check and got an empty gallery. */
  liveness?: "rejected";
};

/** Extra fields a handler wants on its job log line. */
export type JobNote = Pick<JobLogEntry, "liveness">;

export type WorkerDeps = {
  env: Env;
  db: Database;
  objects: ObjectStore;
  mailer: Mailer;
  queue: JobQueue;
  faces: FaceEngine;
  /** One line per finished job. Defaults to a JSON line on stdout. */
  log?: (entry: JobLogEntry) => void;
};

export type WorkerJob =
  | { type: "derive"; photoId: string }
  | { type: "index"; photoId: string }
  | ({ type: "attach" } & AttachPayload)
  | ({ type: "match" } & MatchPayload)
  | ({ type: "email" } & EmailPayload)
  | ({ type: "retention" } & RetentionPayload)
  | ({ type: "verify" } & VerifyPayload);

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
  const existing = await deps.db.listExternalIds(photo.id);
  if (photo.status === "indexed" && existing.length > 0) return;
  const web = await deps.objects.get(objectKeys.web(photo.id));
  if (!web) throw new Error("Web derivative missing");
  const imageBytes =
    web.body.byteLength > REKOGNITION_MAX_IMAGE_BYTES
      ? await fitRekognitionJpeg(web.body)
      : web.body;
  if (existing.length > 0) {
    await deps.faces.deleteFaces(photo.eventId, existing);
  }
  const indexed = await deps.faces.indexPhoto({
    eventId: photo.eventId,
    photoId: photo.id,
    imageBytes,
    contentType: "image/jpeg",
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
 * Adds a freshly indexed photo to the galleries it belongs to: every face of the
 * photo is searched against the event collection, and each hit whose external id
 * anchors a gallery adds this photo to that gallery.
 */
async function attachPhoto(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  const faces = await deps.db.findFaceRowsByPhoto(photo.id);
  if (faces.length === 0) return;
  // Nothing to attach to yet (uploads usually start before the first selfie): skip the searches.
  if ((await deps.db.countAnchoredGalleries(photo.eventId)) === 0) return;
  // hit external id → the face of this photo that matched it, with the best score
  const hitsByExternal = new Map<string, { faceId: string; score: number }>();
  for (const face of faces) {
    const hits = await deps.faces.searchFaces({
      eventId: photo.eventId,
      externalFaceId: face.externalId,
    });
    for (const hit of hits) {
      if (hit.photoId === photo.id) continue;
      const score = unitInterval(hit.similarity);
      if (score < DEFAULT_MATCH_THRESHOLD) continue;
      const previous = hitsByExternal.get(hit.externalFaceId);
      if (!previous || score > previous.score) {
        hitsByExternal.set(hit.externalFaceId, { faceId: face.id, score });
      }
    }
  }
  if (hitsByExternal.size === 0) return;
  const galleries = await deps.db.findGalleriesByAnchors(photo.eventId, [...hitsByExternal.keys()]);
  if (galleries.length === 0) return;
  const event = await deps.db.findEventById(photo.eventId);
  if (!event) throw new Error("Event missing");
  const now = new Date();
  for (const gallery of galleries) {
    let best: { faceId: string; score: number } | null = null;
    for (const anchor of gallery.anchorFaceIds) {
      const hit = hitsByExternal.get(anchor);
      if (hit && (!best || hit.score > best.score)) best = hit;
    }
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

/**
 * Searches the event with the selfie and rebuilds the participant's gallery. With
 * `LIVENESS_CHECK=true` and an engine that can judge liveness, a selfie the engine
 * rejects gets an empty gallery: the "ready" mail still goes out and the UI shows
 * "Nessuna corrispondenza". The selfie object is deleted either way.
 */
async function matchSelfie(
  job: { type: "match" } & MatchPayload,
  deps: WorkerDeps,
): Promise<JobNote | undefined> {
  const selfie = await deps.objects.get(job.selfieKey);
  if (!selfie) throw new Error("Selfie object missing");
  const imageBytes = await fitRekognitionJpeg(selfie.body);
  const event = await deps.db.findEventById(job.eventId);
  if (!event) throw new Error("Event missing");
  const liveness = deps.env.LIVENESS_CHECK ? deps.faces.checkLiveness?.bind(deps.faces) : undefined;
  if (liveness) {
    const verdict = await liveness({ imageBytes, contentType: "image/jpeg" });
    if (verdict.live === false) {
      await deps.db.replaceGallery(job.userId, job.eventId, [], []);
      await deps.objects.delete(job.selfieKey);
      await enqueue(deps, "email", {
        userId: job.userId,
        eventId: job.eventId,
        galleryPath: `/e/${event.slug}`,
        kind: "ready",
      } satisfies EmailPayload);
      return { liveness: "rejected" };
    }
  }
  const hits = await deps.faces.search({
    eventId: job.eventId,
    imageBytes,
    contentType: "image/jpeg",
  });
  const faceRows = await deps.db.findFacesByExternalIds(
    job.eventId,
    hits.map((hit) => hit.externalFaceId),
  );
  const faceByExternal = new Map(faceRows.map((face) => [face.externalId, face]));
  const photos = await deps.db.listPhotosByIds([...new Set(hits.map((hit) => hit.photoId))]);
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  const best = new Map<string, { faceId: string; externalId: string; score: number }>();
  for (const hit of hits) {
    const face = faceByExternal.get(hit.externalFaceId);
    if (!face || face.photoId !== hit.photoId) continue;
    const photo = photoById.get(hit.photoId);
    if (!photo || photo.eventId !== job.eventId || photo.status !== "indexed") continue;
    const score = unitInterval(hit.similarity);
    if (score < DEFAULT_MATCH_THRESHOLD) continue;
    const previous = best.get(hit.photoId);
    if (!previous || score > previous.score) {
      best.set(hit.photoId, { faceId: face.id, externalId: face.externalId, score });
    }
  }
  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
  const anchors = ranked.slice(0, ANCHOR_COUNT).map(([, item]) => item.externalId);
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
  await deps.objects.delete(job.selfieKey);
  await enqueue(deps, "email", {
    userId: job.userId,
    eventId: job.eventId,
    galleryPath: `/e/${event.slug}`,
    kind: "ready",
  } satisfies EmailPayload);
  return undefined;
}

async function retainEvent(
  job: { type: "retention" } & RetentionPayload,
  deps: WorkerDeps,
): Promise<void> {
  const event = await deps.db.findEventById(job.eventId);
  if (!event) return;
  const cutoff = new Date(Date.now() - event.retentionDays * 24 * 60 * 60 * 1000);
  for (;;) {
    const photos = await deps.db.listPhotosCreatedBefore(
      event.id,
      cutoff,
      RETENTION_PHOTO_BATCH,
    );
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
        actorId: job.actorId,
        action: "photo.deleted",
        target: `photo:${photo.id}`,
        meta: { eventId: event.id, retention: true },
      });
    }
  }
  if ((await deps.db.countPhotos(event.id)) === 0) {
    await deps.faces.deleteCollection(event.id);
  }
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
    await deps.objects.delete(job.selfieKey);
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

/** EXIF-oriented JPEG small enough for Rekognition's Bytes API. */
async function fitRekognitionJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  let maxEdge = 2048;
  let quality = 85;
  let rendered = await renderJpeg(bytes, maxEdge, quality);
  while (rendered.byteLength > REKOGNITION_MAX_IMAGE_BYTES && maxEdge > 480) {
    if (quality > 55) quality -= 10;
    else {
      maxEdge = Math.floor(maxEdge * 0.75);
      quality = 80;
    }
    rendered = await renderJpeg(bytes, maxEdge, quality);
  }
  if (rendered.byteLength > REKOGNITION_MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the Rekognition byte limit");
  }
  return rendered;
}

/** Face engine reports 0–100. Gallery score and face confidence are 0–1. */
function unitInterval(value: number): number {
  return value > 1 ? value / 100 : value;
}
