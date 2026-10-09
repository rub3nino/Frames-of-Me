"use client";

/**
 * v6 G (agent G) — the retention schedule on the admin status screen: when the scheduler last
 * enqueued a run, which window it belonged to, when the next one opens, how the last job ended
 * and what needs attention. Before v6 nothing scheduled retention at all and there was nothing
 * to look at.
 */

import { useEffect, useState } from "react";
import type { AdminRetentionSchedule } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { formatWhen, shortId } from "@/components/admin/shared";

const REFRESH_MS = 30_000;

const ALARM_TEXT: Record<string, string> = {
  failed: "La pianificazione non è riuscita a mettere in coda il job: guarda l'errore.",
  job_error: "L'ultimo job di retention è finito in errore: i tentativi sono esauriti.",
  skipped: "Nessuna esecuzione da più di due finestre: il worker è stato giù o è spento.",
  never: "Mai eseguita per questo evento.",
};

const JOB_TEXT: Record<string, string> = {
  queued: "in coda",
  running: "in corso",
  done: "completato",
  error: "errore",
};

export function RetentionSection() {
  const [data, setData] = useState<AdminRetentionSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Event id whose manual run is in flight, then the job id it produced. */
  const [running, setRunning] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Record<string, string>>({});

  /**
   * Runs the retention of one event now, without waiting for the window: the same job and the
   * same queue as the scheduler, with this admin as the audit actor. It does not consume the
   * scheduler's window.
   */
  async function runNow(eventId: string): Promise<void> {
    setRunning(eventId);
    setError(null);
    try {
      const result = await api<{ jobId: string }>("/v1/admin/retention/run", {
        method: "POST",
        body: JSON.stringify({ eventId }),
      });
      setLaunched((current) => ({ ...current, [eventId]: result.jobId }));
      setTick((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo ad avviare la retention.");
    } finally {
      setRunning(null);
    }
  }

  useEffect(() => {
    let cancel = false;
    api<AdminRetentionSchedule>("/v1/admin/retention/schedule")
      .then((value) => {
        if (cancel) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere la pianificazione.");
        }
      });
    const id = window.setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [tick]);

  return (
    <section className="block">
      <h2>Retention</h2>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="status">Caricamento</p> : null}
      {data ? (
        <>
          <p className="fine">
            {data.enabled
              ? `La pianificazione gira nel worker, una finestra ogni ${(data.windowSeconds / 3600).toFixed(0)} ore. Il job cancella le foto oltre la retention dell'evento e degli album che ne hanno una propria.`
              : "La pianificazione è disattivata (RETENTION_SCHEDULER=false): la retention va lanciata a mano o da un cron esterno."}
          </p>
          {data.events.map((event) => (
            <div key={event.eventId}>
              <h3>
                <code>{event.slug}</code> · {event.retentionDays} giorni
              </h3>
              {event.alarm ? (
                <p className="alert" role="alert">
                  {ALARM_TEXT[event.alarm] ?? event.alarm}
                  {event.jobError ? ` — ${event.jobError}` : ""}
                </p>
              ) : null}
              <dl className="metrics compact">
                <div>
                  <dt>Ultima esecuzione</dt>
                  <dd>{formatWhen(event.lastRunAt)}</dd>
                </div>
                <div>
                  <dt>Prossima finestra</dt>
                  <dd>{formatWhen(event.nextRunAt)}</dd>
                </div>
                <div>
                  <dt>Esecuzioni</dt>
                  <dd>{event.runs}</dd>
                </div>
                <div>
                  <dt>Esito della pianificazione</dt>
                  <dd data-ok={event.outcome === "failed" ? "false" : undefined}>
                    {event.outcome === "enqueued"
                      ? "job messo in coda"
                      : event.outcome === "failed"
                        ? "fallita"
                        : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Ultimo job</dt>
                  <dd data-ok={event.jobStatus === "error" ? "false" : undefined}>
                    {event.jobId ? (
                      <>
                        <code>{shortId(event.jobId)}</code> ·{" "}
                        {JOB_TEXT[event.jobStatus ?? ""] ?? event.jobStatus}
                        {event.jobFinishedAt ? ` · ${formatWhen(event.jobFinishedAt)}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
              <div className="actions">
                <button
                  className="button"
                  type="button"
                  disabled={running === event.eventId}
                  onClick={() => void runNow(event.eventId)}
                  title="Mette in coda subito il job di retention di questo evento"
                >
                  {running === event.eventId ? "Avvio…" : "Esegui adesso"}
                </button>
              </div>
              {launched[event.eventId] ? (
                <p className="note" role="status">
                  Job <code>{shortId(launched[event.eventId] ?? "")}</code> messo in coda. Cancella le
                  foto oltre la retention: l&apos;esito compare qui sopra.
                </p>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}
