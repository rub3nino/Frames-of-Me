/**
 * v6 C2 (agent C): the pluggable screening hook that runs before a crowd upload is
 * published.
 *
 * The frozen decision is post-moderation: a photo is `approved` on arrival and visible at
 * once. The hook is the one thing allowed to contradict that before publication, by
 * answering `auto_rejected`. v6 ships the interface and a no-op default — the actual
 * classifier (a hosted vision API, a local model, a hash blocklist) is a later decision, and
 * nothing in the upload path needs to change when it arrives.
 *
 * The hook sees metadata only, never the bytes: it is called on `uploads/complete`, after the
 * object is stored, and a real implementation fetches what it needs from the object store
 * itself. Keep it fast — it is on the request path of every crowd upload.
 */
import type { AlbumRow } from "@rephoto/db";

export type ScreeningInput = {
  photoId: string;
  albumId: string;
  eventId: string;
  uploaderId: string;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
  bytes: number;
  /** The stored object, so an implementation can fetch and inspect it. */
  objectKey: string;
  album: AlbumRow;
};

/**
 * `approved` publishes, `auto_rejected` withholds. The hook cannot answer `pending` or
 * `rejected`: `pending` is the report threshold's verdict and `rejected` is a human's.
 */
export type ScreeningVerdict = {
  state: "approved" | "auto_rejected";
  /** Short machine-readable label kept in the audit row, e.g. `nsfw:0.97`. */
  reason?: string;
};

export interface Screening {
  screen(input: ScreeningInput): Promise<ScreeningVerdict>;
}

/** The v6 default: everything passes. Replacing this object is the whole integration. */
export const noopScreening: Screening = {
  async screen(): Promise<ScreeningVerdict> {
    return { state: "approved" };
  },
};
