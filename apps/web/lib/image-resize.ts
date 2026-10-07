import type { ResizeRequest, ResizeResponse } from "./resize.worker";

export type WebRender = { blob: Blob; width: number; height: number };

/** The browser could not decode the file (corrupt, unsupported codec, or above the 120 MP cap). */
export class UnsupportedImageError extends Error {
  constructor(message = "Immagine non supportata.") {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

/** OffscreenCanvas + createImageBitmap + Worker: Chrome, Edge, Firefox 105+, Safari 16.4+. */
export function isWebRenderSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  );
}

type Pending = {
  id: number;
  file: File;
  resolve: (value: WebRender) => void;
  reject: (reason: unknown) => void;
};

type Slot = { worker: Worker; busy: Pending | null };

let slots: Slot[] | null = null;
const queue: Pending[] = [];
let nextId = 1;

function poolSize(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

function spawn(): Slot {
  // Next/webpack bundles the worker from this static `new URL(..., import.meta.url)` form.
  const worker = new Worker(new URL("./resize.worker.ts", import.meta.url));
  const slot: Slot = { worker, busy: null };
  worker.onmessage = (event: MessageEvent<ResizeResponse>) => {
    const data = event.data;
    const job = slot.busy;
    if (!job || !data || data.id !== job.id) return;
    slot.busy = null;
    if (data.ok) job.resolve({ blob: data.blob, width: data.width, height: data.height });
    else if (data.code === "unsupported") job.reject(new UnsupportedImageError());
    else job.reject(new Error(data.message || "Elaborazione immagine non riuscita."));
    pump();
  };
  worker.onerror = (event) => {
    // The worker crashed: fail the running job, replace the worker, keep the queue going.
    const job = slot.busy;
    slot.busy = null;
    job?.reject(new Error(event.message || "Il worker di ridimensionamento si è interrotto."));
    worker.terminate();
    if (slots) {
      const index = slots.indexOf(slot);
      if (index >= 0) slots[index] = spawn();
    }
    pump();
  };
  return slot;
}

function pool(): Slot[] {
  if (!slots) slots = Array.from({ length: poolSize() }, () => spawn());
  return slots;
}

/** FIFO: hand the oldest queued job to any idle worker. */
function pump(): void {
  const workers = pool();
  for (const slot of workers) {
    if (slot.busy) continue;
    const job = queue.shift();
    if (!job) return;
    slot.busy = job;
    const message: ResizeRequest = { id: job.id, file: job.file };
    try {
      slot.worker.postMessage(message);
    } catch (cause) {
      slot.busy = null;
      job.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
}

/**
 * 1600 px long edge, JPEG q0.8, EXIF-oriented. Runs in a Worker pool
 * (navigator.hardwareConcurrency-1, max 4). Rejects with UnsupportedImageError
 * for undecodable files or images above 120 MP.
 */
export function renderWebJpeg(file: File): Promise<WebRender> {
  if (!isWebRenderSupported()) {
    return Promise.reject(new UnsupportedImageError("Il browser non supporta il ridimensionamento."));
  }
  return new Promise<WebRender>((resolve, reject) => {
    queue.push({ id: nextId++, file, resolve, reject });
    pump();
  });
}
