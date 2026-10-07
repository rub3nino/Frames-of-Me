/**
 * Browser liveness challenge for the selfie page (v4 §4): the device camera plus
 * MediaPipe Face Landmarker, served from our own origin under /mediapipe/. A deterrent,
 * not a biometric proof — nothing but the final frontal JPEG ever leaves the browser.
 *
 * Steps (each within STEP_TIMEOUT_MS, otherwise LivenessError "timeout"):
 *   look → left → right → blink → capture
 */
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";

export const MEDIAPIPE_BASE = "/mediapipe";
export const STEP_TIMEOUT_MS = 15_000;
export const CAPTURE_LONG_EDGE = 1280;
export const CAPTURE_QUALITY = 0.9;

export type ChallengeStep = "look" | "left" | "right" | "blink" | "capture";
export const CHALLENGE_STEPS: readonly ChallengeStep[] = ["look", "left", "right", "blink", "capture"];

export const STEP_LABELS: Record<ChallengeStep, string> = {
  look: "Guarda la camera",
  left: "Gira la testa a sinistra",
  right: "Gira la testa a destra",
  blink: "Sbatti le palpebre",
  capture: "Guarda la camera",
};

export type LivenessErrorCode =
  | "unsupported" // no getUserMedia / insecure context
  | "denied" // permission refused or no camera
  | "model" // landmarker runtime or model failed to load
  | "timeout" // a step was not completed within STEP_TIMEOUT_MS
  | "aborted"
  | "capture"; // canvas encoding failed

export class LivenessError extends Error {
  code: LivenessErrorCode;
  step: ChallengeStep | null;

  constructor(code: LivenessErrorCode, message: string, step: ChallengeStep | null = null) {
    super(message);
    this.name = "LivenessError";
    this.code = code;
    this.step = step;
  }
}

/** Camera needs a secure context (https or localhost) and mediaDevices. */
export function cameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export async function openCamera(): Promise<MediaStream> {
  if (!cameraSupported()) throw new LivenessError("unsupported", "Camera non disponibile.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    const code: LivenessErrorCode =
      name === "NotAllowedError" || name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError"
        ? "denied"
        : "unsupported";
    throw new LivenessError(code, "Camera non disponibile.");
  }
}

export function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/**
 * Loads the wasm runtime and the model from /mediapipe/ (copied by scripts/fetch-mediapipe.mjs).
 * The library is imported lazily so the selfie page does not pay for it until the camera opens.
 * GPU delegate first, CPU when WebGL is unavailable.
 */
export async function loadLandmarker(): Promise<FaceLandmarker> {
  try {
    const { FilesetResolver, FaceLandmarker: Landmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_BASE}/wasm`);
    const create = (delegate: "GPU" | "CPU") =>
      Landmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MEDIAPIPE_BASE}/face_landmarker.task`, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
    try {
      return await create("GPU");
    } catch {
      return await create("CPU");
    }
  } catch {
    throw new LivenessError("model", "Riconoscimento non disponibile.");
  }
}

export type FaceReading = {
  /** Face box centred in the frame and large enough. */
  centred: boolean;
  /** Head turn, -1..1: positive = towards the user's own left, 0 = frontal. */
  turn: number;
  eyesClosed: boolean;
  eyesOpen: boolean;
};

const NOSE_TIP = 1;
const CHEEK_A = 234;
const CHEEK_B = 454;
const BLINK_CLOSED = 0.5;
const BLINK_OPEN = 0.2;
/** |turn| at/above which the head counts as turned, and at/below which it counts as frontal. */
export const TURNED = 0.4;
export const FRONTAL = 0.22;

function blendshape(result: FaceLandmarkerResult, name: string): number {
  const categories = result.faceBlendshapes[0]?.categories ?? [];
  return categories.find((category) => category.categoryName === name)?.score ?? 0;
}

/**
 * Yaw is read geometrically: where the nose tip sits between the two cheek-edge landmarks
 * (0.5 = frontal). The camera frame is un-mirrored, so the user's own left is image-right;
 * the preview is mirrored with CSS so what they see matches the instruction.
 */
