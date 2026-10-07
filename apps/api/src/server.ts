import { serve } from "@hono/node-server";
import { createSql, migrate, PostgresDatabase, seedDemo } from "@rephoto/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { loadFaceEngine } from "./face.js";
import { bootstrapAdmins } from "./bootstrap.js";
import { createMailer } from "./mailer.js";
import { createS3ObjectStore } from "./objects.js";
import { createQueue } from "./queue.js";

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
await migrate(sql);
const db = new PostgresDatabase(sql);
await seedDemo(db);
await bootstrapAdmins(db, env.BOOTSTRAP_ADMINS);
const app = createApp({
  env,
  db,
  objects: createS3ObjectStore(env),
  mailer: createMailer(env),
  queue: createQueue(db),
  faces: loadFaceEngine(env),
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`api listening on ${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
