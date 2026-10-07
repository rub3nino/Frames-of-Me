import type { JobType } from "@rephoto/contracts";
import type { ClaimedJob, ClaimOptions, Database, EnqueueJobOptions } from "@rephoto/db";

/** Postgres `jobs` table today. An SQS runner can replace this without changing payloads. */
export interface JobQueue {
  /** With a `dedupeKey` that already has a queued/running job, returns that job's id. */
  enqueue(type: JobType, payload: unknown, opts?: EnqueueJobOptions): Promise<string>;
  /** `excludeTypes`: job types to leave queued (worker circuit breaker on the face service). */
  claim(options?: ClaimOptions): Promise<ClaimedJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<"queued" | "error">;
  /** Immediate terminal failure (non-retryable errors). */
  failTerminal(id: string, error: string): Promise<void>;
  /** Requeue without incrementing attempts. Used for Rekognition throttle and a face service outage. */
  requeue(id: string, error: string): Promise<void>;
  /** Heartbeat of an in-flight job (`claimed_at = now()`), so a long job is not reclaimed as stale. */
  touch(id: string): Promise<void>;
}

export function createQueue(db: Database): JobQueue {
  return {
    enqueue(type, payload, opts) {
      return db.enqueueJob(type, payload, opts);
    },
    claim(options) {
      return db.claimJob(options);
    },
    complete(id) {
      return db.completeJob(id);
    },
    fail(id, error) {
      return db.failJob(id, error);
    },
    failTerminal(id, error) {
      return db.failJobTerminal(id, error);
    },
    requeue(id, error) {
      return db.requeueJob(id, error);
    },
    touch(id) {
      return db.touchJob(id);
    },
  };
}
