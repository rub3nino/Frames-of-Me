import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.js";
import { PostgresDatabase } from "./postgres.js";
import { createSql } from "./sql.js";
import type { Database } from "./types.js";

/** Local compose seeds. Production and SEED_DEMO=false do not insert demo users. */
export function shouldSeedDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SEED_DEMO === "false") return false;
  if (env.NODE_ENV === "production") return false;
  return true;
}

export async function seedDemo(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!shouldSeedDemo(env)) return;
  await db.seedDemo();
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const sql = createSql(databaseUrl);
  try {
    await migrate(sql);
    await seedDemo(new PostgresDatabase(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
