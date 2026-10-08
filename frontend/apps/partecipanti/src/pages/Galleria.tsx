import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AppBar } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

type Item = { photoId: string; thumbUrl: string; webUrl: string; score: number; source: "match" | "attach"; createdAt?: string };
type Resp = { status: "empty" | "queued" | "ready"; total: number; items: Item[]; nextCursor: string | null; reason?: string | null };
type Variant = "original" | "web";
const SURE = 0.9, PAGE = 60, ZIP_MAX = 500;
const visitKey = (slug: string) => `rephoto.visit.${slug}`;

export default function Galleria() {
  const slug = useParams().slug || EVENT_SLUG;
  const [resp, setResp] = useState<Resp | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [showGroup2, setShowGroup2] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [variant, setVariant] = useState<Variant>("original");
  const [toast, setToast] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null); // index into `items`, or null
  const lastVisit = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const idsRef = useRef<HTMLInputElement>(null);
  const varRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => { try { lastVisit.current = Number(localStorage.getItem(visitKey(slug))) || 0; localStorage.setItem(visitKey(slug), String(Date.now())); } catch {} }, [slug]);

  // initial load + poll while queued
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const d = await api.getGallery(slug, { limit: PAGE }) as Resp;
        if (stop) return;
        setResp(d); setItems(d.items || []); setCursor(d.nextCursor);
        if (d.status === "ready") stop = true;
      } catch { /* retry */ }
    };
    load();
    const id = window.setInterval(() => { if (!stop) load(); }, 2500);
    return () => { stop = true; window.clearInterval(id); };
  }, [slug]);

  // infinite scroll
  useEffect(() => {
    if (!cursor || !sentinel.current) return;
    const io = new IntersectionObserver(async (es) => {
      if (!es[0].isIntersecting || !cursor) return;
      try {
        const d = await api.getGallery(slug, { limit: PAGE, cursor }) as Resp;
        setItems((prev) => [...prev, ...(d.items || [])]); setCursor(d.nextCursor);
      } catch {}
    }, { rootMargin: "400px" });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [cursor, slug]);

  const groups = useMemo(() => {
    const sure = items.filter((i) => i.score >= SURE);
    const maybe = items.filter((i) => i.score < SURE);
    return { sure, maybe };
  }, [items]);

  function toggle(id: string) {
    setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function startZip() {
    const ids = items.filter((i) => sel.has(i.photoId)).map((i) => i.photoId);
    if (!ids.length || ids.length > ZIP_MAX) return;
    if (idsRef.current && varRef.current && formRef.current) {
      idsRef.current.value = ids.join(","); varRef.current.value = variant;
      formRef.current.submit(); // streamed download via same-origin navigation
      setSheet(false); setToast("Download avviato");
      setTimeout(() => setToast(null), 2500);
    }
  }

  const openViewer = (id: string) => { const i = items.findIndex((x) => x.photoId === id); if (i >= 0) setViewer(i); };

  const Cell = ({ it }: { it: Item }) => {
    const isNew = it.source === "attach" && it.createdAt ? Date.parse(it.createdAt) > lastVisit.current : false;
    return (
      <div className="cell" role="button" tabIndex={0} aria-selected={sel.has(it.photoId)}
        onClick={() => toggle(it.photoId)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(it.photoId); } }}>
        <div className="photo-tile"><img className="blur-up" src={it.thumbUrl} alt="" loading="lazy"
          onLoad={(e) => e.currentTarget.classList.add("is-loaded")} ref={(el) => { if (el?.complete) el.classList.add("is-loaded"); }} /></div>
        {isNew && <span className="badge badge-accent" style={{ position: "absolute", top: 10, left: 10 }}>Nuove</span>}
        <span className="select-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg></span>
        {/* open full-screen viewer — stops propagation so the cell body still toggles selection */}
        <button type="button" className="cell-open" aria-label="Apri la foto"
          onClick={(e) => { e.stopPropagation(); openViewer(it.photoId); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
        </button>
      </div>
    );
  };

  const status = resp?.status;

  return (
    <>
      <AppBar />
      <main className="screen screen--wide" style={{ maxWidth: 820 }}>
        {!resp && <div className="gallery-grid">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "4/5" }} />)}</div>}

        {status === "queued" && (
          <>
            <div className="banner banner-info" style={{ marginBottom: "var(--s-4)" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" /></svg>
              <span>Confronto in corso… ci vuole qualche secondo.</span>
            </div>
            <div className="gallery-grid">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "4/5" }} />)}</div>
          </>
        )}

        {status === "empty" && (
          <div className="empty">
            <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" /></svg>
            <h3>Non ti abbiamo trovato in queste foto</h3>
            <p>Prova con un selfie più chiaro, o riprova più tardi: le foto vengono aggiunte man mano.</p>
            <Link className="btn btn-primary" to="/selfie" style={{ marginTop: "var(--s-5)" }} data-press>Riprova il selfie</Link>
          </div>
        )}

        {status === "ready" && (
          <>
            {groups.sure.length > 0 && (
              <section style={{ marginBottom: "var(--s-7)" }}>
                <h2 style={{ marginBottom: "var(--s-4)" }}>Le tue foto <span className="badge badge-neutral">{groups.sure.length}</span></h2>
                <div className="gallery-grid">{groups.sure.map((it) => <Cell key={it.photoId} it={it} />)}</div>
              </section>
            )}
            {groups.maybe.length > 0 && (
              <section>
                <button className="row" style={{ background: "none", border: 0, cursor: "pointer", marginBottom: "var(--s-4)" }} onClick={() => setShowGroup2((v) => !v)}>
                  <h2 style={{ margin: 0 }}>Forse sei tu <span className="badge badge-neutral">{groups.maybe.length}</span></h2>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: showGroup2 ? "rotate(180deg)" : "none", transition: "transform .2s" }}><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                {showGroup2 && <div className="gallery-grid">{groups.maybe.map((it) => <Cell key={it.photoId} it={it} />)}</div>}
              </section>
            )}
            {groups.sure.length === 0 && groups.maybe.length === 0 && (
              <div className="empty"><h3>Nessuna foto per ora</h3><p>Le foto vengono aggiunte man mano: ti avvisiamo per email.</p></div>
            )}
            <div ref={sentinel} style={{ height: 1 }} />
          </>
        )}
      </main>

      {sel.size > 0 && (
        <div className="action-bar">
          <span className="count">{sel.size} selezionate</span>
          <button className="btn btn-ghost btn-sm" style={{ color: "#fff" }} onClick={() => setSel(new Set())}>Annulla</button>
          <button className="btn btn-primary btn-sm" onClick={() => setSheet(true)} data-press>Scarica ZIP</button>
        </div>
      )}

      {/* bottom sheet: variant choice */}
      <div className={"scrim"} data-state={sheet ? "open" : "closed"} onClick={() => setSheet(false)} />
      <div className="sheet" data-state={sheet ? "open" : "closed"} role="dialog" aria-label="Scarica">
        <div className="grabber" />
        <h3 style={{ marginBottom: "var(--s-4)" }}>Scarica {sel.size} foto</h3>
        <div className="segmented" style={{ marginBottom: "var(--s-5)" }}>
          <button aria-selected={variant === "original"} onClick={() => setVariant("original")}>Originali</button>
          <button aria-selected={variant === "web"} onClick={() => setVariant("web")}>Per il web</button>
        </div>
        <button className="btn btn-primary btn-lg btn-block" onClick={startZip} data-press>Scarica ZIP</button>
      </div>

      {/* hidden form: streamed ZIP download via same-origin navigation */}
      <form ref={formRef} method="post" action={api.zipAction(slug)} style={{ display: "none" }}>
        <input ref={idsRef} type="hidden" name="ids" />
        <input ref={varRef} type="hidden" name="variant" />
      </form>

      {toast && <div className="toast">{toast}</div>}

      {viewer !== null && items[viewer] && (
        <PhotoViewer slug={slug} items={items} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
    </>
  );
}

