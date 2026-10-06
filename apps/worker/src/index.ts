import { createSql, migrate, PostgresDatabase, seedDemo } from "@rephoto/db";
import { loadEnv } from "@rephoto/api/env";
import { loadFaceEngine } from "@rephoto/api/face";
import { createMailer } from "@rephoto/api/mailer";
import { createS3ObjectStore } from "@rephoto/api/objects";
import { createQueue } from "@rephoto/api/queue";
import { pollOnce } from "./run.js";

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
await migrate(sql);
const db = new PostgresDatabase(sql);
await seedDemo(db);
const deps = {
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

// One job at a time. A Rekognition throttle is requeued without using an attempt.
while (!stopped) {
  const worked = await pollOnce(deps);
  if (!worked && !stopped) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

await sql.end({ timeout: 5 });
