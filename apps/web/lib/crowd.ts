/*
 * v6 C2/C3 (agent C): the participant side of a crowd album.
 *
 * Thin client over `/v1/albums/:albumId/...`. The composite built by `lib/polaroid.ts` is
 * what gets uploaded; the untouched capture is kept by the caller as the original so the
 * frame can be re-rendered later.
 *
 * 423 is the album's kill switch (`uploads_open = false`): the message is the server's
 * Italian one and is shown as-is.
 */
import { ApiError, api } from "@/lib/api";
import type {
  AlbumPhotosResponse,
  AlbumUploadDedupeResponse,
  CrowdUploadCompleteResponse,
  ReportReason,
  ReportResponse,
  UploadInitResponse,
} from "@/lib/types";
import { contentTypeOf, putWholeObject, sha256Hex } from "@/lib/upload";

export type CrowdUploadOutcome =
  | { status: "uploaded"; photoId: string }
  | { status: "auto_rejected"; photoId: string }
  | { status: "already-uploaded"; photoId: string };

/** True when the album's kill switch is off: the only error worth a dedicated message. */
export function isUploadsClosed(error: unknown): boolean {
  return error instanceof ApiError && error.status === 423;
}

export async function listAlbumPhotos(
  albumId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<AlbumPhotosResponse> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return api<AlbumPhotosResponse>(`/v1/albums/${albumId}/photos${suffix}`);
}

export async function reportPhoto(
  photoId: string,
  reason: ReportReason,
  note?: string,
): Promise<ReportResponse> {
  return api<ReportResponse>(`/v1/photos/${photoId}/report`, {
    method: "POST",
    body: JSON.stringify(note ? { reason, note } : { reason }),
  });
}

/**
 * Uploads one composited photo into a crowd album: `init`, one presigned PUT, `complete`.
 *
 * SINGLE-PUT IS THE DELIBERATE CEILING HERE, and this is the decision, written down.
 *
 * What goes up this path is never a camera original: it is always the composite
 * `renderPolaroid` returns, a JPEG capped at POLAROID_LONG_EDGE (1600 px) on its long
 * side — a few hundred KB, two megabytes at the very worst. That is an order of magnitude
 * below the
 * multipart threshold, so parts, per-part presigning, ETag collection and resumability
 * would be machinery that never runs: untested code on the one path a hundred strangers
 * use at once, for a transfer that is one request. If a participant is ever offered the
 * chance to send an UNMODIFIED original (the `accept` input already allows a 60 MB file
 * through the picker, it is just not uploaded as-is), that is the moment to call
 * `uploadOriginal` instead, which has the multipart path and is already exercised by the
 * photographer flow. Until then, `init` answering `mode !== "single"` means something
 * upstream is misconfigured, and this throws rather than guessing.
 *
 * The three things that have nothing to do with size, this path DOES take from the shared
 * uploader, via `putWholeObject`:
 *
 *  - the MinIO proxy rewrite. Locally the api presigns against `localhost:9000`, which the
 *    browser in a compose setup cannot reach; without the rewrite the crowd upload is
 *    simply broken in development while the photographer upload works.
 *  - a per-request timeout. A plain `fetch` on an event-day network can hang forever, and
 *    the camera would sit on "Invio…" with no way out but a reload.
 *  - byte-level progress and abort, so the progress a caller sees is the bytes on the wire
 *    rather than three invented numbers.
 *
 * The type is resolved with `contentTypeOf`, the same function the photographer path uses,
 * rather than a strict `image/jpeg | image/png` test: it normalises the `image/jpg` some
 * iOS pickers report and falls back to the extension when a forwarded file arrives with no
 * type at all — exactly the population a crowd album is made of. It still refuses video,
 * which is out of scope for v6 and must be refused by the client too, not only by the api.
 */
export async function uploadToAlbum(
  albumId: string,
  blob: Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<CrowdUploadOutcome> {
  const named = new File([blob], filename, { type: blob.type });
  const contentType = contentTypeOf(named);
  if (!contentType) throw new Error("Puoi caricare solo foto JPEG o PNG.");
  // Re-wrapped with the resolved type so what is PUT matches what `init` was told.
  const file =
    named.type === contentType ? named : new File([blob], filename, { type: contentType });
  const sha256 = await sha256Hex(file);
  onProgress?.(0.05);
  const created = await api<UploadInitResponse | AlbumUploadDedupeResponse>(
    `/v1/albums/${albumId}/uploads/init`,
    {
      method: "POST",
      body: JSON.stringify({ filename, contentType, sha256, bytes: file.size }),
      ...(signal ? { signal } : {}),
    },
  );
  if ("status" in created && created.status === "already-uploaded") {
    return { status: "already-uploaded", photoId: created.photoId };
  }
  const init = created as UploadInitResponse;
  if (init.mode !== "single" || !init.url) {
    // A composite over the multipart threshold means something is very wrong upstream.
    throw new Error("Caricamento non disponibile per questa foto.");
  }
  // 5% for init, 90% for the bytes, the last 5% for `complete`.
  try {
    await putWholeObject(
      init.url,
      file,
      contentType,
      (loaded, total) => onProgress?.(0.05 + (total > 0 ? (loaded / total) * 0.9 : 0)),
      signal,
    );
  } catch (cause) {
    // The shared uploader speaks of "parts", which means nothing to someone holding a
    // phone. Abort stays as it is so a caller can tell a cancellation from a failure.
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new Error("Caricamento troppo lento. Riprova con una connessione migliore.");
    }
    throw new Error("Caricamento non riuscito. Riprova.");
  }
  onProgress?.(0.95);
  const done = await api<CrowdUploadCompleteResponse>(
    `/v1/albums/${albumId}/uploads/${init.id}/complete`,
    { method: "POST", body: JSON.stringify({ parts: [] }), ...(signal ? { signal } : {}) },
  );
  onProgress?.(1);
  return done.status === "auto_rejected"
    ? { status: "auto_rejected", photoId: done.photoId }
    : { status: "uploaded", photoId: done.photoId };
}
