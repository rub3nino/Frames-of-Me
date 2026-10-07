import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell } from "../ui";
import { api } from "../lib/api";

const fmt = (n: number) => (n ?? 0).toLocaleString("it-IT");

export default function Eventi() {
  const nav = useNavigate();
  const [events, setEvents] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", slug: "", retentionDays: "90", access: "open" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => api.adminEvents().then((d: any) => setEvents(d.events || [])).catch((e: any) => { if (e?.status === 401 || e?.status === 403) nav("/"); });
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || !f.slug.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      await api.adminCreateEvent({ name: f.name.trim(), slug: f.slug.trim(), retentionDays: Number(f.retentionDays) || 90, access: f.access });
      setOpen(false); setF({ name: "", slug: "", retentionDays: "90", access: "open" });
      load();
    } catch (e: any) { setErr(e?.message || "Creazione non riuscita."); }
    finally { setBusy(false); }
  }

  return (
    <Shell title="Eventi">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--s-4)" }}>
        <button className="btn btn-primary" onClick={() => setOpen(true)} data-press>Nuovo evento</button>
      </div>
      <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
        <table className="table">
          <thead><tr><th>Nome</th><th>Slug</th><th>Accesso</th><th>Retention</th><th>Foto</th><th>Gallerie</th></tr></thead>
          <tbody>
            {!events && Array.from({ length: 3 }).map((_, i) => <tr key={i}><td colSpan={6}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
            {events?.map((ev) => (
              <tr key={ev.id}>
                <td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{ev.name}</td>
                <td className="mono">{ev.slug}</td>
                <td><span className={"badge " + (ev.access === "list" ? "badge-warning" : "badge-success")}>{ev.access === "list" ? "Riservato" : "Aperto"}</span></td>
                <td className="mono">{ev.retentionDays}gg</td>
                <td className="mono">{fmt(ev.photos)}</td>
                <td className="mono">{fmt(ev.galleries)}</td>
              </tr>
            ))}
            {events?.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--c-ink-3)", padding: "var(--s-7)" }}>Nessun evento.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="scrim" data-state={open ? "open" : "closed"} onClick={() => setOpen(false)} />
      <div className="modal" data-state={open ? "open" : "closed"} role="dialog" aria-label="Nuovo evento">
        <h3 style={{ marginBottom: "var(--s-5)" }}>Nuovo evento</h3>
        <form className="stack" onSubmit={create}>
          <div className="field"><label className="label">Nome</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Conferenza Europea 2026" /></div>
          <div className="field"><label className="label">Slug</label><input className="input" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} placeholder="conferenza-2026" /></div>
          <div className="row" style={{ gap: "var(--s-3)" }}>
            <div className="field" style={{ flex: 1 }}><label className="label">Giorni retention</label><input className="input" type="number" value={f.retentionDays} onChange={(e) => setF({ ...f, retentionDays: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label className="label">Accesso</label><select className="select" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })}><option value="open">Aperto</option><option value="list">Riservato (lista)</option></select></div>
          </div>
          {err && <div className="banner banner-danger"><span>{err}</span></div>}
          <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)" }}>
            <button className="btn btn-secondary" type="button" onClick={() => setOpen(false)}>Annulla</button>
            <button className="btn btn-primary" type="submit" disabled={busy} data-press>{busy ? "Creo…" : "Crea evento"}</button>
          </div>
        </form>
      </div>
    </Shell>
  );
}
