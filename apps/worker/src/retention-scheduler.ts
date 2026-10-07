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
 * `albums.retention_days`. It also does not retry a failed job: five attempts are the queue's
 * business, and what to do after them is an operator decision, not a loop.
 *
 * **The alarm has a destination** (v6 G, second pass): `failed`, `job_error` and `skipped` are
 * mailed through the existing mailer to `RETENTION_ALARM_EMAIL` (or `BOOTSTRAP_ADMINS`), and a
 * single message says so when the event is healthy again. A retention that stops on a Friday
 * keeps personal data past its period, and the log line and the red box on /admin are the
 * diagnosis, not the summons. The suppression state lives in `retention_schedule` next to the
 * claimed window, so a failure that lasts a week is one mail per window — not one per tick,
 * which at 300 s would be 288 identical mails a day and a filtered address, i.e. no alarm at
 * all — and it survives a worker restart. Two caveats, both in deploy/README.md § 11 bis:
 * `never` is not mailed (the same tick claims the window, so the state is transient), and no
 * mail can come from a worker that is not running — that case shows up as `skipped` on the
 * next start and otherwise belongs to uptime monitoring.
 */
import { jobDedupeKey, retentionAlarm, retentionWindowStart } from "@rephoto/contracts";
import type { RetentionAlarm } from "@rephoto/contracts";
import type { RetentionAlarmMail } from "@rephoto/db";
import type { WorkerDeps } from "./handlers.js";

/** Italian, like every other message this system sends. */
const ALARM_SUBJECT: Record<RetentionAlarmMail, string> = {
  failed: "RePhoto: la retention non è stata messa in coda",
  job_error: "RePhoto: il job di retention è finito in errore",
  skipped: "RePhoto: la retention non gira da più di due finestre",
};

const ALARM_BODY: Record<RetentionAlarmMail, string> = {
  failed:
    "La pianificazione ha rivendicato la finestra ma non è riuscita a mettere in coda il job: nessuna foto è stata cancellata in questa finestra.",
  job_error:
    "Il job di retention è stato eseguito ed è finito in errore dopo tutti i tentativi: le foto oltre il periodo di conservazione sono ancora qui.",
  skipped:
    "Nessuna esecuzione da più di due finestre: il worker è stato spento o non è riuscito a rivendicare la finestra. Le foto oltre il periodo di conservazione sono ancora qui.",
};

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
  /** Alarm mails sent on this tick (one per event at most), and resolution mails. */
  mailed: Array<{ eventId: string; alarm: RetentionAlarmMail; kind: "raised" | "resolved" }>;
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
    mailed: [],
  };
  if (!deps.env.RETENTION_SCHEDULER) return result;
  const windowSeconds = deps.env.RETENTION_WINDOW_HOURS * 3600;
  const windowStart = new Date(retentionWindowStart(now.getTime(), windowSeconds));
  result.windowStart = windowStart;
  const rows = await deps.db.listRetentionStatus();
  for (const row of rows) {
    // Read before claiming: the claim resets `last_outcome`, so the previous window's
    // verdict has to be judged first — and a `skipped` must not be erased by the very run
    // that ends the gap. The consequence, documented in deploy/README.md § 11 bis: reaching a
    // window boundary in a bad state costs one more mail, and the "resolved" one follows on
    // the first tick after a good run.
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
      await notify(deps, result, {
        row,
        alarm,
        window: windowStart,
        now,
        detail: row.lastError ?? row.lastJob?.error ?? null,
      });
    } else {
      // Healthy (or not reached yet): if a mail went out for this event, close it.
      await notifyResolved(deps, result, { row, now });
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
      // Mail it now rather than on the next tick: the claim guard makes the (already
      // scheduled) report of the same alarm in the same window a no-op.
      await notify(deps, result, { row, alarm: "failed", window: windowStart, now, detail: message });
    }
  }
  return result;
}

/**
 * One alarm mail, at most once per (event, window, alarm kind). The claim is a conditional
 * update in `retention_schedule`, so the suppression is shared between the worker replicas and
 * survives a restart; the mail is sent only by whoever won it. A send that throws is logged and
 * the claim is released, so the next tick tries again instead of swallowing the alarm.
 */
