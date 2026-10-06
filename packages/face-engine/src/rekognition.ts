import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  DeleteFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import { rekognitionCollectionId } from "@rephoto/contracts";
import type {
  FaceEngine,
  IndexedFace,
  IndexPhotoInput,
  SearchHit,
  SearchInput,
} from "./types.ts";

const INDEX_MAX_FACES = 50;
/** SearchFacesByImage allows MaxFaces up to 4096. 500 covers one person in many photos. */
const DEFAULT_SEARCH_MAX_FACES = 500;
const SEARCH_MAX_FACES_CAP = 4096;
const DELETE_FACES_CHUNK = 4096;

export interface RekognitionBoundingBox {
  Left?: number;
  Top?: number;
  Width?: number;
  Height?: number;
}

export interface RekognitionFaceClient {
  createCollection(input: { CollectionId: string }): Promise<void>;
  indexFaces(input: {
    CollectionId: string;
    Image: { Bytes: Uint8Array };
    ExternalImageId: string;
    MaxFaces: number;
    QualityFilter: "AUTO";
  }): Promise<{
    FaceRecords?: Array<{
      Face?: {
        FaceId?: string;
        Confidence?: number;
        BoundingBox?: RekognitionBoundingBox;
      };
    }>;
  }>;
  searchFacesByImage(input: {
    CollectionId: string;
    Image: { Bytes: Uint8Array };
    MaxFaces: number;
    FaceMatchThreshold: number;
  }): Promise<{
    FaceMatches?: Array<{
      Similarity?: number;
      Face?: { FaceId?: string; ExternalImageId?: string };
    }>;
  }>;
  deleteFaces(input: { CollectionId: string; FaceIds: string[] }): Promise<void>;
  deleteCollection(input: { CollectionId: string }): Promise<void>;
}

/** Throughput errors are requeued by the worker and do not include image bytes. */
export class RekognitionThrottleError extends Error {
  constructor() {
    super("Rekognition throughput exceeded");
    this.name = "RekognitionThrottleError";
  }
}

export interface RekognitionFaceEngineOptions {
  client?: RekognitionFaceClient;
  env?: NodeJS.ProcessEnv;
}

/**
 * Amazon Rekognition in eu-central-1. Search calls SearchFacesByImage only
 * and never IndexFaces. Image bytes are not stored or logged.
 */
export class RekognitionFaceEngine implements FaceEngine {
  private readonly region: string;
  private readonly minSimilarity: number;
  private readonly searchMaxFaces: number;
  private readonly collectionPrefix: string;
  private client: RekognitionFaceClient | undefined;
  private readonly readyCollections = new Set<string>();

  constructor(options: RekognitionFaceEngineOptions = {}) {
    const env = options.env ?? process.env;
    this.region = env.AWS_REGION ?? "eu-central-1";
    if (this.region !== "eu-central-1") {
      throw new Error("AWS_REGION must be eu-central-1");
    }
    this.minSimilarity = readMinSimilarity(env.REKOGNITION_MIN_SIMILARITY);
    this.searchMaxFaces = readSearchMaxFaces(env.REKOGNITION_SEARCH_MAX_FACES);
    this.collectionPrefix = env.REKOGNITION_COLLECTION_PREFIX ?? "rephoto-";
    this.client = options.client;
  }

  async indexPhoto(input: IndexPhotoInput): Promise<IndexedFace[]> {
    const collectionId = rekognitionCollectionId(input.eventId, this.collectionPrefix);
    const client = this.resolveClient();
    await this.ensureCollection(client, collectionId, input.imageBytes);
    let response: Awaited<ReturnType<RekognitionFaceClient["indexFaces"]>>;
    try {
      response = await client.indexFaces({
        CollectionId: collectionId,
        Image: { Bytes: input.imageBytes },
        ExternalImageId: input.photoId,
        MaxFaces: INDEX_MAX_FACES,
        QualityFilter: "AUTO",
      });
    } catch (error) {
      throw rethrowRekognition(error, input.imageBytes);
    }
    return mapIndexedFaces(response.FaceRecords);
  }

  async search(input: SearchInput): Promise<SearchHit[]> {
    const collectionId = rekognitionCollectionId(input.eventId, this.collectionPrefix);
    const client = this.resolveClient();
    let response: Awaited<ReturnType<RekognitionFaceClient["searchFacesByImage"]>>;
    try {
      response = await client.searchFacesByImage({
        CollectionId: collectionId,
        Image: { Bytes: input.imageBytes },
        MaxFaces: this.searchMaxFaces,
        FaceMatchThreshold: this.minSimilarity,
      });
    } catch (error) {
      if (isErrorNamed(error, "ResourceNotFoundException")) return [];
      throw rethrowRekognition(error, input.imageBytes);
    }
    const hits: SearchHit[] = [];
    for (const match of response.FaceMatches ?? []) {
      const photoId = match.Face?.ExternalImageId;
      const externalFaceId = match.Face?.FaceId;
      if (!photoId || !externalFaceId) continue;
      const similarity = match.Similarity;
      if (similarity === undefined || similarity < this.minSimilarity) continue;
      hits.push({ externalFaceId, photoId, similarity });
    }
    return hits;
  }

