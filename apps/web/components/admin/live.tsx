"use client";

import { useEffect, useState } from "react";
import type { AdminEvent, AdminEventStatus } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatAge, formatWhen, shortId } from "@/components/admin/shared";
import { KIND_LABEL, MODERATION_LABEL } from "@/lib/album-rules";

/**
 * v6 D (agent D): the live event status — one screen, auto-refreshing.
 *
 * It extends the v5 `Stato` panel (`GET /v1/admin/metrics`, which stays untouched because
 * four agents are in that file) with the per-event numbers of the event day:
 * `GET /v1/admin/events/:id/status`. Media ingested, queue depth and oldest age per job
 * type, indexed, errors, selfies waiting, uploads open/closed per album, last 20 errors.
 */

/** Mirrors `ADMIN_STATUS_REFRESH_MS` in packages/contracts/src/http.ts (tsc here cannot read it). */
const REFRESH_MS = 5_000;

export function LiveSection({ event }: { event: AdminEvent | null }) {
  const [status, setStatus] = useState<AdminEventStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!event) return;
    let cancel = false;
    api<AdminEventStatus>(`/v1/admin/events/${event.id}/status`)
      .then((data) => {
        if (cancel) return;
        setStatus(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere lo stato.");
      });
    const id = window.setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [event, tick]);

  return (
    <section className="block">
      <h2>Diretta</h2>
      <EventNeeded event={event} />
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {!status && !error && event ? <p className="status">Caricamento</p> : null}
      {status ? (
        <>
          <dl className="metrics">
            <div>
              <dt>Foto ricevute</dt>
              <dd>{status.photos}</dd>
            </div>
            <div>
              <dt>In arrivo / in elaborazione / indicizzate / in errore</dt>
              <dd>
                {status.photosByStatus.uploaded} / {status.photosByStatus.processing} /{" "}
                {status.photosByStatus.indexed} / {status.photosByStatus.error}
              </dd>
            </div>
            <div>
              <dt>Originali ancora da caricare</dt>
              <dd>{status.originalsPending}</dd>
            </div>
            <div>
              <dt>Volti indicizzati</dt>
              <dd>{status.faces}</dd>
            </div>
            <div>
              <dt>Gallerie personali · con match</dt>
              <dd>
                {status.galleries} · {status.galleriesMatched}
              </dd>
            </div>
            <div>
              <dt>Selfie in attesa (galleria senza match · lavori di match)</dt>
              <dd>
                {status.selfiesWaiting} · {status.matchJobsPending}
              </dd>
            </div>
            <div>
              <dt>Lavoro più vecchio in attesa</dt>
              <dd>{formatAge(status.oldestQueuedSeconds)}</dd>
            </div>
            <div>
              <dt>Face service</dt>
              <dd data-ok={status.faceService.ok === null ? "none" : status.faceService.ok ? "true" : "false"}>
                {status.faceService.ok === null
                  ? "non in uso"
                  : status.faceService.ok
                    ? `ok · ${status.faceService.ms ?? 0} ms`
                    : "non risponde"}
              </dd>
            </div>
          </dl>

          <h3>Album</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Album</th>
                  <th>Tipo</th>
                  <th>Caricamenti</th>
                  <th>Riconoscimento</th>
                  <th>Moderazione</th>
                  <th>Foto</th>
                  <th>Prima foto</th>
                </tr>
              </thead>
              <tbody>
                {status.albums.map((album) => (
                  <tr key={album.id}>
                    <td>
                      {album.name} <code>{album.slug}</code>
                    </td>
                    <td>{KIND_LABEL[album.kind]}</td>
                    <td data-ok={album.uploadsOpen ? "true" : "false"}>
                      {album.uploadsOpen ? "aperti" : "chiusi"}
                    </td>
                    <td>{album.recognition ? "sì" : "no"}</td>
                    <td>{MODERATION_LABEL[album.moderation]}</td>
                    <td>{album.photos}</td>
                    <td>{album.firstUploadAt ? formatWhen(album.firstUploadAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Coda</h3>
          {status.jobsByType.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>In attesa</th>
                    <th>In corso</th>
                    <th>Errore</th>
                    <th>Attesa più lunga</th>
                  </tr>
                </thead>
                <tbody>
                  {status.jobsByType.map((row) => (
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

          {status.lastErrors.length > 0 ? (
            <>
              <h3>Ultimi errori</h3>
              <ul className="list errors">
                {status.lastErrors.map((row) => (
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
          <p className="fine">
            Aggiornato ogni {REFRESH_MS / 1000} secondi · ultimo dato {formatWhen(status.at)}. La coda e
            gli errori sono di tutta l&apos;istanza, i numeri delle foto sono di questo evento.
          </p>
        </>
      ) : null}
    </section>
  );
}
