import { useEffect, useMemo, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import { AppBar } from "../ui";
import { useActiveEvent } from "../lib/event";

/** Row shape of GET /v1/uploads (CONTRACTS.md): session status is open|completed|aborted. */
type UploadRow = { id: string; objectKey: string; sha256: string; contentType: string; status: "open" | "completed" | "aborted"; createdAt: string };
type UploadsResponse = { uploads: UploadRow[]; nextCursor: string | null };
type Summary = { sessions: { open: number; completed: number; aborted: number }; photos: { uploaded: number; processing: number; indexed: number; error: number; originalsPending: number } };

const fmt = (n: number) => n.toLocaleString("it-IT");
const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};
const shortKey = (objectKey: string) => objectKey.split("/").pop() || objectKey;

export default function Qualita() {
  const api = useMemo(() => createClient(), []);
  const { event, loading: evLoading, error: evError } = useActiveEvent();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!event) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      // GET /v1/uploads exists; api.raw prefixes the client base (/v1), so the path is /uploads.
      api.raw(`/uploads?eventId=${encodeURIComponent(event.id)}&limit=200`) as Promise<UploadsResponse>,
      api.uploadsSummary(event.id) as Promise<Summary>,
    ])
      .then(([list, sum]) => {
        if (!alive) return;
        // Aborted sessions are the real "failed upload" signal exposed today
        // (corrupt bytes, size/HEAD mismatch, housekeeping). Newest first.
        setRows((list.uploads || []).filter((u) => u.status === "aborted"));
        setSummary(sum);
        setErr(false);
      })
      .catch(() => { if (alive) setErr(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, event]);

  const errorPhotos = summary?.photos.error ?? 0;
  const pending = summary?.photos.originalsPending ?? 0;
  const totalUploaded = summary ? summary.photos.uploaded + summary.photos.processing + summary.photos.indexed : 0;
  const healthy = totalUploaded + errorPhotos > 0 ? Math.round((totalUploaded / (totalUploaded + errorPhotos)) * 1000) / 10 : 100;

  return (
    <>
      <AppBar />
      <main className="fz-page">
        <div className="fz-head">
          <div>
            <h1>Qualità</h1>
            <p className="muted">La coda operativa: cosa non è andato a buon fine e come sistemarlo.</p>
          </div>
          <span className="agg">{event ? event.name : evLoading ? "collego l'evento…" : "—"}</span>
        </div>

        {evError && (
          <div className="banner banner-danger" style={{ marginBottom: "var(--s-5)" }}><span>Non riesco a collegare l'evento. Riprova più tardi.</span></div>
        )}
        {err && !evError && (
          <div className="banner banner-warning" style={{ marginBottom: "var(--s-5)" }}><span>Dati non disponibili al momento. Riprova più tardi.</span></div>
        )}

        {/* Health band — real counts from GET /v1/uploads/summary. */}
        <div className="ql-health">
          <div className="hcard ok">
            <span className="hv">{healthy.toLocaleString("it-IT")}%</span>
            <span className="hk">Caricamenti senza problemi</span>
            <div className="mini-bar" aria-hidden="true"><span style={{ width: healthy + "%" }} /></div>
          </div>
          <div className="hcard err"><span className="hv">{fmt(errorPhotos)}</span><span className="hk">Foto in errore</span></div>
          <div className="hcard warn"><span className="hv">{fmt(pending)}</span><span className="hk">Originali dovuti</span></div>
          <div className="hcard"><span className="hv">{fmt(totalUploaded)}</span><span className="hk">Caricate in totale</span></div>
        </div>

        {/* GAP: per-photo error reason + Retry action are not in GET /v1/uploads. */}
        {/* The list returns session status only; the photo-level reason (sha256 mismatch, */}
        {/* unsupported image, byte mismatch) and a server-side retry need */}
        {/* GET /v1/photographer/photos?status=error (spec 03 §3.8, G2). */}
        <div className="banner banner-info" style={{ margin: "var(--s-5) 0" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere. Il <b>motivo</b> per foto (sha256 mismatch, formato non supportato, byte non combaciano) e il pulsante <b>Riprova</b> lato server richiedono <code>GET /v1/photographer/photos?status=error</code> (G2). Qui sotto, dal contratto odierno, le <b>sessioni interrotte</b> (<code>GET /v1/uploads</code>, stato <code>aborted</code>).</span>
        </div>

        <div className="err-head">
          <h2>Sessioni interrotte</h2>
          <span className="agg">{loading ? "caricamento…" : rows.length === 0 ? "nessuna" : fmt(rows.length) + (rows.length === 1 ? " sessione" : " sessioni")}</span>
        </div>

        {rows.length > 0 ? (
          <div className="ql-list">
            {rows.map((r) => (
              <div className="ql-row" key={r.id}>
                <span className="ei" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4" /><path d="M12 17.5h.01" /></svg>
                </span>
                <div className="mid">
                  <div className="fname" title={r.objectKey}>{shortKey(r.objectKey)}</div>
                  <div className="reason">Sessione interrotta · sha {r.sha256.slice(0, 12)}… · {r.contentType}</div>
                </div>
                <span className="when">{when(r.createdAt)}</span>
                <div className="act"><span className="fatal-note">Reinvia un file valido dal Caricamento</span></div>
              </div>
            ))}
          </div>
        ) : !loading && (
          <div className="empty">
            <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.2 2.2 4.8-5" /></svg>
            <h3>Nessun problema qui</h3>
            <p>Tutte le tue sessioni di caricamento sono andate a buon fine.</p>
          </div>
        )}
      </main>
    </>
  );
}
