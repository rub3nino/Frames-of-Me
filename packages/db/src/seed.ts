import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate.js";
import { PostgresDatabase } from "./postgres.js";
import { createSql } from "./sql.js";
import type { Database } from "./types.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const PHOTOGRAPHER_ID = "00000000-0000-4000-8000-000000000003";
const INVITE_ID = "00000000-0000-4000-8000-000000000004";

export async function seedDemo(db: Database): Promise<void> {
  await db.upsertEvent({
    id: EVENT_ID,
    slug: "demo",
    name: "Demo",
    retentionDays: 90,
  });
  await db.upsertUser({
    id: ADMIN_ID,
    email: "admin@rephoto.local",
    role: "admin",
  });
  await db.upsertUser({
    id: PHOTOGRAPHER_ID,
    email: "photographer@rephoto.local",
    role: "photographer",
  });
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await db.upsertInvite({
    id: INVITE_ID,
    email: "photographer@rephoto.local",
    eventId: EVENT_ID,
    tokenHash: createHash("sha256").update("seed-invite").digest("hex"),
    role: "photographer",
    expiresAt,
    usedAt: new Date(),
  });
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
