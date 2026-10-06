import sharp from "sharp";
import {
  DEFAULT_MATCH_THRESHOLD,
  objectKeys,
  type EmailPayload,
  type Env,
  type MatchPayload,
  type RetentionPayload,
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

export type WorkerDeps = {
  env: Env;
  db: Database;
  objects: ObjectStore;
  mailer: Mailer;
  queue: JobQueue;
  faces: FaceEngine;
};

export type WorkerJob =
  | { type: "derive"; photoId: string }
  | { type: "index"; photoId: string }
  | ({ type: "match" } & MatchPayload)
  | ({ type: "email" } & EmailPayload)
  | ({ type: "retention" } & RetentionPayload);

export async function runJob(job: WorkerJob, deps: WorkerDeps): Promise<void> {
  if (job.type === "derive") {
    await derivePhoto(job.photoId, deps);
    return;
  }
  if (job.type === "index") {
    await indexPhoto(job.photoId, deps);
    return;
  }
  if (job.type === "match") {
    await matchSelfie(job, deps);
    return;
  }
  if (job.type === "retention") {
    await retainEvent(job, deps);
    return;
  }
  await sendGalleryMail(job, deps);
}

async function derivePhoto(photoId: string, deps: WorkerDeps): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  await deps.db.setPhotoStatus(photo.id, "processing");
  const original = await deps.objects.get(photo.originalKey);
  if (!original) throw new Error("Original missing");
  const thumb = await renderJpeg(original.body, 480);
  const web = await renderJpeg(original.body, 1600);
  const thumbKey = objectKeys.thumb(photo.id);
  const webKey = objectKeys.web(photo.id);
  await deps.objects.put(thumbKey, thumb, "image/jpeg");
  await deps.objects.put(webKey, web, "image/jpeg");
  await deps.db.upsertDerivative({ photoId: photo.id, kind: "thumb", s3Key: thumbKey });
  await deps.db.upsertDerivative({ photoId: photo.id, kind: "web", s3Key: webKey });
  await deps.queue.enqueue("index", { photoId: photo.id });
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
  await deps.db.setPhotoStatus(photo.id, "indexed");
}

async function matchSelfie(job: { type: "match" } & MatchPayload, deps: WorkerDeps): Promise<void> {
  const selfie = await deps.objects.get(job.selfieKey);
  if (!selfie) throw new Error("Selfie object missing");
  const imageBytes = await fitRekognitionJpeg(selfie.body);
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
  const best = new Map<string, { faceId: string; score: number }>();
  for (const hit of hits) {
    const face = faceByExternal.get(hit.externalFaceId);
    if (!face || face.photoId !== hit.photoId) continue;
    const photo = photoById.get(hit.photoId);
    if (!photo || photo.eventId !== job.eventId || photo.status !== "indexed") continue;
    const score = unitInterval(hit.similarity);
    if (score < DEFAULT_MATCH_THRESHOLD) continue;
    const previous = best.get(hit.photoId);
    if (!previous || score > previous.score) {
      best.set(hit.photoId, { faceId: face.id, score });
    }
  }
  const event = await deps.db.findEventById(job.eventId);
  if (!event) throw new Error("Event missing");
  await deps.db.replaceGallery(
    job.userId,
    job.eventId,
    [...best.entries()].map(([photoId, item]) => ({
      photoId,
      faceId: item.faceId,
      score: item.score,
    })),
  );
  await deps.objects.delete(job.selfieKey);
  await deps.queue.enqueue("email", {
    userId: job.userId,
    eventId: job.eventId,
    galleryPath: `/e/${event.slug}`,
  });
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
    subject: "Le tue foto sono pronte",
    text: link,
  });
}

export async function applyFinalFailure(
  job: WorkerJob,
  deps: WorkerDeps,
): Promise<void> {
  if (job.type === "derive" || job.type === "index") {
    const photo = await deps.db.findPhoto(job.photoId);
    if (!photo) return;
    await deps.db.setPhotoStatus(photo.id, "error");
    return;
  }
  if (job.type === "match") {
    await deps.objects.delete(job.selfieKey);
  }
}

async function renderJpeg(
  bytes: Uint8Array,
  maxEdge: number,
  quality = 80,
): Promise<Uint8Array> {
  const rendered = await sharp(Buffer.from(bytes))
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
