import { useMemo, useState } from "react";
import { AppBar } from "../ui";
import { useActiveEvent } from "../lib/event";

/*
 * GAP page. Albums / organizzazione do not exist in the contract yet:
 *   tables: albums(id,event_id,name,slug,kind,starts_at,ends_at,...) + photo_albums(photo_id,album_id)
 *   endpoints: POST/GET/PATCH/DELETE /v1/photographer/albums[/:id] (G4),
 *              POST /v1/photographer/albums/:id/photos (G5),
 *              uploads/init albumId? (G6), POST /v1/photographer/albums/:id/release (G9 embargo).
 * Everything below is realistic placeholder data; see spec 03 §3.5 / §5.2.
 */

type Kind = "day" | "session" | "stage" | "zone";
type State = "published" | "review" | "scheduled";
type Album = { id: string; name: string; kind: Kind; count: number; date: string; state: State; release?: string };

const SEED: Album[] = [
  { id: "a1", name: "Giorno 1 · Palco Centrale", kind: "stage", count: 2480, date: "12 mar", state: "published" },
  { id: "a2", name: "Giorno 1 · Apertura & Keynote", kind: "session", count: 1120, date: "12 mar", state: "published" },
  { id: "a3", name: "Giorno 1 · Area Networking", kind: "zone", count: 860, date: "12 mar", state: "published" },
  { id: "a4", name: "Giorno 2 · Palco Centrale", kind: "stage", count: 3210, date: "13 mar", state: "published" },
  { id: "a5", name: "Giorno 2 · Sessioni Parallele", kind: "session", count: 1940, date: "13 mar", state: "review" },
  { id: "a6", name: "Giorno 2 · Cena di Gala", kind: "session", count: 1460, date: "13 mar", state: "review" },
  { id: "a7", name: "Giorno 3 · Palco Nord", kind: "stage", count: 2070, date: "14 mar", state: "review" },
  { id: "a8", name: "Giorno 3 · Premiazione", kind: "session", count: 980, date: "14 mar", state: "scheduled", release: "Via libera 14 mar 18:00" },
];

const FILTERS: { key: "all" | Kind; label: string }[] = [
  { key: "all", label: "Tutti" },
  { key: "day", label: "Giorno" },
  { key: "session", label: "Sessione" },
  { key: "stage", label: "Palco" },
  { key: "zone", label: "Zona" },
];

const fmt = (n: number) => n.toLocaleString("it-IT");

const StateBadge = ({ state }: { state: State }) => {
  if (state === "published") return <span className="badge badge-success">Pubblicato</span>;
  if (state === "scheduled") return <span className="badge badge-info">Programmato</span>;
  return <span className="badge badge-warning">In revisione</span>;
};

export default function Album() {
  const { event } = useActiveEvent();
  const [albums, setAlbums] = useState<Album[]>(SEED);
  const [filter, setFilter] = useState<"all" | Kind>("all");

  const shown = useMemo(() => (filter === "all" ? albums : albums.filter((a) => a.kind === filter)), [albums, filter]);
  const totalPhotos = useMemo(() => albums.reduce((s, a) => s + a.count, 0), [albums]);

  // Instant state change (workspace rule): review/scheduled → published.
  const release = (id: string) => setAlbums((as) => as.map((a) => (a.id === id ? { ...a, state: "published", release: undefined } : a)));

  return (
    <>
      <AppBar />
      <main className="fz-page">
        <div className="fz-head">
          <div>
            <h1>Album</h1>
            <p className="muted"><b>{albums.length}</b> album · <b>{fmt(totalPhotos)}</b> foto organizzate{event ? ` · ${event.name}` : ""}</p>
          </div>
          <button className="btn btn-primary" type="button" data-press aria-disabled="true" title="Richiede l'endpoint album">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Crea album
          </button>
        </div>

        {/* GAP flag. */}
        <div className="banner banner-info" style={{ marginBottom: "var(--s-5)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere. Album, assegnazione e embargo/release richiedono le tabelle <code>albums</code> / <code>photo_albums</code> (<code>photos.embargo_until</code>) e <code>GET/POST /v1/photographer/albums</code>, <code>POST /v1/photographer/albums/:id/release</code> (spec 03 §5.2, G4–G6, G9). I dati qui sotto sono di esempio.</span>
        </div>

        <div className="fz-filters" role="group" aria-label="Filtra album per tipo">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={"chip" + (filter === f.key ? " is-active" : "")} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} data-press>{f.label}</button>
          ))}
        </div>

        {shown.length > 0 ? (
          <section className="album-grid" aria-label="Album dell'evento">
            {shown.map((a) => (
              <article className="card album" key={a.id}>
                <div className={"cover kind-" + a.kind}>
                  <div className="cover-badge"><StateBadge state={a.state} /></div>
                  <svg className="cover-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 2.6 8.5 4.2-8.5 4.2L3.5 6.8 12 2.6Z" /><path d="m3.5 12 8.5 4.2 8.5-4.2" /><path d="m3.5 17.2 8.5 4.2 8.5-4.2" /></svg>
                </div>
                <div className="body">
                  <span className="nm">{a.name}</span>
                  <span className="meta">{fmt(a.count)} foto · {a.date}</span>
                  {a.release && <span className="release-line">Embargo · {a.release}</span>}
                  <div className="foot">
                    <button className="btn btn-secondary btn-sm" type="button" data-press>Apri</button>
                    {a.state !== "published" && (
                      <button className="btn btn-primary btn-sm" type="button" onClick={() => release(a.id)} data-press>{a.state === "scheduled" ? "Pubblica ora" : "Pubblica"}</button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <div className="empty">
            <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2.6 8.5 4.2-8.5 4.2L3.5 6.8 12 2.6Z" /><path d="m3.5 12 8.5 4.2 8.5-4.2" /></svg>
            <h3>Nessun album di questo tipo</h3>
            <p>Cambia filtro per vedere gli altri album.</p>
          </div>
        )}
      </main>
    </>
  );
}
