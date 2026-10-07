import { createSql, migrate, PostgresDatabase, seedDemo } from "@rephoto/db";
import { loadEnv } from "@rephoto/api/env";
import { loadFaceEngine } from "@rephoto/api/face";
import { createMailer } from "@rephoto/api/mailer";
import { createS3ObjectStore } from "@rephoto/api/objects";
import { createQueue } from "@rephoto/api/queue";
import type { WorkerDeps } from "./handlers.js";
import { runHousekeeping, runWorkerLoop } from "./loop.js";
import { createCloudWatchPublisher, publishQueueDepth } from "./metrics.js";

const IDLE_MS = 500;
const SHUTDOWN_MS = 60_000;
const HOUSEKEEPING_MS = 10 * 60 * 1000;
const METRICS_MS = 30 * 1000;

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
await migrate(sql);
const db = new PostgresDatabase(sql);
await seedDemo(db);
const deps: WorkerDeps = {
  env,
  db,
  objects: createS3ObjectStore(env),
  mailer: createMailer(env),
  queue: createQueue(db),
  faces: loadFaceEngine(env),
};

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
