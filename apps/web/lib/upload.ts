import { createSHA256 } from "hash-wasm";
import { ApiError, api } from "@/lib/api";
import type {
  AlbumUploadDedupeResponse,
  UploadCompleteResponse,
  UploadInitResponse,
  UploadLookupResponse,
} from "@/lib/types";

export type ImageType = "image/jpeg" | "image/png";

export type Progress = (loaded: number, total: number) => void;
export type UploadOutcome = { photoId: string };

/** 60 MiB, mirrors UPLOAD_MAX_BYTES in the contracts. */
export const UPLOAD_MAX_BYTES = 62_914_560;
/** 8 MiB, mirrors WEB_STAGE_MAX_BYTES in the contracts. */
export const WEB_STAGE_MAX_BYTES = 8_388_608;
/** Slice read while hashing so memory stays flat on 60 MiB files. */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;
/** Per-part XHR timeout. */
export const PART_TIMEOUT_MS = 120_000;

export function contentTypeOf(file: File): ImageType | null {
  if (file.type === "image/jpeg" || file.type === "image/png") return file.type;
  if (file.type === "image/jpg") return "image/jpeg";
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  return null;
}

export function safeFilename(name: string): string | null {
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!base || base === "." || base === ".." || base.length > 200) return null;
  if (/[/\\]/.test(base)) return null;
  return base;
}

/** Streamed SHA-256: the file is read in HASH_SLICE_BYTES chunks and never held whole. */
export async function sha256Hex(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_SLICE_BYTES) {
    const slice = file.slice(offset, Math.min(offset + HASH_SLICE_BYTES, file.size));
    hasher.update(new Uint8Array(await slice.arrayBuffer()));
  }
  return hasher.digest("hex");
}

/** `error.name === "AbortError"`, detectable by the queue like a fetch abort. */
export function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("Caricamento annullato.", "AbortError");
  const error = new Error("Caricamento annullato.");
  error.name = "AbortError";
  return error;
}

/** `error.name === "TimeoutError"`: the part did not finish within PART_TIMEOUT_MS. */
export function timeoutError(): Error {
  if (typeof DOMException === "function") return new DOMException("Caricamento scaduto.", "TimeoutError");
  const error = new Error("Caricamento scaduto.");
  error.name = "TimeoutError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function putTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol === "http:" && local && parsed.port === "9000") {
      return `/api/s3-put?url=${encodeURIComponent(url)}`;
    }
  } catch {
    return url;
  }
  return url;
}

function putPart(
  url: string,
  blob: Blob,
  contentType: string | null,
  onLoaded: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      xhr.abort();
      reject(abortError());
    };
    const done = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    xhr.open("PUT", putTarget(url));
    xhr.timeout = PART_TIMEOUT_MS;
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded(event.loaded);
    };
    xhr.onload = () => {
      if (settled) return;
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader("ETag")?.trim() ?? null);
        return;
      }
      reject(new Error("Caricamento della parte non riuscito."));
    };
    xhr.onerror = () => {
      if (settled) return;
      done();
      reject(new Error("Connessione interrotta."));
    };
    xhr.ontimeout = () => {
      if (settled) return;
      done();
      reject(timeoutError());
    };
    xhr.onabort = () => {
      if (settled) return;
      done();
      reject(abortError());
    };
    xhr.send(blob);
  });
}

/** `api()` with abort support: the fetch is cancelled and rejects with an AbortError. */
function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return api<T>(path, { method: "POST", body: JSON.stringify(body), signal });
}

function complete(
  sessionId: string,
  parts: { partNumber: number; etag: string }[],
  signal?: AbortSignal,
): Promise<UploadCompleteResponse> {
  return post<UploadCompleteResponse>(`/v1/uploads/${sessionId}/complete`, { parts }, signal);
}

/** Single PUT or multipart (by `created.mode`) of `file` into the session, then `complete`. */
async function transfer(
  created: UploadInitResponse,
  file: Blob,
  contentType: ImageType,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<UploadCompleteResponse> {
  const total = file.size;
  if (created.mode === "single") {
    if (!created.url) throw new Error("Manca l'url di caricamento.");
    // The presigned PUT is signed with the content type: send the same one.
    await putPart(created.url, file, contentType, (loaded) => onProgress(Math.min(loaded, total), total), signal);
    const done = await complete(created.id, [], signal);
    onProgress(total, total);
    return done;
  }

  const partSize = created.partSize ?? 8_388_608;
  const partCount = Math.ceil(total / partSize);
  const parts: { partNumber: number; etag: string }[] = [];
  let uploaded = 0;

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const signed = await post<{ url: string; partNumber: number }>(
      `/v1/uploads/${created.id}/parts`,
      { partNumber },
      signal,
    );
    const start = (partNumber - 1) * partSize;
    const blob = file.slice(start, Math.min(start + partSize, total));
    const etag = await putPart(
      signed.url,
      blob,
      null,
      (loaded) => onProgress(Math.min(total, uploaded + loaded), total),
      signal,
    );
    if (!etag) throw new Error("Manca l'etag del caricamento.");
    uploaded += blob.size;
    onProgress(Math.min(total, uploaded), total);
    parts.push({ partNumber, etag });
  }

  const done = await complete(created.id, parts, signal);
  onProgress(total, total);
  return done;
}

