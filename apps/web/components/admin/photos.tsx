"use client";

import { useState } from "react";
import Link from "next/link";
import type { AdminEvent, AdminPhotosResponse } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen, shortId } from "@/components/admin/shared";

type PhotoStatus = "" | "uploaded" | "processing" | "indexed" | "error";

/** Photo search by filename / sha256 / status / tag; each row opens `/admin/foto/[id]`. */
export function PhotosSection({ event }: { event: AdminEvent | null }) {
  const [filename, setFilename] = useState("");
  const [sha, setSha] = useState("");
  const [status, setStatus] = useState<PhotoStatus>("");
  const [tag, setTag] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminPhotosResponse["photos"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  function query(next: string | null): string {
    if (!event) return "";
    const params = new URLSearchParams({ eventId: event.id, limit: "50" });
    if (filename.trim()) params.set("filename", filename.trim());
    if (sha.trim()) params.set("sha256", sha.trim().toLowerCase());
    if (status) params.set("status", status);
    if (tag.trim()) params.set("tag", tag.trim());
    if (next) params.set("cursor", next);
    return `/v1/admin/photos?${params.toString()}`;
  }

  async function load(next: string | null) {
    if (!event) return;
    setPending(true);
    setError(null);
    try {
      const data = await api<AdminPhotosResponse>(query(next));
      setRows((current) => (next && current ? [...current, ...data.photos] : data.photos));
      setCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Ricerca non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Foto</h2>
      <EventNeeded event={event} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(null);
        }}
      >
        <div className="field-row">
          <label>
            Nome file (inizia con)
            <input type="text" value={filename} spellCheck={false} autoComplete="off" onChange={(e) => setFilename(e.target.value)} />
          </label>
          <label>
            sha256 (inizia con)
            <input type="text" value={sha} spellCheck={false} autoComplete="off" onChange={(e) => setSha(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label>
            Stato
            <select value={status} onChange={(e) => setStatus(e.target.value as PhotoStatus)}>
              <option value="">tutti</option>
              <option value="uploaded">ricevuta</option>
              <option value="processing">in elaborazione</option>
              <option value="indexed">indicizzata</option>
              <option value="error">errore</option>
            </select>
          </label>
          <label>
            Tag
            <input type="text" value={tag} spellCheck={false} autoComplete="off" onChange={(e) => setTag(e.target.value)} />
          </label>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending || !event}>
            {pending && !rows ? "Cerco…" : "Cerca"}
          </button>
        </div>
      </form>
      {rows ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Nome file</th>
                <th>Stato</th>
                <th>sha256</th>
                <th>Tag</th>
                <th>Caricata</th>
                <th>Errore</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((photo) => (
                <tr key={photo.id}>
                  <td>
                    <Link href={`/admin/foto/${photo.id}`} className="thumb-link">
                      {photo.thumbUrl ? (
                        <img src={photo.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="meta">apri</span>
                      )}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/admin/foto/${photo.id}`}>{photo.filename ?? shortId(photo.id)}</Link>
                  </td>
                  <td>{photo.status}</td>
                  <td>
                    <code>{photo.sha256.slice(0, 12)}</code>
                  </td>
                  <td>{photo.tags.join(", ")}</td>
                  <td>{formatWhen(photo.createdAt)}</td>
                  <td className="meta">{photo.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="note">Nessuna foto.</p> : null}
          {cursor ? (
            <div className="actions inline">
              <button className="button quiet" type="button" disabled={pending} onClick={() => void load(cursor)}>
                {pending ? "Carico…" : "Altre"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
