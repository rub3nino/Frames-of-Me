import { FakeFaceEngine } from "./fake.ts";
import { RekognitionFaceEngine } from "./rekognition.ts";
import type { FaceEngine } from "./types.ts";

export type {
  Box,
  FaceEngine,
  ImageContentType,
  IndexPhotoInput,
  IndexedFace,
  SearchHit,
  SearchInput,
} from "./types.ts";

export {
  FakeFaceEngine,
  MemoryFaceIndexStore,
  SqlFaceIndexStore,
} from "./fake.ts";
export type { FaceIndexRecord, FaceIndexStore, Queryable } from "./fake.ts";

export { RekognitionFaceEngine } from "./rekognition.ts";
export type { RekognitionFaceClient } from "./rekognition.ts";

/**
 * `FACE_ENGINE=fake` (default) or `FACE_ENGINE=rekognition`.
 * Any other value throws. Callers depend on {@link FaceEngine} only.
 */
export function createFaceEngine(
  env: NodeJS.ProcessEnv = process.env,
): FaceEngine {
  const name = env.FACE_ENGINE ?? "fake";
  if (name === "fake") return new FakeFaceEngine(undefined, env);
  if (name === "rekognition") return new RekognitionFaceEngine({ env });
  throw new Error(
    `Unknown FACE_ENGINE "${name}". Expected "fake" or "rekognition".`,
  );
}
