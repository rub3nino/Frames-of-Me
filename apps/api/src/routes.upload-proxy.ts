import { API_UPLOAD_MAX_BYTES } from "@rephoto/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppDeps, AppEnv } from "./deps.js";
import { ApiError, MESSAGES } from "./errors.js";
import { requireRole, requireUser } from "./http.js";
import { ownUpload } from "./routes.js";

async function readUploadBody(
  c: { req: { arrayBuffer: () => Promise<ArrayBuffer> } },
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength < 1) throw new ApiError(400, MESSAGES.validation);
  if (buffer.byteLength > maxBytes) throw new ApiError(400, MESSAGES.validation);
  return new Uint8Array(buffer);
}

function registerPhotographerUploadProxy(app: Hono<AppEnv>, deps: AppDeps): void {
  app.put("/v1/uploads/:id/object", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const session = await ownUpload(deps, c.req.param("id"), user.id);
    if (session.s3UploadId) throw new ApiError(400, MESSAGES.validation);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    if (session.bytes == null) throw new ApiError(400, MESSAGES.validation);
    const body = await readUploadBody(c, Math.min(session.bytes, API_UPLOAD_MAX_BYTES));
    if (body.byteLength !== session.bytes) throw new ApiError(400, MESSAGES.validation);
    const contentType = c.req.header("content-type") ?? session.contentType;
    if (contentType !== session.contentType) throw new ApiError(400, MESSAGES.validation);
    await deps.objects.put(session.objectKey, body, session.contentType);
    return c.body(null, 204);
  });

  app.put("/v1/uploads/:id/parts/:partNumber", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["photographer"]);
    const session = await ownUpload(deps, c.req.param("id"), user.id);
    if (!session.s3UploadId) throw new ApiError(400, MESSAGES.validation);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    const partNumber = Number(c.req.param("partNumber"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ApiError(400, MESSAGES.validation);
    }
    const body = await readUploadBody(c, API_UPLOAD_MAX_BYTES);
    const etag = await deps.objects.uploadPart(
      session.objectKey,
      session.s3UploadId,
      partNumber,
      body,
    );
    c.header("ETag", `"${etag}"`);
    return c.body(null, 204);
  });
}

export function registerUploadProxyRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const upload = new Hono<AppEnv>();
  upload.use(
    "*",
    bodyLimit({
      maxSize: API_UPLOAD_MAX_BYTES,
      onError: (c) => c.json({ error: MESSAGES.validation }, 413),
    }),
  );
  registerPhotographerUploadProxy(upload, deps);
  registerCrowdUploadProxy(upload, deps);
  app.route("/", upload);
}

function registerCrowdUploadProxy(app: Hono<AppEnv>, deps: AppDeps): void {
  app.put("/v1/albums/:albumId/uploads/:id/object", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const albumId = c.req.param("albumId");
    const session = await ownCrowdUploadProxy(deps, c.req.param("id"), user.id, albumId);
    if (session.s3UploadId) throw new ApiError(400, MESSAGES.validation);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    if (session.bytes == null) throw new ApiError(400, MESSAGES.validation);
    const body = await readUploadBody(c, Math.min(session.bytes, API_UPLOAD_MAX_BYTES));
    if (body.byteLength !== session.bytes) throw new ApiError(400, MESSAGES.validation);
    const contentType = c.req.header("content-type") ?? session.contentType;
    if (contentType !== session.contentType) throw new ApiError(400, MESSAGES.validation);
    await deps.objects.put(session.objectKey, body, session.contentType);
    return c.body(null, 204);
  });

  app.put("/v1/albums/:albumId/uploads/:id/parts/:partNumber", async (c) => {
    const user = requireUser(c);
    requireRole(user, ["participant"]);
    const albumId = c.req.param("albumId");
    const session = await ownCrowdUploadProxy(deps, c.req.param("id"), user.id, albumId);
    if (!session.s3UploadId) throw new ApiError(400, MESSAGES.validation);
    if (session.status !== "open") throw new ApiError(409, MESSAGES.conflict);
    const partNumber = Number(c.req.param("partNumber"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ApiError(400, MESSAGES.validation);
    }
    const body = await readUploadBody(c, API_UPLOAD_MAX_BYTES);
    const etag = await deps.objects.uploadPart(
      session.objectKey,
      session.s3UploadId,
      partNumber,
      body,
    );
    c.header("ETag", `"${etag}"`);
    return c.body(null, 204);
  });
}

async function ownCrowdUploadProxy(
  deps: AppDeps,
  sessionId: string,
  userId: string,
  albumId: string,
) {
  const session = await deps.db.findUploadSession(sessionId);
  if (!session || session.photographerId !== userId || session.albumId !== albumId) {
    throw new ApiError(404, MESSAGES.notFound);
  }
  return session;
}
