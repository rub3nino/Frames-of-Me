/**
 * v6 G (agent G) — the retention cadence, shared by the scheduler (worker) and the admin
 * status route (api) so the two can never disagree about which window is current or about
 * what counts as a problem.
 */

export type RetentionAlarm = "failed" | "job_error" | "skipped" | "never";

/**
 * Start of the window `nowMs` falls in. Windows are fixed-length and aligned to the Unix
 * epoch in UTC, so with the default 24 h they turn over at 00:00 UTC — no stored "next run"
 * to drift, and any number of workers compute the same value for the same instant.
 */
export function retentionWindowStart(nowMs: number, windowSeconds: number): number {
  const size = windowSeconds * 1000;
  return Math.floor(nowMs / size) * size;
}

/**
 * What the admin screen must shout about, in order of precedence:
 *
 * - `failed`    the window was claimed but the job could not be enqueued;
 * - `job_error` the job ran and ended in `error` (its five attempts are spent);
 * - `skipped`   nothing was claimed for more than two windows: a window went by with no
 *               worker running, so photos past their retention are still there;
 * - `never`     the scheduler is enabled and has never run for this event.
 *
 * Returns null when the last run is fine. With the scheduler disabled a never-run event is
 * not an alarm: someone chose a host cron instead (`RETENTION_SCHEDULER=false`).
 */
export function retentionAlarm(
  row: {
    claimedAt: Date | null;
    runs: number;
    lastOutcome: "enqueued" | "failed" | null;
    lastJob: { status: "queued" | "running" | "done" | "error" } | null;
  },
  context: { now: number; windowSeconds: number; enabled: boolean },
): RetentionAlarm | null {
  if (row.lastOutcome === "failed") return "failed";
  if (row.lastJob?.status === "error") return "job_error";
  if (row.runs === 0 || row.claimedAt === null) return context.enabled ? "never" : null;
  if (context.now - row.claimedAt.getTime() > 2 * context.windowSeconds * 1000) return "skipped";
  return null;
}
