import type { Readable } from "node:stream";

export type StoredObject = {
  body: Uint8Array;
  contentType: string;
};

export type StreamedObject = {
  body: Readable;
  contentType: string;
  bytes?: number;
};

export type CompletedPart = {
  partNumber: number;
  etag: string;
};

export type PutObjectOptions = {
  cacheControl?: string;
};

export interface ObjectStore {
  put(
    key: string,
    body: Uint8Array,
    contentType: string,
    options?: PutObjectOptions,
  ): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** The object body as a Node `Readable`; null when the key does not exist. */
  stream(key: string): Promise<StreamedObject | null>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** When `bytes` is given the signed PUT is bound to that `Content-Length`. */
  presignPut(key: string, contentType: string, bytes?: number): Promise<string>;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void>;
  /** No-op when the upload no longer exists. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Signed with a date rounded down to `SIGNED_URL_WINDOW_SECONDS`, so URLs repeat inside a window. */
  presignGet(key: string): Promise<string>;
}