async function notify(
  deps: WorkerDeps,
  result: RetentionSchedulerRun,
  input: {
    row: { eventId: string; slug: string; claimedAt: Date | null };
    alarm: RetentionAlarmMail;
    window: Date;
    now: Date;
    detail: string | null;
  },
): Promise<void> {
  if (!deps.env.RETENTION_ALARM_MAIL) return;
  const recipients = alarmRecipients(deps);
  if (recipients.length === 0) {
    // Not silent: a deployment with the alarm on and no address is a configuration mistake.
    console.error(
      JSON.stringify({
        ts: input.now.toISOString(),
        alarm: "retention",
        reason: input.alarm,
        event: input.row.slug,
        alarmMail: "no-recipient",
      }),
    );
    return;
  }
  const claimed = await deps.db
    .claimRetentionAlarmMail({
      eventId: input.row.eventId,
      alarm: input.alarm,
      window: input.window,
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          ts: input.now.toISOString(),
          alarm: "retention",
          alarmMail: "claim-failed",
          error: String(error),
        }),
      );
      return false;
    });
  if (!claimed) return;
  const text = [
    ALARM_BODY[input.alarm],
    "",
    `Evento: ${input.row.slug}`,
    `Ultima esecuzione: ${input.row.claimedAt?.toISOString() ?? "mai"}`,
    `Finestra: ${input.window.toISOString()} (${deps.env.RETENTION_WINDOW_HOURS} h)`,
    ...(input.detail === null ? [] : [`Errore: ${input.detail.slice(0, 300)}`]),
    "",
    `Dettagli e bottone «Esegui adesso»: ${deps.env.WEB_ORIGIN.replace(/\/$/, "")}/admin#stato`,
    "",
    "Questo messaggio arriva una volta per finestra finché il problema resta; ne arriva uno anche quando rientra.",
  ].join("\n");
  try {
    for (const to of recipients) {
      await deps.mailer.send({ to, subject: ALARM_SUBJECT[input.alarm], text });
    }
    result.mailed.push({ eventId: input.row.eventId, alarm: input.alarm, kind: "raised" });
  } catch (error) {
    // Release the claim so the next tick retries; otherwise one SMTP hiccup buries the alarm
    // for a whole window.
    await deps.db.clearRetentionAlarmMail(input.row.eventId).catch(() => undefined);
    console.error(
      JSON.stringify({
        ts: input.now.toISOString(),
        alarm: "retention",
        alarmMail: "send-failed",
        event: input.row.slug,
        error: String(error).slice(0, 300),
      }),
    );
  }
}

/** The one message that closes an alarm, so a resolved failure does not stay open in a head. */
async function notifyResolved(
  deps: WorkerDeps,
  result: RetentionSchedulerRun,
  input: { row: { eventId: string; slug: string; claimedAt: Date | null }; now: Date },
): Promise<void> {
  if (!deps.env.RETENTION_ALARM_MAIL) return;
  const previous = await deps.db.clearRetentionAlarmMail(input.row.eventId).catch(() => null);
  if (!previous) return;
  const recipients = alarmRecipients(deps);
  if (recipients.length === 0) return;
  const text = [
    `L'allarme «${previous}» della retention dell'evento ${input.row.slug} è rientrato.`,
    "",
    `Ultima esecuzione: ${input.row.claimedAt?.toISOString() ?? "mai"}`,
    `Stato: ${deps.env.WEB_ORIGIN.replace(/\/$/, "")}/admin#stato`,
  ].join("\n");
  try {
    for (const to of recipients) {
      await deps.mailer.send({ to, subject: "RePhoto: retention rientrata", text });
    }
    result.mailed.push({ eventId: input.row.eventId, alarm: previous, kind: "resolved" });
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: input.now.toISOString(),
        alarm: "retention",
        alarmMail: "resolved-send-failed",
        event: input.row.slug,
        error: String(error).slice(0, 300),
      }),
    );
  }
}

/** `RETENTION_ALARM_EMAIL`, else `BOOTSTRAP_ADMINS`; both are comma-separated. */
export function alarmRecipients(deps: Pick<WorkerDeps, "env">): string[] {
  const configured = splitEmails(deps.env.RETENTION_ALARM_EMAIL);
  return configured.length > 0 ? configured : splitEmails(deps.env.BOOTSTRAP_ADMINS);
}

function splitEmails(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.includes("@")),
    ),
  ];
}
