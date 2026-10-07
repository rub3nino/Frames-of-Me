"use client";

import { useEffect, useState } from "react";
import type { AdminMetricsV5 } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { formatAge, formatWhen, shortId } from "@/components/admin/shared";

const REFRESH_MS = 10_000;

/** Queue by type with the oldest age, photos by status, last job errors, face-service probe. */
export function StatusSection() {
  const [metrics, setMetrics] = useState<AdminMetricsV5 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancel = false;
    api<AdminMetricsV5>("/v1/admin/metrics")
      .then((data) => {
        if (cancel) return;
        setMetrics(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere i numeri.");
      });
    const id = window.setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [tick]);

  return (
    <section className="block">
      <h2>Stato</h2>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {!metrics && !error ? <p className="status">Caricamento</p> : null}
      {metrics ? (
        <>
          <dl className="metrics">
            <div>
              <dt>Foto ricevute / in elaborazione / indicizzate / errori</dt>
              <dd>
                {metrics.photosByStatus.uploaded} / {metrics.photosByStatus.processing} / {metrics.photosByStatus.indexed} /{" "}
                {metrics.photosByStatus.error}
              </dd>
            </div>
            <div>
              <dt>Volti · gallerie · utenti</dt>
              <dd>
                {metrics.faces} · {metrics.galleries} · {metrics.users}
              </dd>
            </div>
            <div>
              <dt>Coda: in attesa · in corso · in errore</dt>
              <dd>
                {metrics.jobsQueued} · {metrics.jobsRunning} · {metrics.jobsError}
              </dd>
            </div>
            <div>
              <dt>Lavoro più vecchio in attesa</dt>
              <dd>{formatAge(metrics.oldestQueuedSeconds)}</dd>
            </div>
            <div>
              <dt>Face service</dt>
              <dd data-ok={metrics.faceService.ok === null ? "none" : metrics.faceService.ok ? "true" : "false"}>
                {metrics.faceService.ok === null
                  ? "non in uso"
                  : metrics.faceService.ok
                    ? `ok · ${metrics.faceService.ms ?? 0} ms`
                    : "non risponde"}
              </dd>
            </div>
          </dl>
          {metrics.jobsByType.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>In attesa</th>
                    <th>In corso</th>
                    <th>Errore</th>
                    <th>Età max</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.jobsByType.map((row) => (
                    <tr key={row.type}>
                      <td>
                        <code>{row.type}</code>
                      </td>
                      <td>{row.queued}</td>
                      <td>{row.running}</td>
                      <td>{row.error}</td>
                      <td>{formatAge(row.oldestQueuedSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="note">Coda vuota.</p>
          )}
          {metrics.lastErrors.length > 0 ? (
            <>
              <h3>Ultimi errori</h3>
              <ul className="list errors">
                {metrics.lastErrors.map((row) => (
                  <li key={row.id}>
                    <span className="name">
                      <code>{row.type}</code> {shortId(row.id)}
                    </span>
                    <span className="meta">{formatWhen(row.at)}</span>
                    <span className="error-text">{row.error}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="fine">Aggiornato ogni {REFRESH_MS / 1000} secondi.</p>
        </>
      ) : null}
    </section>
  );
}
