/**
 * Runtime FaceEngine lives in `@rephoto/face-engine` (0–100 similarity).
 * This package does not declare a second interface.
 * Gallery rows store that similarity divided by 100, and keep a hit only
 * when the stored score is at least this threshold.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.8;

/** Input of `FaceEngine.searchFaces`: an already indexed face of the event. */
export interface SearchFacesInput {
  eventId: string;
  externalFaceId: string;
}

const COLLECTION_ID_PATTERN = /^[a-zA-Z0-9_.\-]+$/;

/** Prefix defaults to env REKOGNITION_COLLECTION_PREFIX or "rephoto-". */
export function rekognitionCollectionId(
  eventId: string,
  prefix = "rephoto-",
): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const safeEventId = eventId.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const id = `${safePrefix}${safeEventId}`;
  if (!COLLECTION_ID_PATTERN.test(id) || id.length > 255) {
    throw new Error(`Invalid Rekognition collection id for event ${eventId}`);
  }
  return id;
}

export const objectKeys = {
  original(eventId: string, photoId: string) {
    return `originals/${eventId}/${photoId}`;
  },
  thumb(photoId: string) {
    return `thumbs/${photoId}.jpg`;
  },
  web(photoId: string) {
    return `web/${photoId}.jpg`;
  },
  selfie(eventId: string, userId: string, id: string) {
    return `selfies/${eventId}/${userId}/${id}`;
  },
};
