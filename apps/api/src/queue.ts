import type { JobType } from "@rephoto/contracts";
import type { ClaimedJob, Database } from "@rephoto/db";

/** Postgres `jobs` table today. An SQS runner can replace this without changing payloads. */
export interface JobQueue {
  enqueue(type: JobType, payload: unknown): Promise<void>;
  claim(): Promise<ClaimedJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<"queued" | "error">;
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
  };
}
