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

export interface FaceEngine {
  indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]>;
  search(input: SearchInput): Promise<SearchHit[]>;
  deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void>;
  /** Removes the event collection. A missing collection is success. */
  deleteCollection(eventId: string): Promise<void>;
}