/* Full-screen single-photo viewer. Prev/Next within the loaded items,
   Scarica (signed original URL), Close. Keyboard: Esc closes, arrows navigate. */
function PhotoViewer({ slug, items, index, onIndex, onClose }:
  { slug: string; items: Item[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const it = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") { if (index > 0) onIndex(index - 1); }
      else if (e.key === "ArrowRight") { if (index < items.length - 1) onIndex(index + 1); }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [index, items.length, onIndex, onClose]);

  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      const r: any = await api.downloadUrls(slug, [it.photoId], "original");
      const url = r?.urls?.[0]?.url;
      if (url) window.open(url, "_blank", "noopener");
    } catch { /* ignore: a failed signing just leaves the viewer open */ }
    finally { setBusy(false); }
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Foto">
      <div className="viewer-stage">
        <img className="viewer-img" src={it.webUrl} alt="" />
        <button type="button" className="viewer-close" aria-label="Chiudi" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <button type="button" className="viewer-nav viewer-prev" aria-label="Precedente" disabled={!hasPrev} onClick={() => hasPrev && onIndex(index - 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button type="button" className="viewer-nav viewer-next" aria-label="Successiva" disabled={!hasNext} onClick={() => hasNext && onIndex(index + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div className="viewer-bar">
        <span className="viewer-count">{index + 1} / {items.length}</span>
        <button className="btn btn-primary btn-sm" onClick={download} disabled={busy} data-press>{busy ? "Preparo…" : "Scarica"}</button>
      </div>
    </div>
  );
}
