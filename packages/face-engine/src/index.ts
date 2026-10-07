import { FakeFaceEngine } from "./fake.ts";
import { InsightFaceEngine } from "./insightface.ts";
import { RateLimitedFaceEngine, readTps } from "./limiter.ts";
import { RekognitionFaceEngine } from "./rekognition.ts";
import type { FaceEngine } from "./types.ts";

export type {
  Box,
  FaceEngine,
  ImageContentType,
  IndexPhotoInput,
  IndexedFace,
  LivenessInput,
  LivenessResult,
  SearchFacesInput,
  SearchHit,
  SearchInput,
} from "./types.ts";

export {
  FakeFaceEngine,
  MemoryFaceIndexStore,
  SqlFaceIndexStore,
} from "./fake.ts";
export type { FaceIndexRecord, FaceIndexStore, Queryable } from "./fake.ts";

export { RekognitionFaceEngine, RekognitionThrottleError } from "./rekognition.ts";
export type { RekognitionFaceClient } from "./rekognition.ts";

export {
  FaceServiceError,
  FaceServiceUnavailable,
  FaceVectorsTableMissing,
  InsightFaceEngine,
  mapCosine,
} from "./insightface.ts";
export type {
  EmbedResponse,
  InsightFaceEngineOptions,
  ServiceFace,
  VectorSql,
} from "./insightface.ts";

export { RateLimitedFaceEngine, TokenBucket, readTps } from "./limiter.ts";
export type { RateLimitOptions } from "./limiter.ts";

const DEFAULT_REKOGNITION_TPS = 5;
const DEFAULT_FACE_TPS = 20;

/**
 * `FACE_ENGINE=fake` (default), `rekognition` or `insightface`.
 * Any other value throws. Callers depend on {@link FaceEngine} only.
 * Remote engines are rate limited per process: Rekognition by
 * `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` (default 5 each, with
 * `FACE_INDEX_TPS` / `FACE_SEARCH_TPS` honoured when set), InsightFace by
 * `FACE_INDEX_TPS` / `FACE_SEARCH_TPS` (default 20 each); the fake engine is not.
 */
export function createFaceEngine(
  env: NodeJS.ProcessEnv = process.env,
): FaceEngine {
  const name = env.FACE_ENGINE ?? "fake";
  if (name === "fake") return new FakeFaceEngine(undefined, env);
  if (name === "rekognition") {
    return new RateLimitedFaceEngine(new RekognitionFaceEngine({ env }), {
      indexTps: readFirstTps(
        [env.REKOGNITION_INDEX_TPS, "REKOGNITION_INDEX_TPS"],
        [env.FACE_INDEX_TPS, "FACE_INDEX_TPS"],
        DEFAULT_REKOGNITION_TPS,
      ),
      searchTps: readFirstTps(
        [env.REKOGNITION_SEARCH_TPS, "REKOGNITION_SEARCH_TPS"],
        [env.FACE_SEARCH_TPS, "FACE_SEARCH_TPS"],
        DEFAULT_REKOGNITION_TPS,
      ),
    });
  }
  if (name === "insightface") {
    return new RateLimitedFaceEngine(new InsightFaceEngine({ env }), {
      indexTps: readTps(env.FACE_INDEX_TPS, "FACE_INDEX_TPS", DEFAULT_FACE_TPS),
      searchTps: readTps(env.FACE_SEARCH_TPS, "FACE_SEARCH_TPS", DEFAULT_FACE_TPS),
    });
  }
  throw new Error(
    `Unknown FACE_ENGINE "${name}". Expected "fake", "rekognition" or "insightface".`,
  );
}

/** The first variable that is set wins; all blank → `fallback`. */
function readFirstTps(
  ...sources: Array<[raw: string | undefined, name: string] | number>
): number {
  let fallback = DEFAULT_REKOGNITION_TPS;
  for (const source of sources) {
    if (typeof source === "number") {
      fallback = source;
      continue;
    }
    const [raw, name] = source;
    if (raw !== undefined && raw.trim() !== "") return readTps(raw, name);
  }
  return fallback;
}
