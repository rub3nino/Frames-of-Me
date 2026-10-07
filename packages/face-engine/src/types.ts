export type ImageContentType = "image/jpeg" | "image/png";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
} // normalized 0..1

export interface IndexPhotoInput {
  eventId: string;
  photoId: string;
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}

export interface IndexedFace {
  externalFaceId: string;
  bbox: Box;
  confidence: number; // 0..100
}

export interface SearchInput {
  eventId: string;
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}

export interface SearchHit {
  externalFaceId: string;
  photoId: string;
  similarity: number; // 0..100
}

export interface SearchFacesInput {
  eventId: string;
  externalFaceId: string;
}

export interface LivenessInput {
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}

export interface LivenessResult {
  live: boolean;
  score: number; // 0..1
  /** "silent-face" when a model judged the image, "none" when no model was available. */
  method: string;
}

export interface FaceEngine {
  indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]>;
  search(input: SearchInput): Promise<SearchHit[]>;
  /** Faces in the event collection similar to an already indexed face. The input face itself is excluded. */
  searchFaces(input: SearchFacesInput): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
  /** Removes the event collection. A missing collection is success. */
  deleteCollection(eventId: string): Promise<void>;
  /**
   * Presentation-attack check on a selfie. Optional: only engines backed by a
   * liveness model implement it (InsightFace via the face service).
   */
  checkLiveness?(input: LivenessInput): Promise<LivenessResult>;
}
