import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { sha256Hex } from "@rephoto/api/crypto";
import type { Mailer, MailMessage } from "@rephoto/api/mailer";
import type {
  CompletedPart,
  ObjectStore,
  PutObjectOptions,
  StoredObject,
  StreamedObject,
} from "@rephoto/api/object-store";
import { envSchema, objectKeys, SESSION_COOKIE_NAME, type Env } from "@rephoto/contracts";
import type { MemoryDatabase } from "@rephoto/db";
import type {
  FaceEngine,
  IndexPhotoInput,
  SearchFacesInput,
  SearchInput,
} from "../../../packages/face-engine/src/types.ts";
import type { WorkerDeps } from "../src/handlers.js";
import { pollOnce } from "../src/run.js";

export const env: Env = envSchema.parse({
  DATABASE_URL: "postgres://rephoto:rephoto@localhost:5432/rephoto",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "rephoto",
  S3_ACCESS_KEY: "rephoto",
  S3_SECRET_KEY: "rephoto-secret",
  S3_REGION: "eu-central-1",
  S3_FORCE_PATH_STYLE: "true",
  SESSION_SECRET: "test-session-secret-value",
  FACE_ENGINE: "fake",
  AWS_REGION: "eu-central-1",
  REKOGNITION_COLLECTION_PREFIX: "rephoto-",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_FROM: "noreply@rephoto.local",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:8787",
});

/** Keeps job log lines out of the test output. */
export const quiet = (): void => undefined;

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject & { cacheControl?: string }>();
  readonly abortedUploads: Array<{ key: string; uploadId: string }> = [];

  async put(
    key: string,
    body: Uint8Array,
    contentType: string,
    options?: PutObjectOptions,
  ): Promise<void> {
    this.objects.set(key, { body, contentType, cacheControl: options?.cacheControl });
  }

  async get(key: string): Promise<StoredObject | null> {
    const stored = this.objects.get(key);
    return stored ? { body: stored.body, contentType: stored.contentType } : null;
  }

  async stream(key: string): Promise<StreamedObject | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      body: Readable.from([Buffer.from(stored.body)]),
      contentType: stored.contentType,
      bytes: stored.body.byteLength,
    };
  }

  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { bytes: stored.body.byteLength, contentType: stored.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignPut(key: string, contentType: string, bytes?: number): Promise<string> {
    const length = bytes === undefined ? "" : `&length=${bytes}`;
    return `http://localhost:9000/${key}?put=1&type=${encodeURIComponent(contentType)}${length}`;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    void key;
    void contentType;
    return `mp-${randomUUID()}`;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `http://localhost:9000/${key}?upload=${uploadId}&part=${partNumber}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    void key;
    void uploadId;
    void parts;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.abortedUploads.push({ key, uploadId });
  }

  async presignGet(key: string): Promise<string> {
    return `http://localhost:9000/${key}`;
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

export type TrackingEngine = FaceEngine & {
  indexedPhotoIds: string[];
  indexedBytes: Uint8Array[];
  searchBytes: Uint8Array[];
  searchedFaceIds: string[];
  deletedFaceIds: string[][];
  deletedCollections: string[];
};

export function trackingEngine(inner: FaceEngine): TrackingEngine {
  const indexedPhotoIds: string[] = [];
  const indexedBytes: Uint8Array[] = [];
  const searchBytes: Uint8Array[] = [];
  const searchedFaceIds: string[] = [];
  const deletedFaceIds: string[][] = [];
  const deletedCollections: string[] = [];
  return {
    indexedPhotoIds,
    indexedBytes,
    searchBytes,
    searchedFaceIds,
    deletedFaceIds,
    deletedCollections,
    indexPhoto(input: IndexPhotoInput) {
      indexedPhotoIds.push(input.photoId);
      indexedBytes.push(input.imageBytes);
      return inner.indexPhoto(input);
    },
    search(input: SearchInput) {
      searchBytes.push(input.imageBytes);
      return inner.search(input);
    },
    searchFaces(input: SearchFacesInput) {
      searchedFaceIds.push(input.externalFaceId);
      return inner.searchFaces(input);
    },
    deleteFaces(eventId, externalFaceIds) {
      deletedFaceIds.push([...externalFaceIds]);
      return inner.deleteFaces(eventId, externalFaceIds);
    },
    deleteCollection(eventId) {
      deletedCollections.push(eventId);
      return inner.deleteCollection(eventId);
    },
  };
}

/** A face engine whose every method rejects, for tests that must not touch it. */
export function stubEngine(overrides: Partial<FaceEngine> = {}): FaceEngine {
  return {
    async indexPhoto() {
      return [];
    },
    async search() {
      return [];
    },
    async searchFaces() {
      return [];
    },
    async deleteFaces() {
      return undefined;
    },
    async deleteCollection() {
      return undefined;
    },
    ...overrides,
  };
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** `size` varies the bytes (and so the sha256) of photos that share a colour. */
export async function solidPng(r: number, g: number, b: number, size = 8): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function drain(deps: WorkerDeps, maxSteps = 30): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    const worked = await pollOnce(deps);
    if (!worked) return;
  }
  throw new Error("jobs did not drain");
}

export async function sessionCookie(db: MemoryDatabase, userId: string): Promise<string> {
  const token = randomUUID();
  await db.insertSession({
    userId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** Inserts a photo row and its original object, as an upload completion would. */
export async function storePhoto(
  deps: Pick<WorkerDeps, "db" | "objects">,
  input: { eventId: string; photographerId: string; bytes: Uint8Array; sha256?: string },
): Promise<string> {
  const photoId = randomUUID();
  const originalKey = objectKeys.original(input.eventId, photoId);
  await deps.db.insertPhoto({
    id: photoId,
    eventId: input.eventId,
    photographerId: input.photographerId,
    sha256: input.sha256 ?? sha256(input.bytes),
    originalKey,
    contentType: "image/png",
    bytes: input.bytes.byteLength,
  });
  await deps.objects.put(originalKey, input.bytes, "image/png");
  return photoId;
}
