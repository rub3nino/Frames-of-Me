"use client";

import { useState } from "react";
import Link from "next/link";
import type { AdminEvent, AdminGalleriesList, AdminGalleryByEmail, AdminGalleryListRow } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen, reasonText } from "@/components/admin/shared";

/** A participant's gallery by email (grid with score overlay) and the paged list of galleries. */
export function GalleriesSection({ event }: { event: AdminEvent | null }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [gallery, setGallery] = useState<AdminGalleryByEmail | null>(null);
  const [list, setList] = useState<AdminGalleryListRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listPending, setListPending] = useState(false);

  async function search(target: string) {
    if (!event) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      const data = await api<AdminGalleryByEmail>(
        `/v1/admin/galleries?eventId=${event.id}&email=${encodeURIComponent(target.trim())}`,
      );
      setGallery(data);
    } catch (cause) {
      setGallery(null);
      setError(cause instanceof ApiError ? cause.message : "Ricerca non riuscita.");
    } finally {
      setPending(false);
    }
  }

  async function loadList(next: string | null) {
    if (!event) return;
    setListPending(true);
    setError(null);
    try {
      const data = await api<AdminGalleriesList>(
        `/v1/admin/galleries?eventId=${event.id}&limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setList((current) => (next && current ? [...current, ...data.galleries] : data.galleries));
      setCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Elenco non disponibile.");
    } finally {
      setListPending(false);
    }
  }

  async function remove() {
    if (!event || !gallery?.gallery) return;
    if (!window.confirm(`Eliminare la galleria di ${gallery.user.email}?`)) return;
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/galleries/${gallery.user.id}/${event.id}`, { method: "DELETE" });
      setState("Galleria eliminata.");
      setGallery({ ...gallery, gallery: null, items: [] });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Eliminazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  async function rematch() {
    if (!event || !gallery) return;
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/galleries/${gallery.user.id}/${event.id}/rematch`, { method: "POST" });
      setState("Nuovo confronto in coda.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Confronto non avviato.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Gallerie</h2>
      <EventNeeded event={event} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search(email);
        }}
      >
        <label>
          Email del partecipante
          <input type="email" required value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending || !event}>
            {pending ? "Cerco…" : "Cerca"}
          </button>
          <button className="button quiet" type="button" disabled={listPending || !event} onClick={() => void loadList(null)}>
            {listPending && !list ? "Carico…" : "Elenca tutte"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {state ? <p role="status">{state}</p> : null}

      {gallery ? (
        <div className="admin-gallery">
          <p className="meta">
            {gallery.user.email} · <code>{gallery.user.id}</code>
          </p>
          {gallery.gallery ? (
            <p className="note">
              {gallery.gallery.total} foto · confronto {formatWhen(gallery.gallery.matchedAt)} · ancore{" "}
              {gallery.gallery.anchorFaceIds.length}
              {gallery.gallery.reason ? ` · ${reasonText[gallery.gallery.reason] ?? gallery.gallery.reason}` : ""}
            </p>
          ) : (
            <p className="note">Nessuna galleria: il partecipante non ha ancora inviato un selfie.</p>
          )}
          <div className="actions inline">
            <button className="button quiet" type="button" disabled={pending || !gallery.gallery} onClick={() => void rematch()}>
              Rifai il confronto
            </button>
            <button className="button quiet" type="button" disabled={pending || !gallery.gallery} onClick={() => void remove()}>
              Elimina la galleria
            </button>
          </div>
          {gallery.items.length > 0 ? (
            <div className="grid admin-grid">
              {gallery.items.map((item) => (
                <Link
                  key={item.photoId}
                  className="cell admin-cell"
                  href={`/admin/foto/${item.photoId}`}
                  data-feedback={item.feedback ?? "none"}
                >
                  <img className="thumb is-in" src={item.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  <span className="score-tag">
                    {item.score.toFixed(2)} · {item.source}
                    {item.feedback === "not_me" ? " · non io" : ""}
                  </span>
                  {item.photo.filename ? <span className="file-tag">{item.photo.filename}</span> : null}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {list ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Foto</th>
                <th>Confronto</th>
                <th>Motivo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.userId}>
                  <td>{row.email}</td>
                  <td>{row.total}</td>
                  <td>{formatWhen(row.matchedAt)}</td>
                  <td>{row.reason ? reasonText[row.reason] ?? row.reason : "—"}</td>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setEmail(row.email);
                        void search(row.email);
                      }}
                    >
                      Apri
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor ? (
            <div className="actions inline">
              <button className="button quiet" type="button" disabled={listPending} onClick={() => void loadList(cursor)}>
                {listPending ? "Carico…" : "Altre"}
              </button>
            </div>
          ) : null}
          {list.length === 0 ? <p className="note">Nessuna galleria.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
