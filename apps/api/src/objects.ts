import {
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
import { SIGNED_URL_TTL_SECONDS, type Env } from "@rephoto/contracts";
import type { CompletedPart, ObjectStore } from "./object-store.js";

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "NoSuchKey" || name === "NotFound") return true;
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  return "httpStatusCode" in metadata && metadata.httpStatusCode === 404;
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
  const bucket = env.S3_BUCKET;
  const expiresIn = SIGNED_URL_TTL_SECONDS;

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
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
    presignPut(key, contentType) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
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
        client,
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
    presignGet(key) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn },
      );
    },
  };
}
