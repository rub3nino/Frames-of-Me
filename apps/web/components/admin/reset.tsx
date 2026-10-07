"use client";

import { useState } from "react";
import type { AdminEvent } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded } from "@/components/admin/shared";

/** Empties the event (photos, galleries, match log, engine collection) through the `reset` job. Double confirm. */
export function ResetSection({ event, onDone }: { event: AdminEvent | null; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  const matches = event !== null && typed.trim() === event.slug;

  async function run() {
    if (!event || !matches) return;
    if (!window.confirm(`Ultimo avviso: cancellare tutte le foto e le gallerie di "${event.slug}"?`)) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      const data = await api<{ jobId: string }>(`/v1/admin/events/${event.id}/reset`, {
        method: "POST",
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      setState(`Reset in coda (lavoro ${data.jobId.slice(0, 8)}). I numeri scendono man mano che il worker avanza.`);
      setTyped("");
      setArmed(false);
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Reset non avviato.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block danger">
      <h2>Reset evento</h2>
      <EventNeeded event={event} />
      {event ? (
        <>
          <p className="note">
            Cancella foto, derivati, volti, gallerie e registro dei confronti di <strong>{event.name}</strong>. L&apos;evento,
            i fotografi e i partecipanti restano. Non si torna indietro.
          </p>
          {!armed ? (
            <div className="actions inline">
              <button className="button quiet" type="button" onClick={() => setArmed(true)}>
                Voglio azzerare l&apos;evento
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <label>
                Scrivi lo slug <code>{event.slug}</code> per confermare
                <input type="text" value={typed} spellCheck={false} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
              </label>
              <div className="actions inline">
                <button className="button primary" type="submit" disabled={!matches || pending}>
                  {pending ? "Avvio…" : "Azzera adesso"}
                </button>
                <button className="button quiet" type="button" onClick={() => setArmed(false)}>
                  Annulla
                </button>
              </div>
            </form>
          )}
        </>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {state ? <p role="status">{state}</p> : null}
    </section>
  );
}
