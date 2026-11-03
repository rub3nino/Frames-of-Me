import type { PhotoRow, UserRow } from "@rephoto/db";
import type { AppDeps } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";

/**
 * Who may stream a photo through `/v1/media/photos/:id/:variant`.
 * Matches gallery feedback / tagging visibility for participants, and album feed gates
 * for crowd albums (`GET /v1/albums/:albumId/photos`).
 */
export async function assertPhotoMediaReadable(
  deps: AppDeps,
  user: Pick<UserRow, "id" | "role" | "email">,
  photo: PhotoRow,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "photographer") {
    if (photo.photographerId === user.id) return;
    if (
      (await deps.db.isEventPhotographer(photo.eventId, user.id)) &&
      (await photoApprovedInAlbumFeed(deps, photo))
    ) {
      return;
    }
    throw new ApiError(403, MESSAGES.forbidden);
  }

  if (user.role === "participant") {
    const album = await deps.db.findAlbum(photo.albumId);
    if (album?.visibility === "staff") {
      throw new ApiError(403, MESSAGES.forbidden);
    }
    if (photo.photographerId === user.id) return;
    const owned = await deps.db.listOwnedPhotos(user.id, photo.eventId, [photo.id]);
    if (owned.length > 0) return;
    if (await participantAlbumFeedPhoto(deps, user, photo)) return;
    throw new ApiError(403, MESSAGES.forbidden);
  }

  throw new ApiError(403, MESSAGES.forbidden);
}

async function photoApprovedInAlbumFeed(deps: AppDeps, photo: PhotoRow): Promise<boolean> {
  if (photo.moderationState !== "approved") return false;
  const rows = await deps.db.listAlbumPhotosByIds(photo.albumId, [photo.id]);
  return rows.length === 1;
}

async function participantAlbumFeedPhoto(
  deps: AppDeps,
  user: Pick<UserRow, "id" | "email">,
  photo: PhotoRow,
): Promise<boolean> {
  if (!(await photoApprovedInAlbumFeed(deps, photo))) return false;
  const album = await deps.db.findAlbum(photo.albumId);
  if (!album || album.eventId !== photo.eventId) return false;
  if (album.visibility === "staff") return false;
  if (!(await deps.db.isEventMember(user.id, photo.eventId))) return false;
  const event = await deps.db.findEventById(photo.eventId);
  if (!event) return false;
  if (
    event.access === "list" &&
    !(await deps.db.isEventParticipant(photo.eventId, user.email.toLowerCase()))
  ) {
    return false;
  }
  return true;
}
