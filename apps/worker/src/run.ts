import {
  attachPayloadSchema,
  derivePayloadSchema,
  emailPayloadSchema,
  indexPayloadSchema,
  matchPayloadSchema,
  retentionPayloadSchema,
  verifyPayloadSchema,
} from "@rephoto/contracts";
import type { ClaimedJob } from "@rephoto/db";
import {
  applyFinalFailure,
  isNonRetryable,
  runJob,
  type JobLogEntry,
  type WorkerDeps,
  type WorkerJob,
} from "./handlers.js";

export async function processJob(claimed: ClaimedJob, deps: WorkerDeps): Promise<void> {
  const started = Date.now();
  const log = (outcome: JobLogEntry["outcome"], error?: string): void => {
    const entry: JobLogEntry = {
      ts: new Date().toISOString(),
      job: claimed.id,
      type: claimed.type,
      ms: Date.now() - started,
      outcome,
      ...(error ? { error } : {}),
    };
    (deps.log ?? defaultLog)(entry);
  };
  const parsed = parseJob(claimed.type, claimed.payload);
  if (!parsed) {
    const message = "Payload non valido.";
    await deps.queue.failTerminal(claimed.id, message);
    log("invalid", message);
    return;
  }
  try {
    await runJob(parsed, deps);
    await deps.queue.complete(claimed.id);
    log("done");
  } catch (error) {
    const message = errorText(error);
    if (isThrottle(error)) {
      await deps.queue.requeue(claimed.id, message);
      log("requeued", message);
      return;
    }
    if (isNonRetryable(error)) {
      await deps.queue.failTerminal(claimed.id, message);
      await applyFinalFailure(parsed, deps, message);
      log("error", message);
      return;
    }
    const outcome = await deps.queue.fail(claimed.id, message);
    if (outcome === "error") await applyFinalFailure(parsed, deps, message);
    log(outcome === "error" ? "error" : "retry", message);
  }
}

function defaultLog(entry: JobLogEntry): void {
  console.log(JSON.stringify(entry));
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
  if (type === "attach") {
    const parsed = attachPayloadSchema.safeParse(payload);
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
  if (type === "retention") {
    const parsed = retentionPayloadSchema.safeParse(payload);
    return parsed.success ? { type, ...parsed.data } : null;
  }
  if (type === "verify") {
    const parsed = verifyPayloadSchema.safeParse(payload);
    return parsed.success ? { type, photoId: parsed.data.photoId } : null;
  }
  return null;
}

function isThrottle(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = String(error.name);
  return (
    name === "RekognitionThrottleError" ||
    name === "ProvisionedThroughputExceededException" ||
    name === "ThrottlingException"
  );
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
