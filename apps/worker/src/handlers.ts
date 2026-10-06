import sharp from "sharp";
import {
  DEFAULT_MATCH_THRESHOLD,
  objectKeys,
  type EmailPayload,
  type Env,
  type MatchPayload,
} from "@rephoto/contracts";
import type { Database } from "@rephoto/db";
import type { FaceEngine, ImageContentType } from "@rephoto/face-engine/types";
import type { Mailer } from "@rephoto/api/mailer";
import type { ObjectStore } from "@rephoto/api/object-store";
import type { JobQueue } from "@rephoto/api/queue";

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
  | ({ type: "email" } & EmailPayload);

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
  const original = await deps.objects.get(photo.originalKey);
  if (!original) throw new Error("Original missing");
  const indexed = await deps.faces.indexPhoto({
    eventId: photo.eventId,
    photoId: photo.id,
    imageBytes: original.body,
    contentType: photo.contentType,
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
  const hits = await deps.faces.search({
    eventId: job.eventId,
    imageBytes: selfie.body,
    contentType: asImageType(selfie.contentType),
  });
  const best = new Map<string, { faceId: string; score: number }>();
  for (const hit of hits) {
    const face = await deps.db.findFaceByExternalId(job.eventId, hit.externalFaceId);
    if (!face || face.photoId !== hit.photoId) continue;
    const photo = await deps.db.findPhoto(hit.photoId);
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

async function renderJpeg(bytes: Uint8Array, maxEdge: number): Promise<Uint8Array> {
  const rendered = await sharp(Buffer.from(bytes))
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  return new Uint8Array(rendered);
}

function asImageType(value: string): ImageContentType {
  const contentType = value.split(";")[0]?.trim();
  if (contentType === "image/jpeg" || contentType === "image/png") return contentType;
  throw new Error("Unsupported image content type");
}

/** Face engine reports 0–100. Gallery score and face confidence are 0–1. */
function unitInterval(value: number): number {
  return value > 1 ? value / 100 : value;
}
