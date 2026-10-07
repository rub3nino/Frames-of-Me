import { serve } from "@hono/node-server";
import { createSql, PostgresDatabase } from "@rephoto/db";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { loadFaceEngine } from "./face.js";
import { bootstrapAdmins, seedStaffCredentials } from "./bootstrap.js";
import { createMailer } from "./mailer.js";
import { createS3ObjectStore } from "./objects.js";
import { createQueue } from "./queue.js";

const env = loadEnv();
const sql = createSql(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
// Migrations and demo seeding run in the one-shot `migrate` service (and `pnpm db:seed`
// in local dev), not here, so the first boot of a multi-replica stack is deterministic.
// These two are idempotent user upserts (not schema changes) and run against the
// already-migrated database: BOOTSTRAP_ADMINS, and the local-only dev staff passwords.
const db = new PostgresDatabase(sql);
await bootstrapAdmins(db, env.BOOTSTRAP_ADMINS);
await seedStaffCredentials(db);
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
