import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSql, type Sql } from "./sql.js";

export async function migrate(sql: Sql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const existing = await sql<{ id: string }[]>`
      select id from schema_migrations where id = ${file}
    `;
    if (existing.length > 0) continue;
    const text = await readFile(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (id) values (${file})`;
    });
  }
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
  } finally {
    await sql.end({ timeout: 5 });
  }
}
