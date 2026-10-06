export type StoredObject = {
  body: Uint8Array;
  contentType: string;
};

export type CompletedPart = {
  partNumber: number;
  etag: string;
};

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
  presignPut(key: string, contentType: string): Promise<string>;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void>;
  presignGet(key: string): Promise<string>;
}
