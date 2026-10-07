import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell, EventPicker, isEmail } from "../ui";
import { useAdminEvents } from "../lib/events";
import { api } from "../lib/api";

/* Gallerie & Match.
   Wired to the real endpoint GET /v1/admin/galleries?eventId=...:
     • with &email=  → one participant's gallery (score/source per item, reason, anchors)
     • without email → the paged list of galleries ({ galleries, nextCursor })
   Logic ported from apps/web/components/admin/galleries.tsx, re-skinned here. */

type Item = {
  photoId: string; faceId: string; thumbUrl: string; webUrl: string;
  score: number; source: "match" | "attach"; createdAt: string;
  originalReady: boolean; feedback: "me" | "not_me" | null;
  photo: { sha256: string; filename: string | null };
};
type ByEmail = {
  user: { id: string; email: string };
  gallery: { id: string; matchedAt: string | null; anchorFaceIds: string[]; reason: string | null; total: number } | null;
  items: Item[];
};
type ListRow = { userId: string; email: string; total: number; matchedAt: string | null; reason: string | null };

const PAGE = 50;
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" }) : "—";

export default function Gallerie() {
  const nav = useNavigate();
  const { events, eventId, setEventId } = useAdminEvents();
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<ByEmail | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMsg, setLookupMsg] = useState("");
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const loadList = useCallback(async () => {
    if (!eventId) return;
    setRows(null); setErr(""); setCursor(null);
    try {
      const d: any = await api.raw(`/admin/galleries?eventId=${eventId}&limit=${PAGE}`);
      setRows(d.galleries || []); setCursor(d.nextCursor || null);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) return nav("/");
      if (e?.status === 404) setErr("Evento non trovato.");
      else setErr("Impossibile caricare le gallerie.");
    }
  }, [eventId, nav]);

  useEffect(() => { setFound(null); setLookupMsg(""); loadList(); }, [loadList]);

  async function more() {
    if (!cursor) return;
    try {
      const d: any = await api.raw(`/admin/galleries?eventId=${eventId}&limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      setRows((r) => [...(r || []), ...(d.galleries || [])]); setCursor(d.nextCursor || null);
    } catch { /* keep current list */ }
  }

  const lookup = useCallback(async (addr: string) => {
    if (!isEmail(addr) || !eventId) return;
    setLookupBusy(true); setLookupMsg(""); setFound(null);
    try {
      const d: any = await api.raw(`/admin/galleries?eventId=${eventId}&email=${encodeURIComponent(addr.trim().toLowerCase())}`);
      setFound(d as ByEmail);
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) return nav("/");
      if (e?.status === 404) setLookupMsg("Nessuna galleria per questa email in questo evento.");
      else setLookupMsg("Ricerca non riuscita.");
    } finally { setLookupBusy(false); }
  }, [eventId, nav]);

  return (
    <Shell title="Gallerie & Match" sub="Cerca la galleria di un partecipante o sfoglia tutte le gallerie dell'evento."
      action={<EventPicker events={events} value={eventId} onChange={setEventId} />}>

      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <form className="row" style={{ gap: "var(--s-3)", alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); lookup(email); }}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label className="label">Cerca per email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partecipante@email.it" />
          </div>
          <button className="btn btn-primary" type="submit" disabled={!isEmail(email) || lookupBusy} data-press>{lookupBusy ? "Cerco…" : "Cerca galleria"}</button>
          {found && <button className="btn btn-secondary" type="button" onClick={() => { setFound(null); setEmail(""); setLookupMsg(""); }}>Pulisci</button>}
        </form>
        {lookupMsg && <div className="banner banner-warning" style={{ marginTop: "var(--s-4)" }}><span>{lookupMsg}</span></div>}
      </div>

      {found && (
        <div className="card" style={{ marginBottom: "var(--s-5)" }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "var(--s-3)", marginBottom: "var(--s-4)" }}>
            <div>
              <h3 style={{ margin: 0 }}>{found.user.email}</h3>
              <p className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>
                {found.gallery ? <>Match: {fmtDate(found.gallery.matchedAt)} · {found.gallery.total} foto{found.gallery.reason ? ` · ${found.gallery.reason}` : ""}</> : "Nessuna galleria materializzata."}
              </p>
              {found.gallery && found.gallery.anchorFaceIds.length > 0 && (
                <p className="mono" style={{ fontSize: "var(--fs-2xs)", color: "var(--c-ink-3)", marginTop: 4 }}>anchor: {found.gallery.anchorFaceIds.join(", ")}</p>
              )}
            </div>
            <span className="badge badge-neutral mono">userId: {found.user.id}</span>
          </div>
          {found.items.length > 0 ? (
            <div className="gallery-grid wide-grid">
              {found.items.map((it) => (
                <div className="cell" key={it.photoId} title={`${it.source} · score ${it.score.toFixed(3)}${it.feedback ? " · " + it.feedback : ""}`}>
                  <div className="photo-tile is-square"><img className="blur-up" src={it.thumbUrl} alt={it.photo.filename || ""} loading="lazy"
                    onLoad={(e) => e.currentTarget.classList.add("is-loaded")} ref={(el) => { if (el?.complete) el.classList.add("is-loaded"); }} /></div>
                  <span className={"badge " + (it.source === "match" ? "badge-success" : "badge-info")} style={{ position: "absolute", top: 10, left: 10, boxShadow: "var(--shadow-xs)" }}>{it.score.toFixed(2)}</span>
                  {it.feedback && <span className={"badge " + (it.feedback === "me" ? "badge-success" : "badge-danger")} style={{ position: "absolute", top: 10, right: 10 }}>{it.feedback === "me" ? "sono io" : "non io"}</span>}
                </div>
              ))}
            </div>
          ) : <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>La galleria non contiene foto.</p>}
        </div>
      )}

      {err && <div className="banner banner-danger" style={{ marginBottom: "var(--s-4)" }}><span>{err}</span></div>}

      <p className="section-label" style={{ fontSize: "var(--fs-xs)", color: "var(--c-ink-3)", fontWeight: 500, marginBottom: "var(--s-3)" }}>Tutte le gallerie</p>
      <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead><tr><th>Partecipante</th><th>Foto</th><th>Match</th><th>Motivo</th></tr></thead>
          <tbody>
            {!rows && Array.from({ length: 4 }).map((_, i) => <tr key={i}><td colSpan={4}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
            {rows?.map((r) => (
              <tr key={r.userId} style={{ cursor: "pointer" }} onClick={() => { setEmail(r.email); lookup(r.email); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                <td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{r.email}</td>
                <td className="mono">{r.total}</td>
                <td className="mono" style={{ fontSize: "var(--fs-xs)" }}>{fmtDate(r.matchedAt)}</td>
                <td>{r.reason ? <span className="badge badge-neutral">{r.reason}</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {rows?.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--c-ink-3)", padding: "var(--s-7)" }}>Nessuna galleria ancora.</td></tr>}
          </tbody>
        </table>
      </div>
      {cursor && <div className="row" style={{ justifyContent: "center", marginTop: "var(--s-5)" }}><button className="btn btn-secondary" onClick={more} data-press>Carica altre</button></div>}
    </Shell>
  );
}
