import type { Database } from "@rephoto/db";
import type { FaceEngine } from "@rephoto/face-engine/types";
import type { ObjectStore } from "./object-store.js";

export async function purgePhoto(
  deps: { db: Database; objects: ObjectStore; faces: FaceEngine },
  photoId: string,
): Promise<void> {
  const photo = await deps.db.findPhoto(photoId);
  if (!photo) return;
  const externalIds = await deps.db.listExternalIds(photo.id);
  if (externalIds.length > 0) {
    await deps.faces.deleteFaces(photo.eventId, externalIds);
  }
  const derivatives = await deps.db.listDerivatives(photo.id);
  await deps.objects.delete(photo.originalKey);
  for (const derivative of derivatives) {
    await deps.objects.delete(derivative.s3Key);
  }
  await deps.db.deletePhoto(photo.id);
}
