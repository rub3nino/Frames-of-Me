"use client";

import { useState } from "react";
import type { AdminEvent, AdminMatchRunsResponse } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen, shortId } from "@/components/admin/shared";

/** The three CSV downloads (same-origin links through the proxy) and the match-run log. */
export function ExportSection({ event }: { event: AdminEvent | null }) {
  const [runs, setRuns] = useState<AdminMatchRunsResponse["runs"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const csv = (name: string) => (event ? `/v1/admin/export/${name}.csv?eventId=${event.id}` : "#");

  async function load(next: string | null) {
    if (!event) return;
    setPending(true);
    setError(null);
    try {
      const params = new URLSearchParams({ eventId: event.id, limit: "50" });
      if (email.trim()) params.set("email", email.trim());
      if (next) params.set("cursor", next);
      const data = await api<AdminMatchRunsResponse>(`/v1/admin/match-runs?${params.toString()}`);
      setRuns((current) => (next && current ? [...current, ...data.runs] : data.runs));
      setCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Registro non disponibile.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Esporta</h2>
      <EventNeeded event={event} />
      {event ? (
        <ul className="list">
          <li>
            <a className="name" href={csv("galleries")} download>
              gallerie.csv
            </a>
            <span className="meta">email, foto, score, sorgente, feedback</span>
          </li>
          <li>
            <a className="name" href={csv("match-hits")} download>
              match-hits.csv
            </a>
            <span className="meta">ogni hit con coseno grezzo (richiede MATCH_LOG=true)</span>
          </li>
          <li>
            <a className="name" href={csv("feedback")} download>
              feedback.csv
            </a>
            <span className="meta">i verdetti &quot;non sono io&quot; dei partecipanti</span>
          </li>
        </ul>
      ) : null}

      <h3>Registro dei confronti</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(null);
        }}
      >
        <label>
          Email (facoltativa)
          <input type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions inline">
          <button className="button quiet" type="submit" disabled={pending || !event}>
            {pending && !runs ? "Carico…" : "Mostra"}
          </button>
        </div>
      </form>
      {runs ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Email</th>
                <th>Liveness</th>
                <th>Motivo</th>
                <th>Volti</th>
                <th>Hit</th>
                <th>Tenuti</th>
                <th>Cos max</th>
                <th>ms</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{formatWhen(run.createdAt)}</td>
                  <td>{run.email}</td>
                  <td>{run.liveness ?? "—"}</td>
                  <td>{run.reason ?? "—"}</td>
                  <td>{run.selfieFaces ?? "—"}</td>
                  <td>{run.hits}</td>
                  <td>{run.kept}</td>
                  <td>{run.maxCosine === null ? "—" : run.maxCosine.toFixed(3)}</td>
                  <td>{run.engineMs ?? "—"}</td>
                  <td>
                    <code>{shortId(run.id)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 ? <p className="note">Nessun confronto registrato (serve MATCH_LOG=true).</p> : null}
          {cursor ? (
            <div className="actions inline">
              <button className="button quiet" type="button" disabled={pending} onClick={() => void load(cursor)}>
                {pending ? "Carico…" : "Altri"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
