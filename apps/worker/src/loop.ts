import type { WorkerDeps } from "./handlers.js";
import { claimOptions, processJob } from "./run.js";

export type LoopOptions = {
  /** Jobs in flight at once. */
  concurrency: number;
  /** Polled between claims; once true no more jobs are claimed. */
  stop: () => boolean;
  /** Sleep when the queue is empty (jittered ±25 %). */
  idleMs: number;
  /** How long to wait for in-flight jobs after `stop` flips. */
  shutdownMs?: number;
};

export type LoopResult = {
  /** Jobs claimed by this loop. */
  claimed: number;
  /** Jobs still running when the shutdown wait ran out. */
  abandoned: number;
};

const DEFAULT_SHUTDOWN_MS = 60_000;
const JITTER = 0.25;

/**
 * Keeps up to `concurrency` jobs running: claims while a slot is free, sleeps
 * briefly when the queue is empty, and on `stop` waits for in-flight jobs up
 * to `shutdownMs`.
 */
export async function runWorkerLoop(deps: WorkerDeps, options: LoopOptions): Promise<LoopResult> {
  const inFlight = new Set<Promise<void>>();
  let claimed = 0;
  const track = (promise: Promise<void>): void => {
    const tracked: Promise<void> = promise
      .catch((error: unknown) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), error: String(error) }));
      })
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  while (!options.stop()) {
    let gotOne = false;
    while (inFlight.size < options.concurrency && !options.stop()) {
      let job: Awaited<ReturnType<typeof deps.queue.claim>>;
      try {
        job = await deps.queue.claim(claimOptions(deps));
      } catch (error) {
        // A database blip must not kill the process: log it and try again after the idle sleep.
        console.error(JSON.stringify({ ts: new Date().toISOString(), claim: String(error) }));
        break;
      }
      if (!job) break;
      gotOne = true;
      claimed += 1;
      track(processJob(job, deps));
    }
    if (gotOne || options.stop()) continue;
    // Either the queue is empty or every slot is busy: wake on a finished job or after the idle sleep.
    const nap = sleep(jittered(options.idleMs));
    await Promise.race([nap.promise, ...inFlight]);
    nap.cancel();
  }

  const shutdownMs = options.shutdownMs ?? DEFAULT_SHUTDOWN_MS;
  const grace = sleep(shutdownMs);
  const finished = await Promise.race([
    Promise.all(inFlight).then(() => true),
    grace.promise.then(() => false),
  ]);
  grace.cancel();
  return { claimed, abandoned: finished ? 0 : inFlight.size };
}

export type Housekeeping = {
  prunedJobs: number;
  abortedUploads: number;
};

const DONE_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotent and safe to run from every instance: drops `done` jobs older than
 * 7 days and aborts upload sessions left open for more than 24 hours (including
 * their S3 multipart upload, when one was started).
 */
export async function runHousekeeping(deps: WorkerDeps, now = new Date()): Promise<Housekeeping> {
  const prunedJobs = await deps.db.pruneJobs({
    doneOlderThan: new Date(now.getTime() - DONE_JOB_RETENTION_MS),
  });
  const stale = await deps.db.abortStaleUploads({
    olderThan: new Date(now.getTime() - STALE_UPLOAD_MS),
  });
  for (const upload of stale) {
    if (!upload.s3UploadId) continue;
    try {
      await deps.objects.abortMultipartUpload(upload.objectKey, upload.s3UploadId);
    } catch {
      // The upload may already be gone; the session is aborted either way.
    }
  }
  return { prunedJobs, abortedUploads: stale.length };
}

function jittered(ms: number): number {
  const spread = ms * JITTER;
  return Math.max(1, Math.round(ms - spread + Math.random() * 2 * spread));
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
