export type BBox = { x: number; y: number; width: number; height: number }; // 0..1 relative

export interface IndexFace {
  externalId: string;
  bbox: BBox;
  confidence: number; // 0..1
}

export interface FaceMatch {
  externalId: string;
  photoId: string;
  similarity: number; // 0..1
}

export interface FaceEngine {
  indexPhoto(input: {
    eventId: string;
    photoId: string;
    imageBytes: Uint8Array;
  }): Promise<IndexFace[]>;
  searchSelfie(input: {
    eventId: string;
    imageBytes: Uint8Array;
    threshold: number;
  }): Promise<FaceMatch[]>;
  deleteFaces(input: { eventId: string; externalIds: string[] }): Promise<void>;
}

/** Callers pass 0..1. Rekognition's 0–100 scale stops at the adapter. */
export const DEFAULT_MATCH_THRESHOLD = 0.8;

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
