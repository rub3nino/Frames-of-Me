import type { Role } from "@rephoto/contracts";
import type { Database } from "@rephoto/db";
import { shouldSeedDemo } from "@rephoto/db";
import { hashPassword } from "./crypto.js";
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

/**
 * Local-only: give the seeded demo staff accounts a known password so an operator can log in
 * with credentials out of the box. Skipped in production (shouldSeedDemo) and never overwrites a
 * password that was already set (so a changed password survives restarts).
 */
export async function seedStaffCredentials(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!shouldSeedDemo(env)) return;
  const accounts: Array<{ email: string; role: Role; password: string }> = [
    { email: "admin@rephoto.local", role: "admin", password: env.DEV_ADMIN_PASSWORD || "rephoto-admin" },
    {
      email: "photographer@rephoto.local",
      role: "photographer",
      password: env.DEV_PHOTOGRAPHER_PASSWORD || "rephoto-foto",
    },
  ];
  for (const acc of accounts) {
    const found = await db.findUserForLogin(acc.email, acc.role);
    if (!found || found.passwordHash) continue;
    await db.setUserPassword(found.user.id, hashPassword(acc.password));
  }
}
