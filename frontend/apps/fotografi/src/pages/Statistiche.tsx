import { useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import { AppBar } from "../ui";
import { useActiveEvent } from "../lib/event";

/** Shape of GET /v1/uploads/summary (CONTRACTS.md). */
type Summary = {
  sessions: { open: number; completed: number; aborted: number };
  photos: { uploaded: number; processing: number; indexed: number; error: number; originalsPending: number };
};

const fmt = (n: number) => n.toLocaleString("it-IT");
const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

export default function Statistiche() {
  const api = useMemo(() => createClient(), []);
  const { event, loading: evLoading, error: evError } = useActiveEvent();
  const [sum, setSum] = useState<Summary | null>(null);
  const [err, setErr] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!event) return;
    let alive = true;
    const load = () =>
      api.uploadsSummary(event.id)
        .then((s: Summary) => { if (alive) { setSum(s); setErr(false); } })
        .catch(() => { if (alive) setErr(true); });
    load();
    // Polling every 10 s, matching the uploader (CONTRACTS.md §Summary).
    timer.current = window.setInterval(load, 10_000);
    return () => { alive = false; if (timer.current) window.clearInterval(timer.current); };
  }, [api, event]);

  const photos = sum?.photos;
  const totalPhotos = photos ? photos.uploaded + photos.processing + photos.indexed + photos.error : 0;
  const barSegments = photos
    ? [
        { key: "indexed", label: "Indicizzate", n: photos.indexed, color: "var(--c-success)" },
        { key: "uploaded", label: "Caricate", n: photos.uploaded, color: "var(--c-accent)" },
        { key: "processing", label: "In elaborazione", n: photos.processing, color: "var(--c-ink-3)" },
        { key: "error", label: "Errori", n: photos.error, color: "var(--c-danger)" },
      ].filter((s) => s.n > 0)
    : [];

  return (
    <>
      <AppBar />
      <main className="fz-page">
        <div className="fz-head">
          <div>
            <h1>Le mie statistiche</h1>
            <p className="muted">Il tuo lavoro in numeri. Solo le tue foto: nessun dato personale dei partecipanti, solo conteggi.</p>
          </div>
          <span className="agg">{event ? event.name : evLoading ? "collego l'evento…" : "—"}</span>
        </div>

        {evError && (
          <div className="banner banner-danger" style={{ marginBottom: "var(--s-5)" }}>
            <span>Non riesco a collegare l'evento. Riprova più tardi.</span>
          </div>
        )}
        {err && !evError && (
          <div className="banner banner-warning" style={{ marginBottom: "var(--s-5)" }}>
            <span>Riepilogo non disponibile al momento. Riprovo da solo ogni 10 secondi.</span>
          </div>
        )}

        {/* Primary cards — wired to GET /v1/uploads/summary (own counts). */}
        <div className="fz-stats st-5">
          <div className="stat"><div className="num">{fmt(photos?.uploaded ?? 0)}</div><div className="cap">Caricate</div></div>
          <div className="stat"><div className="num" style={{ color: "var(--c-success-ink)" }}>{fmt(photos?.indexed ?? 0)}</div><div className="cap">Indicizzate</div></div>
          <div className="stat"><div className="num">{fmt(photos?.processing ?? 0)}</div><div className="cap">In elaborazione</div></div>
          <div className="stat"><div className="num" style={photos?.error ? { color: "var(--c-danger)" } : undefined}>{fmt(photos?.error ?? 0)}</div><div className="cap">Errori</div></div>
          <div className="stat"><div className="num">{fmt(photos?.originalsPending ?? 0)}</div><div className="cap">Originali dovuti</div></div>
        </div>

        {/* Distribution bar (CSS) over the photo states. */}
        <section className="st-panel">
          <div className="st-panel-head">
            <h3>Distribuzione delle mie foto</h3>
            <span className="agg">{fmt(totalPhotos)} foto totali</span>
          </div>
          {totalPhotos > 0 ? (
            <>
              <div className="st-bar" role="img" aria-label="Distribuzione degli stati delle foto">
                {barSegments.map((s) => (
                  <span key={s.key} style={{ width: pct(s.n, totalPhotos) + "%", background: s.color }} title={`${s.label}: ${fmt(s.n)}`} />
                ))}
              </div>
              <div className="st-legend">
                {barSegments.map((s) => (
                  <span key={s.key} className="st-leg-item">
                    <i style={{ background: s.color }} /> {s.label} · {fmt(s.n)} ({pct(s.n, totalPhotos)}%)
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="muted" style={{ marginTop: "var(--s-3)" }}>Ancora nessuna foto caricata per questo evento.</p>
          )}
        </section>

        {/* Sessions sub-row — own upload sessions from the same summary. */}
        <div className="fz-stats st-3" style={{ marginTop: "var(--s-5)" }}>
          <div className="stat"><div className="num">{fmt(sum?.sessions.completed ?? 0)}</div><div className="cap">Sessioni completate</div></div>
          <div className="stat"><div className="num">{fmt(sum?.sessions.open ?? 0)}</div><div className="cap">Sessioni aperte</div></div>
          <div className="stat"><div className="num" style={sum?.sessions.aborted ? { color: "var(--c-danger)" } : undefined}>{fmt(sum?.sessions.aborted ?? 0)}</div><div className="cap">Sessioni interrotte</div></div>
        </div>

        {/* GAP: per-photographer match/indexed and download counts are not in the summary. */}
        {/* Needs GET /v1/photographer/stats → { facesIndexed, photosMatched, downloads, duplicatesSkipped } (spec 03 §3.7, G3). */}
        <div className="banner banner-info" style={{ marginTop: "var(--s-6)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere. I conteggi <b>match generati</b> (foto in ≥ 1 galleria), <b>facce indicizzate</b>, <b>download delle mie foto</b> e <b>duplicati saltati</b> richiedono <code>GET /v1/photographer/stats?eventId=</code> (G3). Oggi il riepilogo espone solo i conteggi di stato.</span>
        </div>
      </main>
    </>
  );
}
