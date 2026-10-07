/**
 * v6 G (agent G) — the retention scheduler.
 *
 * The `retention` job has worked since v2 and `POST /v1/admin/retention/run` enqueues it,
 * but nothing ever called that route on a schedule: there is no cron, no timer and no systemd
 * unit for it anywhere in `deploy/`, which is the open point "Manca chi chiama `retention/run`
 * il giorno 90" of docs/DPIA.md §10. Ninety days of retention that nobody triggers is not a
 * retention policy.
 *
 * Why here and not a host cron:
 *
 * - it ships with the deployment. A cron line on the VPS is a manual step that does not exist
 *   on a fresh host, is invisible to `docker compose`, is lost on a migration to another
 *   machine and is not in the repository, so no test can see it;
 * - the worker already owns the periodic work of this system (`runHousekeeping` on a 10-minute
 *   timer) and already holds the job queue and the database pool. No new container, no new
 *   credential, no HTTP call to the api, and no admin user needed to authenticate as;
 * - it degrades the way the rest degrades: if the worker is down, nothing is scheduled, and
 *   the `skipped` alarm says so on the admin status screen.
 *
 * Why it is safe to run in every replica: a run is *claimed* in `retention_schedule`
 * (migration 015) with an upsert whose `where` only matches a strictly newer window, so
 * exactly one caller per (event, window) gets the claim even when both replicas tick in the
 * same millisecond. The queue's dedupe key (`retention:<eventId>`) is the second guard.
 *
 * What it does NOT do: decide what to delete. That is the `retention` job
 * (`retainEvent` in handlers.ts), which reads `events.retention_days` and, since v6,
 * `albums.retention_days`.
 */
import { jobDedupeKey, retentionAlarm, retentionWindowStart } from "@rephoto/contracts";
import type { RetentionAlarm } from "@rephoto/contracts";
import type { WorkerDeps } from "./handlers.js";

export type RetentionSchedulerRun = {
  /** Null when `RETENTION_SCHEDULER=false`: the tick did nothing at all. */
  windowStart: Date | null;
  /** Events whose window this process claimed. */
  claimed: string[];
  /** Jobs enqueued (one per claimed event, unless the enqueue failed). */
  enqueued: number;
  /** Claims whose enqueue threw: recorded as `failed`, which raises the alarm. */
  failed: number;
  /** Alarms seen on this tick, logged as error lines too. */
  alarms: Array<{ eventId: string; slug: string; alarm: RetentionAlarm }>;
};

/**
 * One tick. Claims the current window for every event that has not had it yet, enqueues one
 * `retention` job per claim, records the outcome, and reports (and logs) the alarms.
 *
 * Errors never escape: a tick runs on a timer in a long-lived process, so a database blip
 * must leave the process alive. Whatever failed shows up as an alarm on the next tick.
 */
export async function runRetentionScheduler(
  deps: WorkerDeps,
  now: Date = new Date(),
): Promise<RetentionSchedulerRun> {
  const result: RetentionSchedulerRun = {
    windowStart: null,
    claimed: [],
    enqueued: 0,
    failed: 0,
    alarms: [],
  };
  if (!deps.env.RETENTION_SCHEDULER) return result;
  const windowSeconds = deps.env.RETENTION_WINDOW_HOURS * 3600;
  const windowStart = new Date(retentionWindowStart(now.getTime(), windowSeconds));
  result.windowStart = windowStart;
  const rows = await deps.db.listRetentionStatus();
  for (const row of rows) {
    // Read before claiming: the claim resets `last_outcome`, so the previous window's
    // verdict has to be judged first.
    const alarm = retentionAlarm(row, {
      now: now.getTime(),
      windowSeconds,
      enabled: true,
    });
    if (alarm && alarm !== "never") {
      result.alarms.push({ eventId: row.eventId, slug: row.slug, alarm });
      console.error(
        JSON.stringify({
          ts: now.toISOString(),
          alarm: "retention",
          reason: alarm,
          event: row.slug,
          lastRunAt: row.claimedAt?.toISOString() ?? null,
          lastError: row.lastError ?? row.lastJob?.error ?? null,
        }),
      );
    }
    if (row.windowStart !== null && row.windowStart.getTime() >= windowStart.getTime()) {
      continue;
    }
    const claimed = await deps.db.claimRetentionWindow({
      eventId: row.eventId,
      windowStart,
      windowSeconds,
    });
    if (!claimed) continue;
    result.claimed.push(row.eventId);
    // actorId null = "the scheduler", not a person. `audit_log.actor_id` references
    // `users (id)`, so there is no synthetic id to put here (contracts, retentionPayloadSchema).
    const payload = { eventId: row.eventId, actorId: null };
    try {
      const jobId = await deps.queue.enqueue("retention", payload, {
        dedupeKey: jobDedupeKey("retention", payload) ?? `retention:${row.eventId}`,
      });
      await deps.db.recordRetentionRun({
        eventId: row.eventId,
        outcome: "enqueued",
        jobId,
      });
      await deps.db.insertAudit({
        actorId: null,
        action: "retention.scheduled",
        target: `event:${row.eventId}`,
        meta: { jobId, windowStart: windowStart.toISOString(), windowSeconds },
      });
      result.enqueued += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      result.failed += 1;
      try {
        await deps.db.recordRetentionRun({
          eventId: row.eventId,
          outcome: "failed",
          error: message,
        });
      } catch {
        // The database is the thing that just failed: the next tick sees a stale row and
        // raises `skipped`.
      }
      console.error(
        JSON.stringify({
          ts: now.toISOString(),
          alarm: "retention",
          reason: "failed",
          event: row.slug,
          error: message,
        }),
      );
    }
  }
  return result;
}