function checkOriginal(file: File): string {
  const filename = safeFilename(file.name);
  if (!filename) throw new Error("Il nome file non è valido.");
  if (file.size < 1) throw new Error("Il file è vuoto.");
  if (file.size > UPLOAD_MAX_BYTES) throw new Error("Il file supera i 60 MB.");
  return filename;
}

/**
 * Today's flow: the original goes up as a fresh photo (`stage: "original"`, no photoId).
 * Progress is in bytes of `file`. Throws ApiError on HTTP errors (409 = already present).
 */
export async function uploadOriginal(
  file: File,
  eventId: string,
  type: ImageType,
  sha256: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const filename = checkOriginal(file);
  onProgress(0, file.size);
  const created = throwIfDeduped(
    await post<UploadInitResponse | AlbumUploadDedupeResponse>(
      "/v1/uploads/init",
      { eventId, filename, contentType: type, sha256, bytes: file.size, stage: "original" },
      signal,
    ),
  );
  const done = await transfer(created, file, type, onProgress, signal);
  return { photoId: done.photoId };
}

/**
 * Web stage: `web` is the 1600 px JPEG rendered from `file`; `sha256` is the ORIGINAL's hash,
 * `type`/`file.size` describe the original the server will later expect. Progress is in bytes of `web`.
 */
export async function uploadWebStage(
  file: File,
  web: Blob,
  eventId: string,
  type: ImageType,
  sha256: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const filename = checkOriginal(file);
  if (web.size < 1) throw new Error("La versione web è vuota.");
  if (web.size > WEB_STAGE_MAX_BYTES) throw new Error("La versione web supera gli 8 MB.");
  onProgress(0, web.size);
  const created = throwIfDeduped(
    await post<UploadInitResponse | AlbumUploadDedupeResponse>(
      "/v1/uploads/init",
      {
        eventId,
        filename,
        contentType: "image/jpeg",
        sha256,
        bytes: web.size,
        stage: "web",
        originalContentType: type,
        originalBytes: file.size,
      },
      signal,
    ),
  );
  const done = await transfer(created, web, "image/jpeg", onProgress, signal);
  return { photoId: done.photoId };
}

/** Original stage for a web-first photo: same bytes/sha the web stage declared, keyed by `photoId`. */
export async function uploadOriginalStage(
  file: File,
  photoId: string,
  eventId: string,
  type: ImageType,
  sha256: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const filename = checkOriginal(file);
  onProgress(0, file.size);
  const created = await post<UploadInitResponse>(
    "/v1/uploads/init",
    { eventId, filename, contentType: type, sha256, bytes: file.size, stage: "original", photoId },
    signal,
  );
  const done = await transfer(created, file, type, onProgress, signal);
  return { photoId: done.photoId || photoId };
}

/** Own photo by (eventId, sha256), or null when unknown. Lets the queue resume the original stage. */
export async function lookupUpload(
  eventId: string,
  sha256: string,
): Promise<{ photoId: string; originalStatus: "pending" | "present" } | null> {
  const query = new URLSearchParams({ eventId, sha256 });
  try {
    const found = await api<UploadLookupResponse>(`/v1/uploads/lookup?${query.toString()}`);
    return { photoId: found.photoId, originalStatus: found.originalStatus };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
}

/** @deprecated Use `uploadOriginal`; kept so existing callers keep compiling. Resolves with the photo id. */
export async function uploadPhoto(
  file: File,
  eventId: string,
  contentType: ImageType,
  sha256: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<string> {
  const outcome = await uploadOriginal(file, eventId, contentType, sha256, onProgress, signal);
  return outcome.photoId;
}

/**
 * v6 (agent C): `uploads/init` answers 200 `{ status: "already-uploaded" }` when the same
 * sha256 is already in the target album — dedup is per album since migration 009, and the
 * server treats it as an answer rather than an error.
 *
 * The upload queue has one well-tested path for "these bytes are already there" and it is
 * keyed on a 409, so the new shape is translated back into that ApiError here instead of
 * being threaded through five call sites. Everything downstream is unchanged.
 */
function throwIfDeduped(
  response: UploadInitResponse | AlbumUploadDedupeResponse,
): UploadInitResponse {
  if ("status" in response && response.status === "already-uploaded") {
    throw new ApiError("Questa foto è già stata caricata.", 409);
  }
  return response as UploadInitResponse;
}
