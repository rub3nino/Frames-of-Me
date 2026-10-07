import type { JobType } from "@rephoto/contracts";
import type { ClaimedJob, Database, EnqueueJobOptions } from "@rephoto/db";

/** Postgres `jobs` table today. An SQS runner can replace this without changing payloads. */
export interface JobQueue {
  /** With a `dedupeKey` that already has a queued/running job, returns that job's id. */
  enqueue(type: JobType, payload: unknown, opts?: EnqueueJobOptions): Promise<string>;
  claim(): Promise<ClaimedJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<"queued" | "error">;
  /** Immediate terminal failure (non-retryable errors). */
  failTerminal(id: string, error: string): Promise<void>;
  /** Requeue without incrementing attempts. Used for Rekognition throttle. */
  requeue(id: string, error: string): Promise<void>;
}

export function createQueue(db: Database): JobQueue {
  return {
    enqueue(type, payload, opts) {
      return db.enqueueJob(type, payload, opts);
    },
    claim() {
      return db.claimJob();
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
  };
}
