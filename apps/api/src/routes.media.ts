import { stream } from "hono/streaming";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { requireUser } from "./http.js";
import { assertPhotoMediaReadable } from "./photo-access.js";
import {
  objectKeyForPhotoVariant,
  type PhotoMediaVariant,
} from "./media-urls.js";

const VARIANTS = new Set<PhotoMediaVariant>(["thumb", "web", "original"]);

export function registerMediaRoutes(app: import("hono").Hono<AppEnv>, deps: AppDeps): void {
  app.get("/v1/media/photos/:photoId/:variant", async (c) => {
    const variant = c.req.param("variant") as PhotoMediaVariant;
    if (!VARIANTS.has(variant)) throw new ApiError(404, MESSAGES.notFound);
    const photoId = c.req.param("photoId");
    const user = requireUser(c);
    const photo = await deps.db.findPhoto(photoId);
    if (!photo) throw new ApiError(404, MESSAGES.notFound);
    await assertPhotoMediaReadable(deps, user, photo);
    const key = objectKeyForPhotoVariant(
      photo.id,
      photo.eventId,
      variant,
      photo.originalKey,
    );
    const object = await deps.objects.stream(key);
    if (!object) throw new ApiError(404, MESSAGES.notFound);
    c.header("Content-Type", object.contentType);
    c.header("Cache-Control", variant === "original" ? "private, no-store" : "private, max-age=600");
    return stream(c, async (streamWriter) => {
      for await (const chunk of object.body) {
        await streamWriter.write(chunk);
      }
    });
  });
}
