import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell, EventPicker } from "../ui";
import { useAdminEvents } from "../lib/events";
import { api } from "../lib/api";

/* Foto — moderazione.
   Wired to real endpoints:
     GET    /v1/admin/photos?eventId=&status=&sha256=&filename=&tag=&cursor=  (browse/filter)
     GET    /v1/admin/photos/:id                                             (detail)
     DELETE /v1/admin/photos/:id                                            (confirm modal)
   The browse endpoint requires an eventId, so the page picks an event first. */

type Photo = {
  id: string; status: "uploaded" | "processing" | "indexed" | "error";
  sha256: string; filename: string | null; bytes: number; originalStatus: string;
  error: string | null; createdAt: string; tags: string[]; thumbUrl: string | null;
  photographerId: string;
};
type Detail = {
  photo: Photo; webUrl: string | null; thumbUrl: string | null;
  faces: { id: string; externalId: string; confidence: number }[];
  galleries: { userId: string; email: string; score: number; source: string }[];
};

const STATUS: Record<Photo["status"], { label: string; cls: string }> = {
  indexed: { label: "Indicizzata", cls: "badge-success" },
  processing: { label: "In elaborazione", cls: "badge-info" },
  uploaded: { label: "Caricata", cls: "badge-neutral" },
  error: { label: "Errore", cls: "badge-danger" },
};
const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Tutte" }, { key: "uploaded", label: "Caricate" },
  { key: "processing", label: "In elaborazione" }, { key: "indexed", label: "Indicizzate" },
  { key: "error", label: "Errore" },
];
const PAGE = 60;
const fmtBytes = (n: number) => (n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");

export default function Foto() {
  const nav = useNavigate();
  const { events, eventId, setEventId } = useAdminEvents();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [delTarget, setDelTarget] = useState<Photo | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const buildQs = useCallback((cur?: string) => {
    const q = new URLSearchParams();
    q.set("eventId", eventId);
    q.set("limit", String(PAGE));
    if (status !== "all") q.set("status", status);
    const t = query.trim();
    if (t) { if (/^[a-f0-9]{4,64}$/i.test(t)) q.set("sha256", t.toLowerCase()); else q.set("filename", t); }
    if (cur) q.set("cursor", cur);
    return q.toString();
  }, [eventId, status, query]);

  const load = useCallback(async () => {
    if (!eventId) return;
    setPhotos(null); setErr(""); setCursor(null);
    try {
      const d: any = await api.raw(`/admin/photos?${buildQs()}`);
      setPhotos(d.photos || []); setCursor(d.nextCursor || null);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) return nav("/");
      setErr("Impossibile caricare le foto.");
    }
  }, [eventId, buildQs, nav]);

  useEffect(() => { load(); }, [load]);

  async function more() {
    if (!cursor) return;
    try {
      const d: any = await api.raw(`/admin/photos?${buildQs(cursor)}`);
      setPhotos((p) => [...(p || []), ...(d.photos || [])]); setCursor(d.nextCursor || null);
    } catch { /* keep current list */ }
  }

  async function openDetail(id: string) {
    setDetail(null); setDetailBusy(true);
    try { setDetail(await api.raw(`/admin/photos/${id}`) as Detail); }
    catch (e: any) { if (e?.status === 401 || e?.status === 403) nav("/"); }
    finally { setDetailBusy(false); }
  }

  async function confirmDelete() {
    if (!delTarget || delBusy) return;
    setDelBusy(true);
    try {
      await api.raw(`/admin/photos/${delTarget.id}`, { method: "DELETE" });
      setPhotos((p) => (p || []).filter((x) => x.id !== delTarget.id));
      if (detail?.photo.id === delTarget.id) setDetail(null);
      setDelTarget(null);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) nav("/");
    } finally { setDelBusy(false); }
  }

  return (
    <Shell title="Foto" sub="Cerca, ispeziona ed elimina le foto dell'evento selezionato."
      action={<EventPicker events={events} value={eventId} onChange={setEventId} />}>

      <div className="row" style={{ justifyContent: "space-between", gap: "var(--s-4)", marginBottom: "var(--s-5)", flexWrap: "wrap" }}>
        <div className="segmented" role="tablist" aria-label="Filtro stato">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={status === f.key} onClick={() => setStatus(f.key)}>{f.label}</button>
          ))}
        </div>
        <form className="row" style={{ gap: "var(--s-2)" }} onSubmit={(e) => { e.preventDefault(); setQuery(search); }}>
          <input className="input" style={{ minWidth: 240 }} type="search" value={search}
            onChange={(e) => setSearch(e.target.value)} placeholder="Cerca per filename o sha256" aria-label="Cerca foto" />
          <button className="btn btn-secondary btn-sm" type="submit" data-press>Cerca</button>
        </form>
      </div>

      {err && <div className="banner banner-danger" style={{ marginBottom: "var(--s-4)" }}><span>{err}</span></div>}

      {!photos ? (
        <div className="gallery-grid wide-grid">{Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "1" }} />)}</div>
      ) : photos.length === 0 ? (
        <div className="empty"><h3>Nessuna foto per questo filtro.</h3><p>Cambia filtro o termine di ricerca.</p></div>
      ) : (
        <>
          <div className="gallery-grid wide-grid">
            {photos.map((p) => {
              const s = STATUS[p.status];
              return (
                <div className="cell" key={p.id} role="button" tabIndex={0}
                  onClick={() => openDetail(p.id)} onKeyDown={(e) => { if (e.key === "Enter") openDetail(p.id); }}>
                  <div className="photo-tile is-square">
                    {p.thumbUrl ? (
                      <img className="blur-up" src={p.thumbUrl} alt={p.filename || ""} loading="lazy"
                        onLoad={(e) => e.currentTarget.classList.add("is-loaded")}
                        ref={(el) => { if (el?.complete) el.classList.add("is-loaded"); }} />
                    ) : (
                      <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "var(--c-ink-4)", fontSize: "var(--fs-2xs)", fontFamily: "var(--font-mono)", textAlign: "center", padding: 8 }}>
                        {s.label}
                      </div>
                    )}
                  </div>
                  <span className={"badge " + s.cls} style={{ position: "absolute", top: 10, left: 10, boxShadow: "var(--shadow-xs)" }}>{s.label}</span>
                  {p.status === "error" && p.error && (
                    <span style={{ position: "absolute", left: 10, bottom: 10, fontFamily: "var(--font-mono)", fontSize: "var(--fs-2xs)", background: "rgba(0,0,0,.55)", color: "#fff", padding: "4px 9px", borderRadius: "var(--r-pill)", maxWidth: "80%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.error}</span>
                  )}
                  <button className="icon-btn" type="button" aria-label="Elimina foto"
                    onClick={(e) => { e.stopPropagation(); setDelTarget(p); }}
                    style={{ position: "absolute", top: 8, right: 8, width: 32, height: 32, background: "rgba(255,255,255,.82)", backdropFilter: "blur(6px)" }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /><path d="M10 11v7M14 11v7" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
          {cursor && <div className="row" style={{ justifyContent: "center", marginTop: "var(--s-6)" }}><button className="btn btn-secondary" onClick={more} data-press>Carica altre</button></div>}
        </>
      )}

      {/* Detail — GET /v1/admin/photos/:id */}
      <div className="scrim" data-state={detail || detailBusy ? "open" : "closed"} onClick={() => { setDetail(null); setDetailBusy(false); }} />
      <div className="modal" data-state={detail || detailBusy ? "open" : "closed"} role="dialog" aria-label="Dettaglio foto" style={{ width: "min(620px, calc(100vw - 2*var(--s-5)))" }}>
        {detailBusy && !detail ? (
          <div className="skeleton" style={{ height: 240 }} />
        ) : detail ? (
          <>
            <div className="row" style={{ gap: "var(--s-5)", alignItems: "flex-start" }}>
              <div style={{ flex: "0 0 200px" }}>
                <div className="photo-tile is-square" style={{ aspectRatio: "1" }}>
                  {detail.webUrl || detail.thumbUrl ? <img src={(detail.webUrl || detail.thumbUrl) as string} alt="" /> : <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--c-ink-4)" }}>—</div>}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--s-3)" }}>
                  <h3 style={{ margin: 0 }}>{detail.photo.filename || "Foto"}</h3>
                  <span className={"badge " + STATUS[detail.photo.status].cls}>{STATUS[detail.photo.status].label}</span>
                </div>
                <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: "var(--fs-sm)", margin: 0 }}>
                  <dt style={{ color: "var(--c-ink-3)" }}>sha256</dt><dd className="mono" style={{ margin: 0, fontSize: "var(--fs-xs)", overflowWrap: "anywhere" }}>{detail.photo.sha256}</dd>
                  <dt style={{ color: "var(--c-ink-3)" }}>Dimensione</dt><dd className="mono" style={{ margin: 0 }}>{fmtBytes(detail.photo.bytes)}</dd>
                  <dt style={{ color: "var(--c-ink-3)" }}>Originale</dt><dd style={{ margin: 0 }}>{detail.photo.originalStatus}</dd>
                  <dt style={{ color: "var(--c-ink-3)" }}>Volti</dt><dd style={{ margin: 0 }}>{detail.faces.length}</dd>
                  {detail.photo.error && (<><dt style={{ color: "var(--c-danger-ink)" }}>Errore</dt><dd className="mono" style={{ margin: 0, color: "var(--c-danger-ink)", fontSize: "var(--fs-xs)" }}>{detail.photo.error}</dd></>)}
                </dl>
              </div>
            </div>
            <div style={{ marginTop: "var(--s-5)" }}>
              <div className="label" style={{ marginBottom: "var(--s-2)" }}>In {detail.galleries.length} galleri{detail.galleries.length === 1 ? "a" : "e"}</div>
              {detail.galleries.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {detail.galleries.map((g) => (
                    <div key={g.userId} className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)", color: "var(--c-ink-2)" }}>
                      <span>{g.email}</span>
                      <span className="mono">{g.source} · {g.score.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>Non compare in nessuna galleria.</p>}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
              <button className="btn btn-secondary" onClick={() => setDetail(null)}>Chiudi</button>
              <button className="btn btn-danger" onClick={() => { const t = detail.photo; setDetail(null); setDelTarget(t); }} data-press>Elimina foto</button>
            </div>
          </>
        ) : null}
      </div>

      {/* Delete confirm — DELETE /v1/admin/photos/:id */}
      <div className="scrim" data-state={delTarget ? "open" : "closed"} onClick={() => !delBusy && setDelTarget(null)} />
      <div className="modal" data-state={delTarget ? "open" : "closed"} role="alertdialog" aria-label="Eliminare la foto">
        <h3 style={{ marginBottom: "var(--s-3)" }}>Eliminare la foto?</h3>
        <p style={{ color: "var(--c-ink-2)", fontSize: "var(--fs-sm)" }}>L'operazione è <strong>irreversibile</strong>: la foto viene rimossa dall'archivio e dalla collezione di riconoscimento. Non potrà più comparire in nessuna galleria.</p>
        <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
          <button className="btn btn-secondary" onClick={() => setDelTarget(null)} disabled={delBusy}>Annulla</button>
          <button className="btn btn-danger" onClick={confirmDelete} disabled={delBusy} data-press>{delBusy ? "Elimino…" : "Elimina foto"}</button>
        </div>
      </div>
    </Shell>
  );
}