  async deleteFaces(eventId: string, externalFaceIds: string[]): Promise<void> {
    if (externalFaceIds.length === 0) return;
    const collectionId = rekognitionCollectionId(eventId, this.collectionPrefix);
    const client = this.resolveClient();
    for (let offset = 0; offset < externalFaceIds.length; offset += DELETE_FACES_CHUNK) {
      const faceIds = externalFaceIds.slice(offset, offset + DELETE_FACES_CHUNK);
      try {
        await client.deleteFaces({
          CollectionId: collectionId,
          FaceIds: faceIds,
        });
      } catch (error) {
        if (isErrorNamed(error, "ResourceNotFoundException")) return;
        throw rethrowRekognition(error);
      }
    }
  }

  async deleteCollection(eventId: string): Promise<void> {
    const collectionId = rekognitionCollectionId(eventId, this.collectionPrefix);
    this.readyCollections.delete(collectionId);
    const client = this.resolveClient();
    try {
      await client.deleteCollection({ CollectionId: collectionId });
    } catch (error) {
      if (isErrorNamed(error, "ResourceNotFoundException")) return;
      throw rethrowRekognition(error);
    }
  }

  private resolveClient(): RekognitionFaceClient {
    if (!this.client) {
      this.client = createAwsRekognitionClient(this.region);
    }
    return this.client;
  }

  private async ensureCollection(
    client: RekognitionFaceClient,
    collectionId: string,
    imageBytes: Uint8Array,
  ): Promise<void> {
    if (this.readyCollections.has(collectionId)) return;
    try {
      await client.createCollection({ CollectionId: collectionId });
    } catch (error) {
      if (!isErrorNamed(error, "ResourceAlreadyExistsException")) {
        throw rethrowRekognition(error, imageBytes);
      }
    }
    this.readyCollections.add(collectionId);
  }
}

function readSearchMaxFaces(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SEARCH_MAX_FACES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SEARCH_MAX_FACES_CAP) {
    throw new Error("REKOGNITION_SEARCH_MAX_FACES must be an integer from 1 to 4096");
  }
  return value;
}

function readMinSimilarity(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 90;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("REKOGNITION_MIN_SIMILARITY must be a number from 0 to 100");
  }
  return value;
}

function mapIndexedFaces(
  records:
    | Array<{
        Face?: {
          FaceId?: string;
          Confidence?: number;
          BoundingBox?: RekognitionBoundingBox;
        };
      }>
    | undefined,
): IndexedFace[] {
  const faces: IndexedFace[] = [];
  for (const record of records ?? []) {
    const face = record.Face;
    if (!face?.FaceId) continue;
    const box = face.BoundingBox;
    faces.push({
      externalFaceId: face.FaceId,
      confidence: face.Confidence ?? 0,
      bbox: {
        left: box?.Left ?? 0,
        top: box?.Top ?? 0,
        width: box?.Width ?? 0,
        height: box?.Height ?? 0,
      },
    });
  }
  return faces;
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { name?: unknown; Code?: unknown; __type?: unknown };
  const raw = record.name ?? record.Code ?? record.__type;
  return typeof raw === "string" ? raw : "";
}

function isErrorNamed(error: unknown, name: string): boolean {
  const found = errorName(error);
  return found === name || found.endsWith(`#${name}`);
}

function isThrottleError(error: unknown): boolean {
  return (
    isErrorNamed(error, "ProvisionedThroughputExceededException") ||
    isErrorNamed(error, "ThrottlingException") ||
    isErrorNamed(error, "TooManyRequestsException")
  );
}

function rethrowRekognition(error: unknown, imageBytes?: Uint8Array): Error {
  if (isThrottleError(error)) throw new RekognitionThrottleError();
  return sanitizeRekognitionError(error, imageBytes);
}

function sanitizeRekognitionError(error: unknown, imageBytes?: Uint8Array): Error {
  const name = errorName(error) || "Error";
  let message = "Rekognition request failed";
  if (error instanceof Error && error.message) message = error.message;
  message = stripImageBytes(message, imageBytes);
  message = message.replace(/[^\t\n\r\x20-\x7E]/g, "").slice(0, 300);
  const safe = new Error(message || "Rekognition request failed");
  safe.name = name.slice(0, 80);
  return safe;
}

function stripImageBytes(message: string, imageBytes?: Uint8Array): string {
  if (!imageBytes || imageBytes.length < 8) return message;
  let text = message;
  const utf8 = Buffer.from(imageBytes).toString("utf8");
  if (utf8.length >= 8) text = text.split(utf8).join("");
  const base64 = Buffer.from(imageBytes).toString("base64");
  if (base64.length >= 8) text = text.split(base64).join("");
  return text;
}

function createAwsRekognitionClient(region: string): RekognitionFaceClient {
  const sdk = new RekognitionClient({ region });
  return {
    async createCollection(input) {
      await sdk.send(new CreateCollectionCommand(input));
    },
    async indexFaces(input) {
      const output = await sdk.send(new IndexFacesCommand(input));
      return { FaceRecords: output.FaceRecords };
    },
    async searchFacesByImage(input) {
      const output = await sdk.send(new SearchFacesByImageCommand(input));
      return { FaceMatches: output.FaceMatches };
    },
    async deleteFaces(input) {
      await sdk.send(new DeleteFacesCommand(input));
    },
    async deleteCollection(input) {
      await sdk.send(new DeleteCollectionCommand(input));
    },
  };
}
