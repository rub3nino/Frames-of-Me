/// <reference lib="webworker" />
/*
 * Resize worker: decodes an image File (EXIF-oriented), fits it into a 1600 px long edge
 * (never upscaling), and encodes a JPEG at q0.8 on an OffscreenCanvas.
 *
 * Message protocol (see image-resize.ts):
 *   main → worker: { id: number; file: File }
 *   worker → main: { id: number; ok: true; blob: Blob; width: number; height: number }
 *                | { id: number; ok: false; code: "unsupported" | "error"; message: string }
 */

export const WEB_LONG_EDGE = 1600;
export const WEB_JPEG_QUALITY = 0.8;
/** 120 megapixels: anything larger is refused before decoding to keep memory bounded. */
export const MAX_PIXELS = 120_000_000;

export type ResizeRequest = { id: number; file: File };
export type ResizeResponse =
  | { id: number; ok: true; blob: Blob; width: number; height: number }
  | { id: number; ok: false; code: "unsupported" | "error"; message: string };

/** Target size for a `width`×`height` source: long edge capped to `longEdge`, never upscaled. */
export function fitSize(width: number, height: number, longEdge = WEB_LONG_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width, height };
  const scale = longEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function render(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (cause) {
    throw Object.assign(new Error(cause instanceof Error ? cause.message : "decode failed"), {
      code: "unsupported" as const,
    });
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      throw Object.assign(new Error("image exceeds 120 MP"), { code: "unsupported" as const });
    }
    const size = fitSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: WEB_JPEG_QUALITY });
    return { blob, width: size.width, height: size.height };
  } finally {
    bitmap.close();
  }
}

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

if (typeof scope.addEventListener === "function" && typeof scope.postMessage === "function") {
  scope.addEventListener("message", (event: MessageEvent<ResizeRequest>) => {
    const { id, file } = event.data ?? ({} as ResizeRequest);
    if (typeof id !== "number") return;
    render(file)
      .then((result) => {
        const response: ResizeResponse = { id, ok: true, ...result };
        scope.postMessage(response);
      })
      .catch((cause: unknown) => {
        const code = (cause as { code?: string } | null)?.code === "unsupported" ? "unsupported" : "error";
        const response: ResizeResponse = {
          id,
          ok: false,
          code,
          message: cause instanceof Error ? cause.message : String(cause),
        };
        scope.postMessage(response);
      });
  });
}