export function readFace(result: FaceLandmarkerResult): FaceReading | null {
  const landmarks = result.faceLandmarks[0];
  if (!landmarks || landmarks.length <= CHEEK_B) return null;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const point of landmarks) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const width = maxX - minX;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const centred = width >= 0.18 && centreX > 0.3 && centreX < 0.7 && centreY > 0.25 && centreY < 0.75;

  const nose = landmarks[NOSE_TIP]!;
  const a = landmarks[CHEEK_A]!;
  const b = landmarks[CHEEK_B]!;
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const span = right - left;
  const ratio = span > 0 ? (nose.x - left) / span : 0.5;
  const turn = Math.max(-1, Math.min(1, (ratio - 0.5) * 2));

  const blinkLeft = blendshape(result, "eyeBlinkLeft");
  const blinkRight = blendshape(result, "eyeBlinkRight");
  return {
    centred,
    turn,
    eyesClosed: blinkLeft > BLINK_CLOSED && blinkRight > BLINK_CLOSED,
    eyesOpen: blinkLeft < BLINK_OPEN && blinkRight < BLINK_OPEN,
  };
}

/** Current video frame as a JPEG (q0.9, long edge 1280). Not mirrored: the real orientation. */
export function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    return Promise.reject(new LivenessError("capture", "Scatto non riuscito."));
  }
  const scale = Math.min(1, CAPTURE_LONG_EDGE / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new LivenessError("capture", "Scatto non riuscito."));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new LivenessError("capture", "Scatto non riuscito."))),
      "image/jpeg",
      CAPTURE_QUALITY,
    );
  });
}

export type ChallengeOptions = {
  video: HTMLVideoElement;
  landmarker: FaceLandmarker;
  onStep: (step: ChallengeStep) => void;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
};

/** Frames a condition must hold in a row before a step counts as done (debounces jitter). */
const STABLE_FRAMES = 3;

/**
 * Runs the challenge on the live video. Resolves with the frontal JPEG once every step is
 * passed; rejects with LivenessError("timeout", step) when a step takes too long, or
 * "aborted" when `signal` fires. One detection per animation frame.
 */
export function runChallenge({
  video,
  landmarker,
  onStep,
  signal,
  stepTimeoutMs = STEP_TIMEOUT_MS,
}: ChallengeOptions): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    let index = 0;
    let stepStartedAt = performance.now();
    let stable = 0;
    let blinked = false;
    let lastTimestamp = 0;
    let frame = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new LivenessError("aborted", "Annullato.")));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const advance = (now: number) => {
      index += 1;
      stable = 0;
      blinked = false;
      stepStartedAt = now;
      if (index < CHALLENGE_STEPS.length) onStep(CHALLENGE_STEPS[index]!);
    };

    onStep(CHALLENGE_STEPS[0]!);

    const tick = () => {
      if (settled) return;
      const step = CHALLENGE_STEPS[index]!;
      const now = performance.now();
      if (now - stepStartedAt > stepTimeoutMs) {
        finish(() => reject(new LivenessError("timeout", "Tempo scaduto.", step)));
        return;
      }
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        // MediaPipe needs strictly increasing timestamps in VIDEO mode.
        const timestamp = now > lastTimestamp ? now : lastTimestamp + 1;
        lastTimestamp = timestamp;
        let reading: FaceReading | null = null;
        try {
          reading = readFace(landmarker.detectForVideo(video, timestamp));
        } catch {
          reading = null;
        }
        if (!reading) {
          stable = 0;
        } else {
          switch (step) {
            case "look":
              stable = reading.centred ? stable + 1 : 0;
              if (stable >= STABLE_FRAMES) advance(now);
              break;
            case "left":
              stable = reading.turn >= TURNED ? stable + 1 : 0;
              if (stable >= STABLE_FRAMES) advance(now);
              break;
            case "right":
              stable = reading.turn <= -TURNED ? stable + 1 : 0;
              if (stable >= STABLE_FRAMES) advance(now);
              break;
            case "blink":
              if (!blinked && reading.eyesClosed) blinked = true;
              else if (blinked && reading.eyesOpen) advance(now);
              break;
            case "capture":
              stable =
                reading.centred && Math.abs(reading.turn) <= FRONTAL && reading.eyesOpen ? stable + 1 : 0;
              if (stable >= STABLE_FRAMES) {
                captureFrame(video).then(
                  (blob) => finish(() => resolve(blob)),
                  (cause: unknown) => finish(() => reject(cause)),
                );
                return;
              }
              break;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });
}
