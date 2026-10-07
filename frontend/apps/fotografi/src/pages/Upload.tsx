import { useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import { AppBar } from "../ui";
import { ApiError } from "../lib/net";
import {
  uploadOriginal, uploadWebStage, uploadOriginalStage, sha256Hex, contentTypeOf,
  UPLOAD_MAX_BYTES, type ImageType,
} from "../lib/upload";
import { renderWebJpeg, isWebRenderSupported, UnsupportedImageError } from "../lib/image-resize";
import {
  isFolderWatchSupported, pickFolder, ensurePermission, scanFolder, FolderPickCancelled,
} from "../lib/folder-watch";

const EVENT_SLUG = "demo";
const CONC = 4;
const WATCH_INTERVAL_MS = 10_000;
const WEB_FIRST_KEY = "rephoto.webFirst";

// "web-sent": the web derivative is up (indexed in seconds) and the original is on its way.
type Status = "queued" | "hashing" | "rendering" | "uploading" | "web-sent" | "uploaded" | "duplicate" | "error";
type Item = {
  id: string; file: File; name: string; size: number; type: ImageType;
  status: Status; pct: number; err?: string;
  photoId?: string; webDone?: boolean; // resume the original stage on retry
};

const fmt = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
let seq = 0;

export default function Upload() {
  const api = useMemo(() => createClient(), []);
  const webSupported = useMemo(() => isWebRenderSupported(), []);
  const watchSupported = useMemo(() => isFolderWatchSupported(), []);

  const [files, setFiles] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [authErr, setAuthErr] = useState(false);
  const [webFirst, setWebFirst] = useState<boolean>(() => {
    if (!webSupported) return false;
    try { const v = localStorage.getItem(WEB_FIRST_KEY); return v === null ? true : v === "1"; } catch { return true; }
  });

  const eventIdRef = useRef<string | null>(null);
  const webFirstRef = useRef(webFirst);
  const queue = useRef<Item[]>([]);
  const active = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Watched folder state
  const [folderName, setFolderName] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);
  const [folderAdded, setFolderAdded] = useState(0);
  const dirHandle = useRef<FileSystemDirectoryHandle | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const watchTimer = useRef<number | null>(null);

  useEffect(() => {
    api.getEvent(EVENT_SLUG).then((e: any) => { eventIdRef.current = e.id; setEventId(e.id); }).catch(() => {});
  }, [api]);

  useEffect(() => { webFirstRef.current = webFirst; try { localStorage.setItem(WEB_FIRST_KEY, webFirst ? "1" : "0"); } catch {} }, [webFirst]);

  // Stop the watch timer on unmount.
  useEffect(() => () => { if (watchTimer.current) window.clearInterval(watchTimer.current); }, []);

  const update = (id: string, patch: Partial<Item>) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function process(item: Item) {
    const evId = eventIdRef.current as string;
    const onP = (l: number, t: number) => update(item.id, { pct: t ? Math.round((l / t) * 100) : 0 });
    try {
      // Resume: a web-first photo whose original stage failed — skip straight to the original.
      if (item.webDone && item.photoId) {
        update(item.id, { status: "web-sent", pct: 0 });
        await uploadOriginalStage(item.file, item.photoId, evId, item.type, await sha256Hex(item.file), onP);
        update(item.id, { status: "uploaded", pct: 100 });
        return;
      }

      update(item.id, { status: "hashing" });
      const sha = await sha256Hex(item.file);

      // Two-stage "Prima il web": render a 1600 px JPEG in a worker, send it first, then the original.
      if (webFirstRef.current && webSupported) {
        let web;
        try {
          update(item.id, { status: "rendering" });
          web = await renderWebJpeg(item.file);
        } catch (e) {
          if (e instanceof UnsupportedImageError) web = null; // fall back to original-only below
          else throw e;
        }
        if (web) {
          update(item.id, { status: "uploading", pct: 0 });
          const outcome = await uploadWebStage(item.file, web.blob, evId, item.type, sha, onP);
          update(item.id, { status: "web-sent", pct: 0, photoId: outcome.photoId, webDone: true });
          await uploadOriginalStage(item.file, outcome.photoId, evId, item.type, sha, onP);
          update(item.id, { status: "uploaded", pct: 100 });
          return;
        }
      }

      // Original-only path (toggle off, or rendering unsupported for this file).
      update(item.id, { status: "uploading", pct: 0 });
      await uploadOriginal(item.file, evId, item.type, sha, onP);
      update(item.id, { status: "uploaded", pct: 100 });
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) update(item.id, { status: "duplicate" });
      else if (e instanceof ApiError && e.status === 403) { update(item.id, { status: "error", err: "Non abilitato a questo evento" }); setAuthErr(true); }
      else update(item.id, { status: "error", err: e?.message || "Errore" });
    }
  }

  function drain() {
    while (active.current < CONC && queue.current.length) {
      const item = queue.current.shift()!;
      active.current++;
      process(item).finally(() => { active.current--; drain(); });
    }
  }

  function add(list: FileList | File[]) {
    const items: Item[] = [];
    const bad: Item[] = [];
    for (const file of Array.from(list)) {
      const type = contentTypeOf(file);
      const base: Item = { id: "f" + ++seq, file, name: file.name, size: file.size, type: (type || "image/jpeg"), status: "queued", pct: 0 };
      if (!type) bad.push({ ...base, status: "error", err: "Formato non supportato" });
      else if (file.size < 1) bad.push({ ...base, status: "error", err: "File vuoto" });
      else if (file.size > UPLOAD_MAX_BYTES) bad.push({ ...base, status: "error", err: "Oltre 60 MB" });
      else items.push(base);
    }
    setFiles((fs) => [...fs, ...items, ...bad]);
    queue.current.push(...items);
    drain();
  }

  function retry(item: Item) {
    const next: Item = { ...item, status: "queued", pct: 0, err: undefined };
    update(item.id, next);
    queue.current.push(next);
    drain();
  }

  const stats = useMemo(() => ({
    coda: files.filter((f) => f.status === "queued").length,
    corso: files.filter((f) => f.status === "hashing" || f.status === "rendering" || f.status === "uploading").length,
    caricate: files.filter((f) => f.status === "uploaded").length,
    dup: files.filter((f) => f.status === "duplicate").length,
    err: files.filter((f) => f.status === "error").length,
    origPending: files.filter((f) => f.status === "web-sent").length,
  }), [files]);

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); dragDepth.current = 0; setDrag(false); if (e.dataTransfer?.files?.length) add(e.dataTransfer.files); };

  // ---- Watched folder -----------------------------------------------------
  async function scanOnce() {
    const h = dirHandle.current;
    if (!h) return;
    const ok = await ensurePermission(h); // prompts only under a user gesture; silent in the timer
    if (!ok) { setFolderMsg("Permesso alla cartella non concesso."); stopWatch(); return; }
    let found: File[];
    try { found = await scanFolder(h); }
    catch (e: any) {
      if (e instanceof DOMException && e.name === "NotAllowedError") { setFolderMsg("Permesso alla cartella revocato."); stopWatch(); }
      return;
    }
    const fresh = found.filter((f) => contentTypeOf(f) && !seen.current.has(fileKey(f)));
    found.forEach((f) => seen.current.add(fileKey(f)));
    if (fresh.length) { add(fresh); setFolderAdded((n) => n + fresh.length); }
  }

  function startTimer() {
    if (watchTimer.current) window.clearInterval(watchTimer.current);
    watchTimer.current = window.setInterval(() => { void scanOnce(); }, WATCH_INTERVAL_MS);
  }

  async function chooseFolder() {
    try {
      const h = await pickFolder();
      dirHandle.current = h;
      seen.current = new Set();
      setFolderName(h.name);
      setFolderAdded(0);
      setFolderMsg(null);
      setWatching(true);
      await scanOnce();
      startTimer();
    } catch (e) {
      if (e instanceof FolderPickCancelled) return;
      setFolderMsg(e instanceof Error ? e.message : "Impossibile aprire la cartella.");
    }
  }

  function pauseWatch() { if (watchTimer.current) window.clearInterval(watchTimer.current); watchTimer.current = null; setWatching(false); }
  function resumeWatch() { if (!dirHandle.current) return; setWatching(true); void scanOnce(); startTimer(); }
  function stopWatch() {
    if (watchTimer.current) window.clearInterval(watchTimer.current);
    watchTimer.current = null;
    dirHandle.current = null;
    seen.current = new Set();
    setWatching(false);
    setFolderName(null);
  }

  return (
    <>
      <AppBar />
      <main className="fz-page">
        <div className="fz-head">
          <div>
            <h1>Carica le foto</h1>
            <p className="muted">Conferenza 2026 · trascina le foto o scegli i file.</p>
          </div>
          <span className="agg">{stats.caricate} caricate · {stats.corso} in corso{webFirst ? ` · ${stats.origPending} originali da inviare` : ""}</span>
        </div>

        {authErr && <div className="banner banner-danger" style={{ marginBottom: "var(--s-4)" }}><span>Non sei abilitato a caricare per questo evento. Chiedi allo staff di aggiungerti.</span></div>}

        {/* Two-stage toggle. Default on where the browser can render; off/disabled otherwise. */}
        <div className="fz-toggle">
          <label className="fz-switch">
            <input type="checkbox" checked={webFirst} disabled={!webSupported} onChange={(e) => setWebFirst(e.target.checked)} />
            <span className="track" aria-hidden="true"><span className="knob" /></span>
            <span className="fz-switch-text">
              <b>Prima il web, poi gli originali</b>
              <span className="muted">{webSupported ? "La versione web (1600 px) parte subito ed è indicizzata in pochi secondi; l'originale la segue." : "Il browser non supporta il ridimensionamento: gli originali partono direttamente."}</span>
            </span>
          </label>
        </div>

        <div className={"fz-drop" + (drag ? " drag" : "")}
          onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDrag(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => { if (--dragDepth.current <= 0) setDrag(false); }}
          onDrop={onDrop}>
          <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
          <div style={{ fontWeight: 600, fontSize: "1.15rem", letterSpacing: "-0.01em" }}>Trascina qui le foto</div>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-secondary" type="button" onClick={() => inputRef.current?.click()} data-press>Scegli i file</button>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png" multiple style={{ display: "none" }}
              onChange={(e) => { if (e.target.files) add(e.target.files); e.currentTarget.value = ""; }} />
          </div>
          <div className="note">JPEG o PNG · max 60 MB · i duplicati vengono saltati{eventId ? "" : " · collego l'evento…"}</div>
        </div>

        {/* Watched folder — Chrome/Edge (File System Access) only. */}
        <section className="fz-watch">
          <div className="fz-watch-head">
            <div>
              <h3>Cartella sorvegliata</h3>
              <p className="muted">Scegli una cartella: viene riletta ogni 10 secondi e i nuovi JPEG/PNG partono da soli.</p>
            </div>
            {watchSupported && !folderName && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => void chooseFolder()} data-press>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
                Scegli cartella
              </button>
            )}
          </div>

          {!watchSupported && (
            <div className="banner banner-info">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
              <span>La cartella sorvegliata è disponibile solo su Chrome o Edge (File System Access). Su questo browser usa il trascinamento o «Scegli i file».</span>
            </div>
          )}

          {folderName && (
            <div className="fz-watch-active">
              <span className={"badge " + (watching ? "badge-success" : "badge-neutral")}>{watching ? "In ascolto" : "In pausa"}</span>
              <span className="fz-name" title={folderName}>{folderName}</span>
              <span className="fz-size">{folderAdded} file aggiunti</span>
              <span className="grow" />
              {watching
                ? <button className="btn btn-ghost btn-sm" type="button" onClick={pauseWatch} data-press>Pausa</button>
                : <button className="btn btn-ghost btn-sm" type="button" onClick={resumeWatch} data-press>Riprendi</button>}
              <button className="btn btn-ghost btn-sm" type="button" onClick={stopWatch} data-press>Ferma</button>
            </div>
          )}
          {folderMsg && <div className="banner banner-warning" style={{ marginTop: "var(--s-3)" }}><span>{folderMsg}</span></div>}
        </section>

        <div className={"fz-stats" + (webFirst ? " st-6" : " st-5")}>
          <div className="stat"><div className="num">{stats.coda}</div><div className="cap">In coda</div></div>
          <div className="stat"><div className="num">{stats.corso}</div><div className="cap">In caricamento</div></div>
          {webFirst && <div className="stat"><div className="num">{stats.origPending}</div><div className="cap">Originali da inviare</div></div>}
          <div className="stat"><div className="num">{stats.caricate}</div><div className="cap">Caricate</div></div>
          <div className="stat"><div className="num">{stats.dup}</div><div className="cap">Già presenti</div></div>
          <div className="stat"><div className="num" style={stats.err ? { color: "var(--c-danger)" } : undefined}>{stats.err}</div><div className="cap">Errori</div></div>
        </div>

        {files.length > 0 && (
          <div className="fz-list">
            <h3>{files.length} file</h3>
            {files.map((f) => (
              <div className="fz-row" key={f.id}>
                <span className="tn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 17l-5-5-6 6" /></svg></span>
                <span className="fz-name" title={f.name}>{f.name}</span>
                <span className="fz-size">{fmt(f.size)}</span>
                <span>
                  {f.status === "queued" && <span className="badge badge-neutral">In coda</span>}
                  {f.status === "hashing" && <span className="badge badge-info">Hashing…</span>}
                  {f.status === "rendering" && <span className="badge badge-info">Preparo il web…</span>}
                  {f.status === "uploading" && <span className="row" style={{ gap: 8 }}><span className="progress" style={{ width: 90 }}><span style={{ width: f.pct + "%" }} /></span><span className="fz-size">{f.pct}%</span></span>}
                  {f.status === "web-sent" && <span className="row" style={{ gap: 8 }}><span className="badge badge-info">Web inviata</span><span className="fz-size">originale {f.pct}%</span></span>}
                  {f.status === "uploaded" && <span className="badge badge-success">Caricata</span>}
                  {f.status === "duplicate" && <span className="badge badge-info">Già caricata</span>}
                  {f.status === "error" && <span className="badge badge-danger" title={f.err}>{f.err || "Errore"}</span>}
                </span>
                <span style={{ textAlign: "right" }}>
                  {f.status === "error" && f.err !== "Formato non supportato" && f.err !== "Oltre 60 MB" && f.err !== "File vuoto" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => retry(f)}>Riprova</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
