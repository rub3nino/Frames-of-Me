import type { Env } from "@rephoto/contracts";
import { createFaceEngine, type FaceEngine } from "@rephoto/face-engine";

export function loadFaceEngine(env: Env): FaceEngine {
  return createFaceEngine({
    ...process.env,
    FACE_ENGINE: env.FACE_ENGINE,
    DATABASE_URL: env.DATABASE_URL,
    AWS_REGION: env.AWS_REGION,
    REKOGNITION_COLLECTION_PREFIX: env.REKOGNITION_COLLECTION_PREFIX,
    REKOGNITION_SEARCH_MAX_FACES: String(env.REKOGNITION_SEARCH_MAX_FACES),
  });
}
