// Copies the MediaPipe tasks-vision wasm runtime from node_modules and downloads the
// face_landmarker.task model into public/mediapipe/, so the selfie liveness challenge
// is served from our own origin (CSP 'self'; nothing is fetched from Google at runtime).
// Runs as `prebuild`; idempotent (skips files already present with the expected size).
import { createRequire } from "node:module";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public/mediapipe");
const wasmTarget = path.join(publicDir, "wasm");
const modelTarget = path.join(publicDir, "face_landmarker.task");
// Official Google-hosted float16 model (~3.6 MB). Override with MEDIAPIPE_MODEL_URL if mirrored.
const MODEL_URL =
  process.env.MEDIAPIPE_MODEL_URL ||
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_MIN_BYTES = 1_000_000;

const require = createRequire(import.meta.url);
// The package's exports map hides package.json: resolve the main entry (vision_bundle.cjs) instead.
const wasmSource = path.join(path.dirname(require.resolve("@mediapipe/tasks-vision")), "wasm");

async function exists(file, minBytes = 1) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size >= minBytes;
  } catch {
    return false;
  }
}

async function copyWasm() {
  await mkdir(wasmTarget, { recursive: true });
  // FilesetResolver.forVisionTasks(base) (useModule = false) loads vision_wasm_internal.* or, without
  // SIMD, vision_wasm_nosimd_internal.*; the *_module_* pair is for ES-module loading and is skipped.
  const files = (await readdir(wasmSource)).filter(
    (name) => /\.(wasm|js)$/.test(name) && !name.includes("_module_"),
  );
  if (files.length === 0) throw new Error(`no wasm files found in ${wasmSource}`);
  for (const name of files) {
    const from = path.join(wasmSource, name);
    const to = path.join(wasmTarget, name);
    const [a, b] = await Promise.all([stat(from), stat(to).catch(() => null)]);
    if (b && b.size === a.size) continue;
    await copyFile(from, to);
  }
  return files.length;
}

async function fetchModel() {
  if (await exists(modelTarget, MODEL_MIN_BYTES)) return "present";
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`model download failed: ${response.status} ${MODEL_URL}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MODEL_MIN_BYTES) throw new Error("model download is suspiciously small");
  await writeFile(modelTarget, bytes);
  return `downloaded ${(bytes.byteLength / 1e6).toFixed(1)} MB`;
}

const copied = await copyWasm();
let model;
try {
  model = await fetchModel();
} catch (error) {
  // Offline or mirror down: the build must still succeed. Without the model the landmarker
  // fails to load at runtime and the selfie page falls back to the file picker (liveness=file).
  // Set MEDIAPIPE_MODEL_REQUIRED=1 to make this fatal (e.g. in the production image build).
  const reason = error instanceof Error ? error.message : String(error);
  if (process.env.MEDIAPIPE_MODEL_REQUIRED === "1") throw error;
  console.warn(`mediapipe: WARNING model not available (${reason}); the camera challenge will be disabled and selfies fall back to file mode`);
  model = "MISSING";
}
console.log(`mediapipe: ${copied} wasm runtime files in public/mediapipe/wasm, model ${model}`);
