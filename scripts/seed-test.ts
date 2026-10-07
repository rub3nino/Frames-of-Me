// Frames of Me — seed a test campaign: events, admin, photographers, participants, sessions.
//
//   node --env-file=.env --import tsx scripts/seed-test.ts \
//     --event conferenza-2026 --name "Conferenza 2026" --photographers 12 --participants 200 \
//     --admin ops@example.com --out ./seed
//
// Writes, under --out (default `.`):
//   cookies-photographers.txt   comma-separated `rephoto_session` values  → k6 SESSION_COOKIES
//   cookies-participants.txt    comma-separated `rephoto_session` values  → k6 PARTICIPANT_COOKIES
//   cookies-admin.txt           one value for the admin
//   users-<slug>.csv            email,role,userId,sessionToken (mode 0600; treat as a secret)
//   subjects.csv                subject,email for scripts/eval (subject = the participant's local part)
//
// Sessions are minted directly (sessions.token_hash = sha256(token), token = 32 random bytes
// base64url, same as apps/api/src/crypto.ts), so no magic link e-mail is needed. Consent is
// recorded for every participant unless --no-consent. Re-running is idempotent for users and
// events; every run mints fresh sessions. --purge-users deletes the generated users instead.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSql, PostgresDatabase } from "@rephoto/db";
import type { Role } from "@rephoto/contracts";
import type { EventAccess, UserRow } from "@rephoto/db";

