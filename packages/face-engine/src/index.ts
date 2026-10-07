import { FakeFaceEngine } from "./fake.ts";
import { RateLimitedFaceEngine, readTps } from "./limiter.ts";
import { RekognitionFaceEngine } from "./rekognition.ts";
import type { FaceEngine } from "./types.ts";

export type {
  Box,
  FaceEngine,
  ImageContentType,
  IndexPhotoInput,
  IndexedFace,
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

export { RateLimitedFaceEngine, TokenBucket, readTps } from "./limiter.ts";
export type { RateLimitOptions } from "./limiter.ts";

/**
 * `FACE_ENGINE=fake` (default) or `FACE_ENGINE=rekognition`.
 * Any other value throws. Callers depend on {@link FaceEngine} only.
 * The Rekognition engine is rate limited per process by
 * `REKOGNITION_INDEX_TPS` / `REKOGNITION_SEARCH_TPS` (default 5 each);
 * the fake engine is not.
 */
export function createFaceEngine(
  env: NodeJS.ProcessEnv = process.env,
): FaceEngine {
  const name = env.FACE_ENGINE ?? "fake";
  if (name === "fake") return new FakeFaceEngine(undefined, env);
  if (name === "rekognition") {
    return new RateLimitedFaceEngine(new RekognitionFaceEngine({ env }), {
      indexTps: readTps(env.REKOGNITION_INDEX_TPS, "REKOGNITION_INDEX_TPS"),
      searchTps: readTps(env.REKOGNITION_SEARCH_TPS, "REKOGNITION_SEARCH_TPS"),
    });
  }
  throw new Error(
    `Unknown FACE_ENGINE "${name}". Expected "fake" or "rekognition".`,
  );
}
