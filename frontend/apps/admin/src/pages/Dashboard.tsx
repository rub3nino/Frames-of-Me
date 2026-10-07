import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell } from "../ui";
import { api } from "../lib/api";

const fmt = (n: number) => (n ?? 0).toLocaleString("it-IT");

export default function Dashboard() {
  const nav = useNavigate();
  const [m, setM] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () => api.adminMetrics().then(setM).catch((e: any) => {
      if (e?.status === 401 || e?.status === 403) nav("/");
      else setErr("Non riusciamo a leggere i dati.");
    });
    load();
    const id = window.setInterval(load, 10000);
    return () => window.clearInterval(id);
  }, [nav]);

  const p = m?.photosByStatus || { uploaded: 0, processing: 0, indexed: 0, error: 0 };
  const tot = (p.uploaded + p.processing + p.indexed + p.error) || 1;
  const seg = (n: number, c: string) => (n ? <span style={{ width: (n / tot) * 100 + "%", background: c }} /> : null);

  const cards: [string, number, boolean?][] = m ? [
    ["Eventi", m.events], ["Utenti", m.users], ["Foto", m.photos], ["Gallerie", m.galleries],
    ["Job in coda", m.jobsQueued], ["Job in errore", m.jobsError, true],
  ] : [];

  return (
    <Shell title="Dashboard">
      {err && <div className="banner banner-danger" style={{ marginBottom: "var(--s-4)" }}><span>{err}</span></div>}
      {!m ? (
        <div className="statgrid">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 92 }} />)}</div>
      ) : (
        <>
          <div className="statgrid">
            {cards.map(([label, n, danger]) => (
              <div className="stat" key={label}>
                <div className="num" style={danger && n > 0 ? { color: "var(--c-danger)" } : undefined}>{fmt(n)}</div>
                <div className="cap">{label}</div>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: "var(--s-5)" }}>
            <h3 style={{ marginBottom: "var(--s-4)" }}>Foto per stato</h3>
            <div className="barstack">
              {seg(p.indexed, "var(--c-success)")}
              {seg(p.processing, "var(--c-accent)")}
              {seg(p.uploaded, "var(--c-ink-3)")}
              {seg(p.error, "var(--c-danger)")}
            </div>
            <div className="legend">
              <span className="k"><span className="dot" style={{ background: "var(--c-success)" }} /> Indicizzate <b className="mono">{fmt(p.indexed)}</b></span>
              <span className="k"><span className="dot" style={{ background: "var(--c-accent)" }} /> In elaborazione <b className="mono">{fmt(p.processing)}</b></span>
              <span className="k"><span className="dot" style={{ background: "var(--c-ink-3)" }} /> Caricate <b className="mono">{fmt(p.uploaded)}</b></span>
              <span className="k"><span className="dot" style={{ background: "var(--c-danger)" }} /> Errore <b className="mono">{fmt(p.error)}</b></span>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
