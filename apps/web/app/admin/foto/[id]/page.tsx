"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AdminNeighbour, AdminPhotoDetail } from "@/lib/types";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/components/admin/shared";

export default function AdminPhotoPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <Shell wide signOut>
      <RequireRole role="admin" probe="/v1/admin/metrics">
        {id ? <PhotoDebug id={id} /> : null}
      </RequireRole>
    </Shell>
  );
}

/** One photo: the web rendition with the face boxes, each face's nearest neighbours, the galleries it sits in. */
function PhotoDebug({ id }: { id: string }) {
  const [detail, setDetail] = useState<AdminPhotoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [neighbours, setNeighbours] = useState<Record<string, AdminNeighbour[] | "loading" | "error">>({});

  useEffect(() => {
    let cancel = false;
    setDetail(null);
    setError(null);
    api<AdminPhotoDetail>(`/v1/admin/photos/${id}`)
      .then((data) => {
        if (!cancel) setDetail(data);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(cause instanceof ApiError ? cause.message : "Foto non trovata.");
      });
    return () => {
      cancel = true;
    };
  }, [id]);

  async function loadNeighbours(externalId: string) {
    if (!detail || neighbours[externalId]) return;
    setNeighbours((current) => ({ ...current, [externalId]: "loading" }));
    try {
      const data = await api<AdminNeighbour[]>(
        `/v1/admin/faces/${encodeURIComponent(externalId)}/neighbours?eventId=${detail.photo.eventId}&limit=20`,
      );
      setNeighbours((current) => ({ ...current, [externalId]: data }));
    } catch {
      setNeighbours((current) => ({ ...current, [externalId]: "error" }));
    }
  }

  if (error) {
    return (
      <div className="stack">
        <h1>Foto</h1>
        <p className="alert" role="alert">
          {error}
        </p>
        <Link className="linkish" href="/admin#foto">
          Torna alle foto
        </Link>
      </div>
    );
  }
  if (!detail) return <p className="status">Caricamento</p>;

  const { photo } = detail;
  return (
    <div className="admin">
      <p className="meta">
        <Link href="/admin#foto">Foto</Link> · {photo.filename ?? photo.id}
      </p>
      <h1>{photo.filename ?? "Foto"}</h1>
      <div className="photo-debug">
        <div className="photo-stage">
          {detail.webUrl ? (
            <div className="photo-frame">
              <img src={detail.webUrl} alt={photo.filename ?? "Foto dell'evento"} referrerPolicy="no-referrer" />
              <svg className="bbox-layer" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                {detail.faces.map((face, index) => (
                  <g key={face.id}>
                    <rect
                      x={face.bbox.x}
                      y={face.bbox.y}
                      width={face.bbox.width}
                      height={face.bbox.height}
                      vectorEffect="non-scaling-stroke"
                      data-active={active === face.externalId ? "true" : "false"}
                    />
                    <text x={face.bbox.x} y={face.bbox.y} dy="-0.006" textLength="0.03" lengthAdjust="spacingAndGlyphs">
                      {index + 1}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          ) : (
            <p className="note">Nessuna versione web ancora.</p>
          )}
        </div>
        <dl className="metrics compact">
          <div>
            <dt>Stato</dt>
            <dd>
              {photo.status}
              {photo.error ? ` · ${photo.error}` : ""}
            </dd>
          </div>
          <div>
            <dt>sha256</dt>
            <dd>
              <code>{photo.sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Identificativo</dt>
            <dd>
              <code>{photo.id}</code>
            </dd>
          </div>
          <div>
            <dt>Originale</dt>
            <dd>
              {photo.contentType} · {(photo.bytes / 1_048_576).toFixed(1)} MB · {photo.originalStatus === "present" ? "presente" : "in arrivo"}
            </dd>
          </div>
          <div>
            <dt>Caricata · indicizzata</dt>
            <dd>
              {formatWhen(photo.createdAt)} · {formatWhen(photo.indexedAt)}
            </dd>
          </div>
          <div>
            <dt>Tag</dt>
            <dd>{photo.tags.length > 0 ? photo.tags.join(", ") : "—"}</dd>
          </div>
        </dl>
      </div>

      <section className="block">
        <h2>Volti ({detail.faces.length})</h2>
        {detail.faces.length === 0 ? <p className="note">Nessun volto indicizzato.</p> : null}
        <ol className="list faces">
          {detail.faces.map((face, index) => {
            const state = neighbours[face.externalId];
            return (
              <li key={face.id} data-active={active === face.externalId ? "true" : "false"}>
                <div className="face-row">
                  <button type="button" className="linkish" onClick={() => setActive(active === face.externalId ? null : face.externalId)}>
                    Volto {index + 1}
                  </button>
                  <span className="meta">
                    conf. {face.confidence.toFixed(2)} · {Math.round(face.bbox.width * 1600)}×{Math.round(face.bbox.height * 1600)} px (su 1600) ·{" "}
                    <code>{face.externalId.slice(0, 8)}</code>
                  </span>
                  <button type="button" className="linkish" onClick={() => void loadNeighbours(face.externalId)} disabled={state === "loading"}>
                    {state === "loading" ? "Cerco…" : "Vicini"}
                  </button>
                </div>
                {Array.isArray(state) ? (
                  state.length === 0 ? (
                    <p className="note">Nessun vicino sopra la soglia.</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Coseno</th>
                          <th>Similarità</th>
                          <th>Foto</th>
                          <th>Volto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.map((hit) => (
                          <tr key={hit.externalFaceId}>
                            <td>{hit.cosine.toFixed(3)}</td>
                            <td>{hit.similarity.toFixed(1)}</td>
                            <td>
                              <Link href={`/admin/foto/${hit.photoId}`}>{hit.photoId.slice(0, 8)}…</Link>
                            </td>
                            <td>
                              <code>{hit.externalFaceId.slice(0, 8)}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : null}
                {state === "error" ? (
                  <p className="alert" role="alert">
                    Vicini non disponibili.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="block">
        <h2>Gallerie ({detail.galleries.length})</h2>
        {detail.galleries.length === 0 ? <p className="note">In nessuna galleria.</p> : null}
        {detail.galleries.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Score</th>
                <th>Sorgente</th>
                <th>Volto</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {detail.galleries.map((row) => (
                <tr key={row.userId}>
                  <td>{row.email}</td>
                  <td>{row.score.toFixed(3)}</td>
                  <td>{row.source}</td>
                  <td>
                    <code>{row.faceId.slice(0, 8)}</code>
                  </td>
                  <td>{row.feedback === "not_me" ? "non sono io" : row.feedback === "me" ? "sono io" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}
