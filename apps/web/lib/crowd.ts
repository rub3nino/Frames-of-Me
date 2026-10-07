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
import { isAcceptedImage } from "@/lib/polaroid";
import type {
  AlbumPhotosResponse,
  AlbumUploadDedupeResponse,
  CrowdUploadCompleteResponse,
  ReportReason,
  ReportResponse,
  UploadInitResponse,
} from "@/lib/types";
import { sha256Hex, type ImageType } from "@/lib/upload";

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
 * Uploads one composited photo into a crowd album: `init`, a single presigned PUT (a
 * composite is always well under the multipart threshold), then `complete`.
 *
 * `blob.type` is checked before anything is sent: video is out of scope for v6 and must be
 * refused by the client too, not only by the api.
 */
export async function uploadToAlbum(
  albumId: string,
  blob: Blob,
  filename: string,
  onProgress?: (fraction: number) => void,
): Promise<CrowdUploadOutcome> {
  if (!isAcceptedImage(blob.type)) throw new Error("Puoi caricare solo foto JPEG o PNG.");
  const contentType = blob.type.split(";")[0]?.trim() as ImageType;
  const file = new File([blob], filename, { type: contentType });
  const sha256 = await sha256Hex(file);
  onProgress?.(0.1);
  const created = await api<UploadInitResponse | AlbumUploadDedupeResponse>(
    `/v1/albums/${albumId}/uploads/init`,
    {
      method: "POST",
      body: JSON.stringify({ filename, contentType, sha256, bytes: file.size }),
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
  const put = await fetch(init.url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!put.ok) throw new Error("Caricamento non riuscito. Riprova.");
  onProgress?.(0.8);
  const done = await api<CrowdUploadCompleteResponse>(
    `/v1/albums/${albumId}/uploads/${init.id}/complete`,
    { method: "POST", body: JSON.stringify({ parts: [] }) },
  );
  onProgress?.(1);
  return done.status === "auto_rejected"
    ? { status: "auto_rejected", photoId: done.photoId }
    : { status: "uploaded", photoId: done.photoId };
}
