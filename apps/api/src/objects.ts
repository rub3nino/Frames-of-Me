import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SIGNED_URL_TTL_SECONDS,
  SIGNED_URL_WINDOW_SECONDS,
  type Env,
} from "@rephoto/contracts";
import type { CompletedPart, ObjectStore } from "./object-store.js";

function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  return "name" in error ? String(error.name) : "";
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = errorName(error);
  if (name === "NoSuchKey" || name === "NotFound") return true;
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  return "httpStatusCode" in metadata && metadata.httpStatusCode === 404;
}

/** `now` rounded down to the signing window, so identical URLs repeat inside it. */
export function signingWindowStart(now: Date = new Date()): Date {
  const windowMs = SIGNED_URL_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function toReadable(body: unknown): Readable | null {
  if (!body) return null;
  if (body instanceof Readable) return body;
  if (typeof body === "object" && "getReader" in body) {
    return Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  }
  if (typeof body === "object" && "pipe" in body) return body as Readable;
  return null;
}

export function createS3ObjectStore(env: Env): ObjectStore {
  const credentials =
    env.S3_ACCESS_KEY && env.S3_SECRET_KEY
      ? {
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
        }
      : undefined;
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(credentials ? { credentials } : {}),
  });
  // Presigned URLs are consumed by the browser, which may reach the store through a
  // different host than the api/worker do (MinIO behind a reverse proxy, S3_ENDPOINT
  // being the compose-internal name). S3_PUBLIC_ENDPOINT, when set, is the host the
  // signature is computed for; every other operation keeps using the internal client.
  // SigV4 covers the Host header, so the browser must send the URL to that same host.
  const signer = env.S3_PUBLIC_ENDPOINT
    ? new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_PUBLIC_ENDPOINT,
        forcePathStyle: true,
        ...(credentials ? { credentials } : {}),
      })
    : client;
  const bucket = env.S3_BUCKET;
  const expiresIn = SIGNED_URL_TTL_SECONDS;

  return {
    async put(key, body, contentType, options) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...(options?.cacheControl ? { CacheControl: options.cacheControl } : {}),
        }),
      );
    },
    async get(key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const bytes = await result.Body?.transformToByteArray();
        if (!bytes) return null;
        return {
          body: bytes,
          contentType: result.ContentType ?? "application/octet-stream",
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async stream(key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const body = toReadable(result.Body);
        if (!body) return null;
        return {
          body,
          contentType: result.ContentType ?? "application/octet-stream",
          ...(typeof result.ContentLength === "number" ? { bytes: result.ContentLength } : {}),
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          bytes: result.ContentLength ?? 0,
          contentType: result.ContentType ?? "application/octet-stream",
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    },
    presignPut(key, contentType, bytes) {
      return getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ...(typeof bytes === "number" ? { ContentLength: bytes } : {}),
        }),
        { expiresIn },
      );
    },
    async createMultipartUpload(key, contentType) {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) throw new Error("Multipart upload id missing");
      return result.UploadId;
    },
    presignUploadPart(key, uploadId, partNumber) {
      return getSignedUrl(
        signer,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
    },
    async completeMultipartUpload(key, uploadId, parts: CompletedPart[]) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
          },
        }),
      );
    },
    async abortMultipartUpload(key, uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        );
      } catch (error) {
        if (errorName(error) === "NoSuchUpload" || isMissing(error)) return;
        throw error;
      }
    },
    presignGet(key) {
      return getSignedUrl(
        signer,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn, signingDate: signingWindowStart() },
      );
    },
  };
}