const HELP = `Frames of Me seed-test — events, users, consents and pre-minted sessions for a test campaign.

Usage:
  node --env-file=.env --import tsx scripts/seed-test.ts --event <slug> [options]

Options:
  --event <slug[,slug2]>   Event slug(s) to create when missing (default: demo)
  --name <text>            Event name (default: the slug); applies to every slug given
  --retention-days <n>     events.retention_days (default 3650)
  --access open|list       events.access (default open); with list the participants are allow-listed
  --admin <email>          Admin user to create (default admin@test.rephoto.local)
  --photographers <n>      Photographers to create and add to the event(s) (default 2)
  --participants <n>       Participants to create, with consent (default 20)
  --domain <domain>        E-mail domain of generated users (default test.rephoto.local)
  --prefix <text>          Local-part prefix: <prefix>photographer-1@…, <prefix>participant-1@… (default "")
  --consent-version <v>    consents.text_version (default 2026-10-08, as the web client sends)
  --no-consent             Skip consent rows (participants will have to accept in the UI)
  --session-days <n>       Session lifetime (default 30)
  --out <dir>              Where to write the cookie/CSV files (default .)
  --purge-users            Delete every user whose e-mail ends with @<domain> (and the admin given)
                           instead of seeding; photographers that still own photos are kept
  --help                   This text

Environment: DATABASE_URL.
`;

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      event: { type: "string", default: "demo" },
      name: { type: "string" },
      "retention-days": { type: "string", default: "3650" },
      access: { type: "string", default: "open" },
      admin: { type: "string", default: "admin@test.rephoto.local" },
      photographers: { type: "string", default: "2" },
      participants: { type: "string", default: "20" },
      domain: { type: "string", default: "test.rephoto.local" },
      prefix: { type: "string", default: "" },
      "consent-version": { type: "string", default: "2026-10-08" },
      "no-consent": { type: "boolean", default: false },
      "session-days": { type: "string", default: "30" },
      out: { type: "string", default: "." },
      "purge-users": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const int = (raw: string, name: string, min: number): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      process.stderr.write(`--${name} must be an integer >= ${min}\n`);
      process.exit(2);
    }
    return n;
  };
  const slugs = (values.event as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const access = values.access as string;
  if (access !== "open" && access !== "list") {
    process.stderr.write("--access must be open or list\n");
    process.exit(2);
  }
  const retentionDays = int(values["retention-days"] as string, "retention-days", 1);
  const photographers = int(values.photographers as string, "photographers", 0);
  const participants = int(values.participants as string, "participants", 0);
  const sessionDays = int(values["session-days"] as string, "session-days", 1);
  const domain = (values.domain as string).toLowerCase();
  const prefix = values.prefix as string;
  const admin = (values.admin as string).toLowerCase();
  const outDir = resolve(values.out as string);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = createSql(databaseUrl, { max: 4 });
  const db = new PostgresDatabase(sql);
  try {
    if (values["purge-users"]) {
      await purgeUsers(sql, domain, admin);
      return;
    }

    // Events: no Database.createEvent in this tree yet (agent D adds one); plain SQL, idempotent.
    const events: Array<{ id: string; slug: string }> = [];
    for (const slug of slugs) {
      await sql`
        insert into events (slug, name, retention_days, access)
        values (${slug}, ${(values.name as string | undefined) ?? slug}, ${retentionDays}, ${access as EventAccess})
        on conflict (slug) do nothing
      `;
      const event = await db.findEventBySlug(slug);
      if (!event) throw new Error(`event insert failed: ${slug}`);
      events.push({ id: event.id, slug: event.slug });
      console.log(`event ${event.slug} (${event.id}) retention=${event.retentionDays}d access=${event.access}`);
    }

    const expiresAt = new Date(Date.now() + sessionDays * 24 * 3600 * 1000);
    const minted: Array<{ user: UserRow; token: string }> = [];
    const mint = async (email: string, role: Role): Promise<{ user: UserRow; token: string }> => {
      const user = await db.createUser({ email, role });
      const token = newToken();
      await db.insertSession({ userId: user.id, tokenHash: sha256Hex(token), expiresAt });
      const entry = { user, token };
      minted.push(entry);
      return entry;
    };

    const adminEntry = await mint(admin, "admin");
    console.log(`admin ${adminEntry.user.email}`);

    const photographerTokens: string[] = [];
    for (let i = 1; i <= photographers; i += 1) {
      const entry = await mint(`${prefix}photographer-${i}@${domain}`, "photographer");
      for (const event of events) await db.addEventPhotographer(event.id, entry.user.id);
      photographerTokens.push(entry.token);
    }
    console.log(`${photographers} photographers (members of ${events.map((e) => e.slug).join(", ")})`);

    const participantTokens: string[] = [];
    const participantEmails: string[] = [];
    for (let i = 1; i <= participants; i += 1) {
      const entry = await mint(`${prefix}participant-${i}@${domain}`, "participant");
      participantTokens.push(entry.token);
      participantEmails.push(entry.user.email);
      if (!values["no-consent"]) {
        for (const event of events) {
          if (await db.hasActiveConsent(entry.user.id, event.id)) continue;
          await db.insertConsent({
            userId: entry.user.id,
            eventId: event.id,
            textVersion: values["consent-version"] as string,
            ip: "127.0.0.1",
            userAgent: "scripts/seed-test.ts",
          });
        }
      }
      if ((i % 100 === 0 || i === participants) && participants > 0) console.log(`participants ${i}/${participants}`);
    }
    if (access === "list" && participantEmails.length > 0) {
      for (const event of events) await db.upsertEventParticipants(event.id, participantEmails);
      console.log("participants allow-listed (events.access = list)");
    }

    await mkdir(outDir, { recursive: true });
    const secret = { mode: 0o600 };
    await writeFile(join(outDir, "cookies-photographers.txt"), photographerTokens.join(",") + "\n", secret);
    await writeFile(join(outDir, "cookies-participants.txt"), participantTokens.join(",") + "\n", secret);
    await writeFile(join(outDir, "cookies-admin.txt"), adminEntry.token + "\n", secret);
    const csv = ["email,role,userId,sessionToken"]
      .concat(minted.map((m) => `${m.user.email},${m.user.role},${m.user.id},${m.token}`))
      .join("\n");
    for (const event of events) await writeFile(join(outDir, `users-${event.slug}.csv`), csv + "\n", secret);
    const subjects = ["subject,email"]
      .concat(participantEmails.map((email) => `${email.split("@")[0]},${email}`))
      .join("\n");
    await writeFile(join(outDir, "subjects.csv"), subjects + "\n");
    console.log(
      `wrote ${outDir}/cookies-{photographers,participants,admin}.txt, users-<slug>.csv, subjects.csv ` +
        `(sessions valid ${sessionDays} days)`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function purgeUsers(sql: ReturnType<typeof createSql>, domain: string, admin: string): Promise<void> {
  const suffix = `%@${domain}`;
  const owners = await sql<{ email: string; photos: number }[]>`
    select u.email, count(p.id)::int as photos
    from users u join photos p on p.photographer_id = u.id
    where u.email like ${suffix} or u.email = ${admin}
    group by u.email
  `;
  for (const owner of owners) console.warn(`kept ${owner.email}: owns ${owner.photos} photos (reset the event first)`);
  const deleted = await sql<{ email: string; role: string }[]>`
    delete from users u
    where (u.email like ${suffix} or u.email = ${admin})
      and not exists (select 1 from photos p where p.photographer_id = u.id)
    returning u.email, u.role
  `;
  console.log(`deleted ${deleted.length} users (sessions, consents, galleries cascade)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
