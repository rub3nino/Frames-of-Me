import { createSql, PostgresDatabase } from "@rephoto/db";
import { loadEnv } from "@rephoto/api/env";
import { loadFaceEngine } from "@rephoto/api/face";
import { createMailer } from "@rephoto/api/mailer";
import { createS3ObjectStore } from "@rephoto/api/objects";
import { createQueue } from "@rephoto/api/queue";
import { FaceServiceBreaker } from "./breaker.js";
import { checkFaceServiceCompat, FaceServiceGate } from "./face-compat.js";
import type { WorkerDeps } from "./handlers.js";
import { runHousekeeping, runWorkerLoop } from "./loop.js";
import { createCloudWatchPublisher, publishQueueDepth } from "./metrics.js";
// v6 G (agent G): nothing scheduled the retention job before this.
import { runRetentionScheduler } from "./retention-scheduler.js";

const IDLE_MS = 500;
const SHUTDOWN_MS = 60_000;
const HOUSEKEEPING_MS = 10 * 60 * 1000;
const METRICS_MS = 30 * 1000;

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
// The worker never migrates or seeds: the one-shot `migrate` service (and `pnpm db:seed`
// in local dev) owns the schema. The worker starts only after that has completed.
const db = new PostgresDatabase(sql);
const deps: WorkerDeps = {
  env,
  db,
  objects: createS3ObjectStore(env),
  mailer: createMailer(env),
  queue: createQueue(db),
  faces: loadFaceEngine(env),
  breaker: new FaceServiceBreaker(),
  faceGate: new FaceServiceGate(),
};

// v6 hardening H2: before claiming anything, ask the face service which build it is. A
// service whose `max_faces_cap` is below what every `/v1/embed` call will ask for would
// reject each `index` and `match` job with an HTTP 422 — five attempts and a photo in
// `error`, times however many photos the event has, plus a failed gallery for every
// participant who sends a selfie — while `/health` answered `ok`. One probe, one loud line,
// and that work stays queued until the image is right. Only the insightface engine talks to
// the service; `fake` and `rekognition` have nothing to check.
if (env.FACE_ENGINE === "insightface") {
  deps.faceGate?.apply(
    await checkFaceServiceCompat({
      serviceUrl: env.FACE_SERVICE_URL,
      requiredMaxFaces: env.INSIGHTFACE_INDEX_MAX_FACES,
    }),
  );
}

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

const timers: NodeJS.Timeout[] = [];

// Any instance may run housekeeping; the work is idempotent.
const housekeeping = (): void => {
  void runHousekeeping(deps).catch((error: unknown) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), housekeeping: String(error) }));
  });
};
housekeeping();
timers.push(setInterval(housekeeping, HOUSEKEEPING_MS));

// v6 G: the retention scheduler. Every replica ticks; the claim in `retention_schedule`
// makes it exactly one run per event per window (RETENTION_WINDOW_HOURS).
if (env.RETENTION_SCHEDULER) {
  const retention = (): void => {
    void runRetentionScheduler(deps).catch((error: unknown) => {
      console.error(
        JSON.stringify({ ts: new Date().toISOString(), alarm: "retention", reason: "tick", error: String(error) }),
      );
    });
  };
  retention();
  timers.push(setInterval(retention, env.RETENTION_TICK_SECONDS * 1000));
}

if (env.WORKER_PUBLISH_METRICS) {
  const publish = createCloudWatchPublisher(env.AWS_REGION);
  const tick = (): void => {
    void publishQueueDepth(db, publish);
  };
  tick();
  timers.push(setInterval(tick, METRICS_MS));
}

const result = await runWorkerLoop(deps, {
  concurrency: env.WORKER_CONCURRENCY,
  stop: () => stopped,
  idleMs: IDLE_MS,
  shutdownMs: SHUTDOWN_MS,
});
for (const timer of timers) clearInterval(timer);
if (result.abandoned > 0) {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), shutdown: "timeout", abandoned: result.abandoned }),
  );
}

await sql.end({ timeout: 5 });
