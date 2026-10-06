import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.js";
import { PostgresDatabase } from "./postgres.js";
import { createSql } from "./sql.js";
import type { Database } from "./types.js";

export async function seedDemo(db: Database): Promise<void> {
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
