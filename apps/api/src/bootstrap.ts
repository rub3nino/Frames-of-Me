import type { Database } from "@rephoto/db";
import { parseIpList } from "./net.js";

/**
 * `BOOTSTRAP_ADMINS` (comma-separated emails) become admin users at boot, so a fresh test box
 * can issue the first staff link without SQL. Existing admins are left as they are.
 */
export async function bootstrapAdmins(db: Database, raw: string): Promise<string[]> {
  const created: string[] = [];
  for (const entry of parseIpList(raw)) {
    const email = entry.toLowerCase();
    if (!email.includes("@")) continue;
    await db.createUser({ email, role: "admin" });
    created.push(email);
  }
  return created;
}
