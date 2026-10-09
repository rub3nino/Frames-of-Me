/**
 * v6 (integration): `POST /v1/auth/register` is one transaction.
 *
 * The failure this guards: `claimEventCode` spends a use of a single-use badge code
 * before the account and the membership exist. Interrupted in between — a redeploy, an
 * OOM kill, a dropped connection — the old four-statement route left the use spent, the
 * account created and the person with no `event_members` row: registered, locked out of
 * the event they came for, and with no self-service way to repair it. On an event day
 * with 6.000 registrations that happens to somebody, in a queue.
 *
 * Only a real database can prove the fix, because the rollback is Postgres's: the test
 * throws inside `transaction` (the stand-in for the process dying) and then checks that
 * `event_codes.uses` is back where it was and the code still works.
 *
 * Runs only with `TEST_DATABASE_URL`, in a scratch database of its own:
 *
 *   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55731/rephoto \
 *     node --import tsx --test packages/db/src/registration.pg.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { migrate } from "./migrate.ts";
import { PostgresDatabase } from "./postgres.ts";
import { createSql, type Sql } from "./sql.ts";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DATABASE = "rephoto_v6_registration_test";

type Fixture = { sql: Sql; db: PostgresDatabase; eventId: string };

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
  const event = await db.createEvent({ slug: "registrazione", name: "Evento" });
  fixture = { sql, db, eventId: event.id };
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

/** The register route's four writes, with an optional death after the one named. */
async function register(
  f: Fixture,
  input: { email: string; code: string; dieAfter?: "claim" | "user" | "password" },
): Promise<string | null> {
  const failure = new Error("the process died mid-registration");
  return await f.db.transaction(async (tx) => {
    const claimed = await tx.claimEventCode(input.code);
    if (!claimed) return null;
    if (input.dieAfter === "claim") throw failure;
    const user = await tx.insertUser(input.email, "participant");
    if (input.dieAfter === "user") throw failure;
    await tx.setUserPassword(user.id, "scrypt$00$00");
    if (input.dieAfter === "password") throw failure;
    await tx.addEventMember({ userId: user.id, eventId: claimed.eventId, source: "event_code" });
    await tx.insertAudit({
      actorId: user.id,
      action: "auth.registered",
      target: `event:${claimed.eventId}`,
      meta: { eventCode: claimed.code, uses: claimed.uses },
    });
    return user.id;
  });
}

describe("registration is atomic (v6 integration)", () => {
  it("a registration interrupted before the membership write leaves the badge code unspent, and the same code still registers", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // A single-use badge code: if the interrupted attempt keeps its use, nobody can ever
    // register with it again, which is exactly the lockout being guarded against.
    await f.db.createEventCode({ eventId: f.eventId, code: "BADGE-UNICO", maxUses: 1 });

    await assert.rejects(
      register(f, { email: "in-coda@example.com", code: "BADGE-UNICO", dieAfter: "password" }),
      /died mid-registration/,
    );

    // Nothing was consumed and nothing was half-created.
    assert.equal((await f.db.findEventCode(f.eventId, "BADGE-UNICO"))?.uses, 0);
    assert.equal(await f.db.findUserByEmailRole("in-coda@example.com", "participant"), null);
    assert.equal(await f.db.listAuditForTarget(`event:${f.eventId}`).then((r) => r.length), 0);

    // And the person in the queue taps "Registrati" again: it works.
    const userId = await register(f, { email: "in-coda@example.com", code: "BADGE-UNICO" });
    assert.ok(userId);
    assert.equal((await f.db.findEventCode(f.eventId, "BADGE-UNICO"))?.uses, 1);
    assert.equal(await f.db.isEventMember(userId, f.eventId), true);
  });

  it("rolls back a death at any of the four statements, so a capped code never leaks a use", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // max_uses 2 and three interrupted attempts: without the rollback the cap would be
    // exhausted before the first person got in.
    await f.db.createEventCode({ eventId: f.eventId, code: "BADGE-DUE", maxUses: 2 });
    for (const dieAfter of ["claim", "user", "password"] as const) {
      await assert.rejects(
        register(f, { email: `${dieAfter}@example.com`, code: "BADGE-DUE", dieAfter }),
        /died mid-registration/,
      );
      assert.equal((await f.db.findEventCode(f.eventId, "BADGE-DUE"))?.uses, 0, dieAfter);
      assert.equal(await f.db.findUserByEmailRole(`${dieAfter}@example.com`, "participant"), null);
    }
    assert.ok(await register(f, { email: "prima@example.com", code: "BADGE-DUE" }));
    assert.ok(await register(f, { email: "seconda@example.com", code: "BADGE-DUE" }));
    assert.equal((await f.db.findEventCode(f.eventId, "BADGE-DUE"))?.uses, 2);
    // The cap is still the cap: the third person is refused, not let in.
    assert.equal(await register(f, { email: "terza@example.com", code: "BADGE-DUE" }), null);
  });

  it("commits the claim, the user, the password and the membership together", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    await f.db.createEventCode({ eventId: f.eventId, code: "BADGE-OK", maxUses: 5 });
    const userId = await register(f, { email: "completa@example.com", code: "BADGE-OK" });
    assert.ok(userId);
    assert.equal((await f.db.findEventCode(f.eventId, "BADGE-OK"))?.uses, 1);
    const login = await f.db.findUserForLogin("completa@example.com", "participant");
    assert.equal(login?.passwordHash, "scrypt$00$00");
    assert.equal((await f.db.findEventMember(userId, f.eventId))?.source, "event_code");
  });

  it("a rolled-back registration does not undo the registrations that already committed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const f = required();
    // The seam is one transaction per registration, so the rollback of a later attempt
    // cannot reach an earlier, committed one — worth pinning down, because the in-memory
    // mirror restores a snapshot of the whole store.
    await f.db.createEventCode({ eventId: f.eventId, code: "BADGE-SEP", maxUses: 3 });
    assert.ok(await register(f, { email: "uno@example.com", code: "BADGE-SEP" }));
    await assert.rejects(
      register(f, { email: "due@example.com", code: "BADGE-SEP", dieAfter: "claim" }),
      /died mid-registration/,
    );
    assert.equal((await f.db.findEventCode(f.eventId, "BADGE-SEP"))?.uses, 1);
    assert.equal(await f.db.findUserByEmailRole("uno@example.com", "participant") !== null, true);
  });
});
