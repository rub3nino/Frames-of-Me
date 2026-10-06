import {
  derivePayloadSchema,
  emailPayloadSchema,
  indexPayloadSchema,
  matchPayloadSchema,
} from "@rephoto/contracts";
import type { ClaimedJob } from "@rephoto/db";
import { applyFinalFailure, runJob, type WorkerDeps, type WorkerJob } from "./handlers.js";

export async function processJob(claimed: ClaimedJob, deps: WorkerDeps): Promise<void> {
  const parsed = parseJob(claimed.type, claimed.payload);
  if (!parsed) {
    await deps.queue.fail(claimed.id, "Payload non valido.");
    return;
  }
  try {
    await runJob(parsed, deps);
    await deps.queue.complete(claimed.id);
  } catch (error) {
    const outcome = await deps.queue.fail(claimed.id, errorText(error));
    if (outcome === "error") await applyFinalFailure(parsed, deps);
  }
}

function parseJob(type: string, payload: unknown): WorkerJob | null {
  if (type === "derive") {
    const parsed = derivePayloadSchema.safeParse(payload);
    return parsed.success ? { type, photoId: parsed.data.photoId } : null;
  }
  if (type === "index") {
    const parsed = indexPayloadSchema.safeParse(payload);
    return parsed.success ? { type, photoId: parsed.data.photoId } : null;
  }
  if (type === "match") {
    const parsed = matchPayloadSchema.safeParse(payload);
    return parsed.success ? { type, ...parsed.data } : null;
  }
  if (type === "email") {
    const parsed = emailPayloadSchema.safeParse(payload);
    return parsed.success ? { type, ...parsed.data } : null;
  }
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 500);
  }
  return "Elaborazione non riuscita.";
}

export async function pollOnce(deps: WorkerDeps): Promise<boolean> {
  const claimed = await deps.queue.claim();
  if (!claimed) return false;
  await processJob(claimed, deps);
  return true;
}
