import type { JobType } from "@rephoto/contracts";
import type { ClaimedJob, Database } from "@rephoto/db";

/** Postgres `jobs` table today. An SQS runner can replace this without changing payloads. */
export interface JobQueue {
  enqueue(type: JobType, payload: unknown): Promise<string>;
  claim(): Promise<ClaimedJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<"queued" | "error">;
  /** Requeue without incrementing attempts. Used for Rekognition throttle. */
  requeue(id: string, error: string): Promise<void>;
}

export function createQueue(db: Database): JobQueue {
  return {
    enqueue(type, payload) {
      return db.enqueueJob(type, payload);
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
    requeue(id, error) {
      return db.requeueJob(id, error);
    },
  };
}
