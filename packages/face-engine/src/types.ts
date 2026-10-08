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
  /** Raw cosine similarity (-1..1) when the engine has one (InsightFace, fake); absent for Rekognition. */
  cosine?: number;
}

export interface EmbedSelfieInput {
  imageBytes: Uint8Array;
  contentType: ImageContentType;
}

/** One face of a selfie as the engine saw it, with its embedding (not stored). */
export interface SelfieFace {
  bbox: Box;
  score: number; // 0..1 detector confidence
  quality: number; // 0..1
  embedding: number[];
  /** Head yaw in [-1, 1] from the face service (positive = nose towards image right);
   * null when the engine gives no landmarks. Used by challenge-response liveness (F05). */
  yaw?: number | null;
}

export interface EmbedSelfieResult {
  faces: SelfieFace[];
  /** Pixel size of the image the engine detected on (0 when unknown). */
  width: number;
  height: number;
}

export interface SearchByVectorInput {
  eventId: string;
  embedding: number[];
  /** Hits below this cosine are dropped; the engine's own minimum when absent. */
  minCosine?: number;
  /** Row limit; the engine's own maximum when absent. */
  maxFaces?: number;
}

export type VectorHit = SearchHit & { cosine: number };

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
  /**
   * Detects the faces of a selfie and returns their embeddings without touching the
   * collection, so the worker can gate the selfie (size, quality, face count) and search
   * by vector. Optional: InsightFace and the fake engine implement it; Rekognition falls
   * back to `search`.
   */
  embedSelfie?(input: EmbedSelfieInput): Promise<EmbedSelfieResult>;
  /** Nearest faces of the event to a raw embedding, with the raw cosine on every hit. */
  searchByVector?(input: SearchByVectorInput): Promise<VectorHit[]>;
  /** Stored embedding of an indexed face, or null when unknown. Used by `attach` for the selfie-vector path. */
  faceEmbedding?(input: SearchFacesInput): Promise<number[] | null>;
}
