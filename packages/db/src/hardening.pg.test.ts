/**
 * v6 hardening H1 (agent H): `password_reset_tokens` (migration 016) against a real
 * Postgres. What only the database can prove:
 *
 * - `consumePasswordResetToken` is atomic — the `used_at is null` guard is in the UPDATE, so
 *   two concurrent confirms of the same token cannot both win;
 * - expiry is evaluated by the server, not by the Node clock;
 * - `setUserPassword` burns the user's open tokens in the same transaction;
 * - the rate-limit count really filters by user and by IP (the `::uuid is null or …` shape
 *   that keeps one prepared statement for both cases);
 * - a deleted user takes their tokens with them (`on delete cascade`).
 *
 * Runs only with `TEST_DATABASE_URL`, in a scratch database of its own:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55485/rephoto \
 *     node --import tsx --test packages/db/src/hardening.pg.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_hardening_test";

type Fixture = { sql: Sql; db: PostgresDatabase; userId: string; otherUserId: string };

let fixture: Fixture | undefined;
let skipReason: string | undefined;
let adminSql: Sql | undefined;

function scratchUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

before(async () => {
  if (!ADMIN_URL) {
    skipReason = "TEST_DATABASE_URL is not set";
    return;
  }
  adminSql = createSql(ADMIN_URL, { max: 1 });
  try {
    await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    await adminSql.unsafe(`create database ${SCRATCH_DATABASE}`);
  } catch (error) {
    skipReason = `TEST_DATABASE_URL unusable: ${(error as Error).message}`;
    return;
  }
  const sql = createSql(scratchUrl(ADMIN_URL), { max: 4 });
  await migrate(sql);
  const db = new PostgresDatabase(sql);
  const user = await db.insertUser("reset@example.com", "participant");
  const other = await db.insertUser("altro@example.com", "participant");
  fixture = { sql, db, userId: user.id, otherUserId: other.id };
});

after(async () => {
  if (fixture) await fixture.sql.end({ timeout: 5 });
  if (adminSql) {
    try {
      await adminSql.unsafe(`drop database if exists ${SCRATCH_DATABASE}`);
    } catch {
      // Leave the scratch database behind rather than failing the run.
    }
    await adminSql.end({ timeout: 5 });
  }
});

function required(): Fixture {
  assert.ok(fixture, skipReason ?? "fixture missing");
  return fixture;
}

function hash(label: string): string {
  return label.padEnd(64, "0");
}

const HOUR = 60 * 60 * 1000;

async function issue(f: Fixture, label: string, options: { ip?: string | null; ttlMs?: number } = {}) {
  await f.db.insertPasswordResetToken({
    userId: f.userId,
    tokenHash: hash(label),
    expiresAt: new Date(Date.now() + (options.ttlMs ?? 15 * 60 * 1000)),
    ip: options.ip ?? null,
  });
}

describe("password_reset_tokens (migration 016)", () => {
  it("consumes a token exactly once, even when two confirms race", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await issue(f, "race");
    const [a, b] = await Promise.all([
      f.db.consumePasswordResetToken(hash("race")),
      f.db.consumePasswordResetToken(hash("race")),
    ]);
    const winners = [a, b].filter((result) => result !== null);
    assert.equal(winners.length, 1, "exactly one confirm may win");
    assert.equal(winners[0]?.userId, f.userId);
    assert.equal(await f.db.consumePasswordResetToken(hash("race")), null);
  });

  it("refuses an expired token and an unknown hash alike", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await issue(f, "expired", { ttlMs: -1000 });
    assert.equal(await f.db.consumePasswordResetToken(hash("expired")), null);
    assert.equal(await f.db.consumePasswordResetToken(hash("mai-esistito")), null);
  });

  it("burns every open token of the user when the password changes", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await issue(f, "aperto-1");
    await issue(f, "aperto-2");
    await f.db.insertPasswordResetToken({
      userId: f.otherUserId,
      tokenHash: hash("altro-utente"),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      ip: null,
    });
    await f.db.setUserPassword(f.userId, "scrypt$fake$hash");
    assert.equal(await f.db.consumePasswordResetToken(hash("aperto-1")), null);
    assert.equal(await f.db.consumePasswordResetToken(hash("aperto-2")), null);
    // Another account's token is untouched.
    const other = await f.db.consumePasswordResetToken(hash("altro-utente"));
    assert.equal(other?.userId, f.otherUserId);
    // The password really was written (the invalidation shares its transaction).
    const login = await f.db.findUserForLogin("reset@example.com", "participant");
    assert.equal(login?.passwordHash, "scrypt$fake$hash");
    assert.equal(await f.db.invalidatePasswordResetTokens(f.userId), 0);
  });

  it("counts for the rate limit by user and by ip, and 0 with neither", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.sql`delete from password_reset_tokens`;
    await issue(f, "ip-a-1", { ip: "203.0.113.7" });
    await issue(f, "ip-a-2", { ip: "203.0.113.7" });
    await issue(f, "ip-b-1", { ip: "198.51.100.3" });
    await f.db.insertPasswordResetToken({
      userId: f.otherUserId,
      tokenHash: hash("ip-a-altro"),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      ip: "203.0.113.7",
    });
    const since = new Date(Date.now() - HOUR);
    assert.equal(await f.db.countPasswordResetTokensSince({ userId: f.userId, since }), 3);
    assert.equal(await f.db.countPasswordResetTokensSince({ ip: "203.0.113.7", since }), 3);
    assert.equal(await f.db.countPasswordResetTokensSince({ ip: "198.51.100.3", since }), 1);
    assert.equal(
      await f.db.countPasswordResetTokensSince({ userId: f.userId, ip: "203.0.113.7", since }),
      2,
    );
    // A used token still counts: the budget is "links mailed", not "links outstanding".
    await f.db.consumePasswordResetToken(hash("ip-b-1"));
    assert.equal(await f.db.countPasswordResetTokensSince({ userId: f.userId, since }), 3);
    // Outside the window, and the degenerate call.
    const future = new Date(Date.now() + HOUR);
    assert.equal(await f.db.countPasswordResetTokensSince({ userId: f.userId, since: future }), 0);
    assert.equal(await f.db.countPasswordResetTokensSince({ since }), 0);
  });

  it("deletes the tokens with the user", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    const doomed = await f.db.insertUser("sparisce@example.com", "participant");
    await f.db.insertPasswordResetToken({
      userId: doomed.id,
      tokenHash: hash("condannato"),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      ip: null,
    });
    await f.sql`delete from users where id = ${doomed.id}`;
    const left = await f.sql<{ count: string }[]>`
      select count(*)::text as count from password_reset_tokens where user_id = ${doomed.id}
    `;
    assert.equal(left[0]?.count, "0");
  });

  it("does not touch magic_links", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.sql`delete from magic_links`;
    await issue(f, "nessun-magic-link");
    await f.db.consumePasswordResetToken(hash("nessun-magic-link"));
    const links = await f.sql<{ count: string }[]>`select count(*)::text as count from magic_links`;
    assert.equal(links[0]?.count, "0", "the reset flow writes no magic link");
  });
});
