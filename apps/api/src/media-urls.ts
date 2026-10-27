import { objectKeys, type Env } from "@rephoto/contracts";
import type { AppDeps } from "./deps.js";

export type PhotoMediaVariant = "thumb" | "web" | "original";

/** When unset, browsers use presigned S3 URLs; when unset in prod, media goes through the API. */
export function mediaDeliveryViaApi(env: Env): boolean {
  if (env.MEDIA_VIA_API === "true") return true;
  if (env.MEDIA_VIA_API === "false") return false;
  return !env.S3_PUBLIC_ENDPOINT;
}

export function photoMediaPath(photoId: string, variant: PhotoMediaVariant): string {
  return `/v1/media/photos/${photoId}/${variant}`;
}

export function photographerUploadObjectPath(sessionId: string): string {
  return `/v1/uploads/${sessionId}/object`;
}

export function photographerUploadPartPath(sessionId: string, partNumber: number): string {
  return `/v1/uploads/${sessionId}/parts/${partNumber}`;
}

export function crowdUploadObjectPath(albumId: string, sessionId: string): string {
  return `/v1/albums/${albumId}/uploads/${sessionId}/object`;
}

export function crowdUploadPartPath(
  albumId: string,
  sessionId: string,
  partNumber: number,
): string {
  return `/v1/albums/${albumId}/uploads/${sessionId}/parts/${partNumber}`;
}

function variantFromKey(key: string): { photoId: string; variant: PhotoMediaVariant } | null {
  const thumb = /^thumbs\/([0-9a-f-]{36})\.jpg$/i.exec(key);
  if (thumb) return { photoId: thumb[1]!, variant: "thumb" };
  const web = /^web\/([0-9a-f-]{36})\.jpg$/i.exec(key);
  if (web) return { photoId: web[1]!, variant: "web" };
  const original = /^originals\/[0-9a-f-]{36}\/([0-9a-f-]{36})$/i.exec(key);
  if (original) return { photoId: original[1]!, variant: "original" };
  return null;
}

/** Read URL for JSON responses (relative API path or presigned S3 URL). */
export async function objectReadUrl(deps: AppDeps, key: string): Promise<string> {
  if (!key) return `${deps.env.WEB_ORIGIN}/missing`;
  if (!mediaDeliveryViaApi(deps.env)) {
    return deps.objects.presignGet(key);
  }
  const parsed = variantFromKey(key);
  if (parsed) return photoMediaPath(parsed.photoId, parsed.variant);
  return deps.objects.presignGet(key);
}

export async function uploadSinglePutUrl(
  deps: AppDeps,
  sessionId: string,
  objectKey: string,
  contentType: string,
  bytes: number,
): Promise<string> {
  if (!mediaDeliveryViaApi(deps.env)) {
    return deps.objects.presignPut(objectKey, contentType, bytes);
  }
  return photographerUploadObjectPath(sessionId);
}

export async function uploadPartPutUrl(
  deps: AppDeps,
  sessionId: string,
  objectKey: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  if (!mediaDeliveryViaApi(deps.env)) {
    return deps.objects.presignUploadPart(objectKey, uploadId, partNumber);
  }
  return photographerUploadPartPath(sessionId, partNumber);
}

export async function crowdUploadSinglePutUrl(
  deps: AppDeps,
  albumId: string,
  sessionId: string,
  objectKey: string,
  contentType: string,
  bytes: number,
): Promise<string> {
  if (!mediaDeliveryViaApi(deps.env)) {
    return deps.objects.presignPut(objectKey, contentType, bytes);
  }
  return crowdUploadObjectPath(albumId, sessionId);
}

export async function crowdUploadPartPutUrl(
  deps: AppDeps,
  albumId: string,
  sessionId: string,
  objectKey: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  if (!mediaDeliveryViaApi(deps.env)) {
    return deps.objects.presignUploadPart(objectKey, uploadId, partNumber);
  }
  return crowdUploadPartPath(albumId, sessionId, partNumber);
}

export function objectKeyForPhotoVariant(
  photoId: string,
  eventId: string,
  variant: PhotoMediaVariant,
  originalKey: string | null,
): string {
  if (variant === "thumb") return objectKeys.thumb(photoId);
  if (variant === "web") return objectKeys.web(photoId);
  return originalKey ?? objectKeys.original(eventId, photoId);
}
