import {
  attachPayloadSchema,
  derivePayloadSchema,
  emailPayloadSchema,
  indexPayloadSchema,
  matchPayloadSchema,
  resetPayloadSchema,
  retentionPayloadSchema,
  verifyPayloadSchema,
} from "@rephoto/contracts";
import type { ClaimedJob, ClaimOptions } from "@rephoto/db";
import { FACE_JOB_TYPES } from "./breaker.js";
import {
  applyFinalFailure,
  isNonRetryable,
  runJob,
  type JobLogEntry,
  type JobNote,
  type WorkerDeps,
  type WorkerJob,
} from "./handlers.js";

/** In-flight jobs refresh `claimed_at` this often (STALE_RUNNING_MS is 10 minutes). */
export const HEARTBEAT_MS = 2 * 60 * 1000;

export async function processJob(claimed: ClaimedJob, deps: WorkerDeps): Promise<void> {
  const started = Date.now();
  const parsed = parseJob(claimed.type, claimed.payload);
  const log = (outcome: JobLogEntry["outcome"], error?: string, note?: JobNote): void => {
    const entry: JobLogEntry = {
      ts: new Date().toISOString(),
      job: claimed.id,
      type: claimed.type,
      ms: Date.now() - started,
      outcome,
      ...(error ? { error } : {}),
      ...(note ?? {}),
      ...(deps.env.LOG_IDS && parsed ? payloadIds(parsed) : {}),
    };
    (deps.log ?? defaultLog)(entry);
  };
  if (!parsed) {
    const message = "Payload non valido.";
    await deps.queue.failTerminal(claimed.id, message);
    log("invalid", message);
    return;
  }
  const heartbeat = setInterval(() => {
    deps.queue.touch(claimed.id).catch(() => {
      // A missed heartbeat is harmless: the stale reclaim is ten minutes away.
    });
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  const faceJob = FACE_JOB_TYPES.includes(parsed.type);
  try {
    const note = await runJob(parsed, deps);
    await deps.queue.complete(claimed.id);
    if (faceJob) deps.breaker?.recordSuccess();
    log("done", undefined, note);
  } catch (error) {
    const message = errorText(error);
    if (isFaceServiceUnavailable(error)) {
      // The service is down or slow: like a throttle, the job waits without burning an
      // attempt. Five in a row open the breaker (v5, B).
      await deps.queue.requeue(claimed.id, message);
      log("requeued", message);
      if (deps.breaker?.recordUnavailable()) {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            breaker: "open",
            pauseMs: deps.breaker.remainingMs(),
            paused: FACE_JOB_TYPES,
          }),
        );
      }
      return;
    }
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
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Claim filter honouring the breaker: face jobs stay queued while it is open.
 *
 * v6 hardening H2 (agent H): and the face-service compatibility gate, whose exclusions are
 * merged in. The two are different things — the breaker is a transient pause that closes on
 * the next success, the gate is a standing refusal for a service whose build cannot serve
 * what `index` and `match` ask of it (src/face-compat.ts) — so neither may hide the other.
 */
export function claimOptions(deps: WorkerDeps): ClaimOptions | undefined {
  const breaker = deps.breaker?.excludedTypes();
  const gate = deps.faceGate?.excludedTypes();
  if (!breaker && !gate) return undefined;
  const excluded = [...new Set([...(breaker ?? []), ...(gate ?? [])])];
  return { excludeTypes: excluded };
}

function defaultLog(entry: JobLogEntry): void {
  console.log(JSON.stringify(entry));
}

function payloadIds(job: WorkerJob): Pick<JobLogEntry, "photoId" | "userId" | "eventId"> {
  switch (job.type) {
    case "derive":
    case "index":
    case "attach":
    case "verify":
      return { photoId: job.photoId };
    case "match":
    case "email":
      return { userId: job.userId, eventId: job.eventId };
    case "retention":
    case "reset":
      return { eventId: job.eventId };
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
  if (type === "reset") {
    const parsed = resetPayloadSchema.safeParse(payload);
    return parsed.success ? { type, ...parsed.data } : null;
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

/** The face service is down, unreachable, answered 5xx or timed out (packages/face-engine). */
export function isFaceServiceUnavailable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    String(error.name) === "FaceServiceUnavailable"
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 500);
  }
  return "Elaborazione non riuscita.";
}

export async function pollOnce(deps: WorkerDeps): Promise<boolean> {
  const claimed = await deps.queue.claim(claimOptions(deps));
  if (!claimed) return false;
  await processJob(claimed, deps);
  return true;
}
