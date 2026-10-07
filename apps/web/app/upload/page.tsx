"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Gate } from "@/components/require-role";
import { Progress } from "@/components/progress";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { eventSlug } from "@/lib/event";
import { ensurePermission, FolderPickCancelled, isFolderWatchSupported, pickFolder } from "@/lib/folder-watch";
import { isWebRenderSupported } from "@/lib/image-resize";
import {
  UploadQueue,
  type QueueEntry,
  type QueueMode,
  type QueueSnapshot,
  type QueueStatus,
} from "@/lib/upload-queue";
import { readFolder, removeFolder, writeFolder, type FolderRecord } from "@/lib/upload-store";
import type { EventInfo, UploadListItem, UploadListResponse, UploadSummary } from "@/lib/types";

const SUMMARY_POLL_MS = 10_000;
const HISTORY_PAGE = 50;
const ROW_HEIGHT = 44;
const LIST_MAX_HEIGHT = 440;
const OVERSCAN = 8;
const MODE_KEY = "rephoto.upload.mode";

const sessionLabel: Record<UploadListItem["status"], string> = {
  open: "In corso",
  completed: "Completato",
  aborted: "Interrotto",
};

const localLabel: Record<QueueStatus, string> = {
  queued: "In attesa",
  hashing: "Verifica",
  rendering: "Preparo il web",
  uploading: "Caricamento",
  "web-sent": "Web inviata",
  sent: "Caricata",
  deduped: "Già presente",
  skipped: "Già caricata",
  error: "Errore",
};

const EMPTY: QueueSnapshot = {
  entries: [],
  stats: {
    total: 0,
    queued: 0,
    rendering: 0,
    uploading: 0,
    done: 0,
    sent: 0,
    originalsPending: 0,
    failed: 0,
    bytesTotal: 0,
    bytesLoaded: 0,
    speed: null,
    eta: null,
    concurrency: 2,
    inFlight: 0,
    state: "idle",
    active: false,
  },
  folder: null,
};

/** Chrome's install prompt event (not in the DOM lib). */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function UploadPage() {
  return (
    <Shell signOut>
      <Uploader />
    </Shell>
  );
}

function Uploader() {
  const [eventId, setEventId] = useState<string | null>(null);
  const [gate, setGate] = useState<"anon" | "wrong" | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(EMPTY);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const queueRef = useRef<UploadQueue | null>(null);

  // v3: mode, watched folder, install prompt. Browser-only values are read in effects
  // so the server render and the first client render agree.
  const [mode, setMode] = useState<QueueMode>("original");
  const [webSupported, setWebSupported] = useState(false);
  const [folderSupported, setFolderSupported] = useState(false);
  const [folder, setFolder] = useState<{ handle: FileSystemDirectoryHandle; name: string } | null>(null);
  const [storedFolder, setStoredFolder] = useState<FolderRecord | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [permissionLost, setPermissionLost] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const web = isWebRenderSupported();
    setWebSupported(web);
    setFolderSupported(isFolderWatchSupported());
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(MODE_KEY);
    } catch {
      /* storage blocked */
    }
    setMode(stored === "original" || stored === "web-first" ? stored : web ? "web-first" : "original");
  }, []);

  useEffect(() => {
    let stop = false;
    api<EventInfo>(`/v1/events/${eventSlug}`)
      .then((event) => {
        if (!stop) setEventId(event.id);
      })
      .catch((cause: unknown) => {
        if (stop) return;
        if (cause instanceof ApiError && cause.status === 401) setGate("anon");
        else setBootError(cause instanceof ApiError ? cause.message : "Evento non trovato.");
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!eventId) return;
    const queue = new UploadQueue({
      eventId,
      mode,
      onChange: setSnapshot,
      onEvent: (event) => {
        if (event.type === "folder-permission-lost") {
          setPermissionLost(true);
          setFolderNotice("Il browser ha tolto l'accesso alla cartella. Premi Riprendi per autorizzarla di nuovo.");
        } else if (event.type === "folder-error") {
          setFolderNotice(event.message);
        }
      },
    });
    queueRef.current = queue;
    return () => {
      queue.close();
      queueRef.current = null;
      setSnapshot(EMPTY);
    };
    // The mode is pushed with setMode below; recreating the queue would drop the files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    queueRef.current?.setMode(mode);
  }, [mode]);

  // A folder saved for this event in a previous visit: offer "Riprendi".
  useEffect(() => {
    if (!eventId || !folderSupported) return;
    let stop = false;
    void readFolder(eventId).then((record) => {
      if (!stop && record) setStoredFolder(record);
    });
    return () => {
      stop = true;
    };
  }, [eventId, folderSupported]);

  useEffect(() => {
    if (!eventId) return;
    let stop = false;
    async function load() {
      try {
        const data = await api<UploadSummary>(`/v1/uploads/summary?eventId=${eventId}`);
        if (stop) return;
        setSummary(data);
        setSummaryError(null);
        setGate(null);
      } catch (cause) {
        if (stop) return;
        if (cause instanceof ApiError && cause.status === 401) setGate("anon");
        else if (cause instanceof ApiError && cause.status === 403) setGate("wrong");
        else setSummaryError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere lo stato.");
      }
    }
    void load();
    const id = window.setInterval(() => void load(), SUMMARY_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [eventId]);

  // Installability: the service worker is registered from this page only.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/upload" }).catch(() => {
        /* not installable here (http, private mode): the uploader still works */
      });
    }
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const { entries, stats } = snapshot;
  const running = stats.state === "running";
  const busy = stats.active || (running && folder !== null);

  useWakeLock(busy);

  useEffect(() => {
    if (!stats.active) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [stats.active]);

  function chooseMode(next: QueueMode) {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  }

  async function start(list: File[]) {
    const queue = queueRef.current;
    if (!queue || list.length === 0) return;
    const { rejected } = await queue.add(list, "drop");
    if (rejected.length === 0) {
      setNotice(null);
      return;
    }
    const reasons = [...new Set(rejected.map((item) => item.reason))].join(" ");
    setNotice(
      rejected.length === 1
        ? `${rejected[0]?.name}: ${reasons}`
        : `${rejected.length} file scartati. ${reasons}`,
    );
  }

  function attach(handle: FileSystemDirectoryHandle, name: string, run: boolean) {
    const queue = queueRef.current;
    if (!queue || !eventId) return;
    queue.attachFolder(handle, name);
    void writeFolder(eventId, handle, name);
    setFolder({ handle, name });
    setStoredFolder(null);
    setFolderNotice(null);
    setPermissionLost(false);
    if (run) queue.start();
  }

  async function chooseFolder() {
    try {
      const handle = await pickFolder();
      if (!(await ensurePermission(handle))) {
        setFolderNotice("Senza il permesso di lettura non possiamo controllare la cartella.");
        return;
      }
      attach(handle, handle.name, false);
    } catch (cause) {
      if (cause instanceof FolderPickCancelled) return;
      setFolderNotice(cause instanceof Error ? cause.message : "Non riusciamo ad aprire la cartella.");
    }
  }

  /** "Riprendi": one click re-prompts for permission on a stored (or revoked) handle, then runs. */
  async function resumeFolder(handle: FileSystemDirectoryHandle, name: string) {
    if (!(await ensurePermission(handle))) {
      setFolderNotice("Permesso negato. Scegli di nuovo la cartella per continuare.");
      return;
    }
    attach(handle, name, true);
  }

  function forgetFolder() {
    const queue = queueRef.current;
    queue?.detachFolder();
    if (eventId) void removeFolder(eventId);
    setFolder(null);
    setStoredFolder(null);
    setFolderNotice(null);
    setPermissionLost(false);
  }

  const retry = useCallback((id: string) => queueRef.current?.retry(id), []);

  if (gate) return <Gate kind={gate} />;
  if (bootError) {
    return (
      <div className="stack">
        <h1>Carica le foto</h1>
        <p className="alert" role="alert">
          {bootError}
        </p>
      </div>
    );
  }

  const ratio = stats.bytesTotal === 0 ? 0 : stats.bytesLoaded / stats.bytesTotal;
  const queue = queueRef.current;
  const folderStatus = snapshot.folder;
  // Avvia: idle, with files still to send (queued, hashing, rendering, uploading or awaiting
  // their original) or a folder to watch.
  const pendingWork = stats.total - stats.done - stats.failed > 0;
  const canStart = Boolean(eventId) && stats.state === "idle" && (pendingWork || folder !== null);

  return (
    <div className="stack">
      <div>
        <h1>Carica le foto</h1>
        <p className="lede">Evento {eventSlug}. Jpeg o png, fino a 60 MB.</p>
      </div>

      {folderSupported ? (
        <section className="folder" aria-labelledby="folder-title">
          <h2 id="folder-title">Cartella sorvegliata</h2>
          {folder ? (
            <>
              <p className="folder-name">
                <span className="name">{folder.name}</span>
                <button className="linkish" type="button" onClick={forgetFolder}>
                  Rimuovi cartella
                </button>
              </p>
              <p className="folder-status" aria-live="polite">
                {permissionLost
                  ? "Accesso alla cartella da autorizzare."
                  : running
                    ? `Controllo la cartella ogni 10 s · ${formatCount(folderStatus?.seen ?? 0)} file visti · ${formatCount(folderStatus?.uploaded ?? 0)} caricate`
                    : stats.state === "paused"
                      ? `In pausa · ${formatCount(folderStatus?.uploaded ?? 0)} caricate`
                      : "Premi Avvia: le foto che arrivano nella cartella vengono caricate da sole."}
              </p>
            </>
          ) : storedFolder ? (
            <>
              <p className="note">Nell'ultima sessione caricavi da «{storedFolder.name}».</p>
              <div className="folder-controls">
                <button
                  className="button primary"
                  type="button"
                  disabled={!eventId}
                  onClick={() => void resumeFolder(storedFolder.handle, storedFolder.name)}
                >
                  Riprendi {storedFolder.name}
                </button>
                <button className="button quiet" type="button" onClick={forgetFolder}>
                  Rimuovi cartella
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="note">
                Scegli la cartella in cui salvi gli scatti: ogni nuova foto parte da sola, anche per giorni.
              </p>
              <div className="folder-controls">
                <button className="button primary" type="button" disabled={!eventId} onClick={() => void chooseFolder()}>
                  Scegli cartella
                </button>
              </div>
            </>
          )}
          {folderNotice ? (
            <p className="alert" role="alert">
              {folderNotice}
            </p>
          ) : null}
        </section>
      ) : (
        <p className="note">Usa Chrome o Edge per caricare una cartella in automatico.</p>
      )}

      {stats.total > 0 || folder ? (
        <div className="folder-controls run-controls" role="group" aria-label="Coda di caricamento">
          {folder && permissionLost ? (
            <button className="button primary" type="button" onClick={() => void resumeFolder(folder.handle, folder.name)}>
              Riprendi
            </button>
          ) : stats.state === "running" ? (
            <button className="button quiet" type="button" onClick={() => queue?.pause()}>
              Pausa
            </button>
          ) : stats.state === "paused" ? (
            <button className="button primary" type="button" onClick={() => queue?.resume()}>
              Riprendi
            </button>
          ) : (
            <button className="button primary" type="button" disabled={!canStart} onClick={() => queue?.start()}>
              Avvia
            </button>
          )}
          <button className="button quiet" type="button" disabled={stats.state === "idle"} onClick={() => queue?.stop()}>
            Ferma
          </button>
        </div>
      ) : null}

      <label className="mode-toggle">
        <input
          type="checkbox"
          checked={mode === "web-first" && webSupported}
          disabled={!webSupported}
          onChange={(event) => chooseMode(event.target.checked ? "web-first" : "original")}
        />
        <span>
          <strong>Prima il web, poi gli originali</strong>
          <small>
            {webSupported
              ? "Una versione da 1600 px parte subito e i partecipanti si trovano in pochi secondi; gli originali seguono quando la coda è libera."
              : "Non disponibile in questo browser: gli originali partono subito."}
          </small>
        </span>
      </label>

      <label
        className="drop"
        data-over={over ? "true" : "false"}
        onDragEnter={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void start([...event.dataTransfer.files]);
        }}
      >
        <input
          className="sr"
          type="file"
          accept="image/jpeg,image/png"
          multiple
          disabled={!eventId}
          onChange={(event) => {
            void start([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <span>Trascina le foto qui, oppure tocca per sceglierle.</span>
      </label>
      <p className="note">
        Se si interrompe, invia di nuovo gli stessi file. Quelli già registrati non vengono duplicati.
      </p>
      {notice ? (
        <p className="alert" role="alert">
          {notice}
        </p>
      ) : null}
      {installPrompt ? (
        <p className="install">
          <span>Per lasciarla aperta a lungo, installa questa pagina come app.</span>
          <button
            className="linkish"
            type="button"
            onClick={() => {
              const prompt = installPrompt;
              setInstallPrompt(null);
              void prompt.prompt();
            }}
          >
            Installa come app
          </button>
        </p>
      ) : null}

      {entries.length > 0 ? (
        <section className="upload-batch" aria-live="polite">
          <div className="progress-row">
            <Progress value={ratio} label="Avanzamento del caricamento" />
            <span className="meta">{Math.round(ratio * 100)}%</span>
          </div>
          <div className="upload-stats">
            <span>
              {stats.done} / {stats.total} caricate
            </span>
            {stats.originalsPending > 0 ? (
              <span className="meta">{formatCount(stats.originalsPending)} originali da inviare</span>
            ) : null}
            {stats.rendering > 0 ? <span className="meta">{stats.rendering} in preparazione</span> : null}
            <span className="meta">{formatSpeed(stats.speed)}</span>
            <span className="meta">{formatEta(stats.eta)}</span>
            {stats.active ? (
              <span className="meta">
                {stats.inFlight}/{stats.concurrency} connessioni
              </span>
            ) : stats.state === "paused" ? (
              <span className="meta">In pausa</span>
            ) : null}
          </div>
          {stats.failed > 0 && !stats.active ? (
            <div className="upload-retry">
              <span className="alert" role="alert">
                {stats.failed === 1 ? "1 foto non caricata." : `${stats.failed} foto non caricate.`}
              </span>
              <button className="button quiet" type="button" onClick={() => queueRef.current?.retryAll()}>
                Riprova tutti
              </button>
            </div>
          ) : null}
          <WindowedList entries={entries} onRetry={retry} />
        </section>
      ) : null}

      <section className="block">
        <h2>Stato</h2>
        {summaryError ? (
          <p className="alert" role="alert">
            {summaryError}
          </p>
        ) : summary ? (
          <dl className="metrics summary">
            <div>
              <dt>Sessioni in corso</dt>
              <dd>{summary.sessions.open}</dd>
            </div>
            <div>
              <dt>Completate</dt>
              <dd>{summary.sessions.completed}</dd>
            </div>
            <div>
              <dt>Interrotte</dt>
              <dd>{summary.sessions.aborted}</dd>
            </div>
            <div>
              <dt>Foto ricevute</dt>
              <dd>{summary.photos.uploaded}</dd>
            </div>
            <div>
              <dt>In elaborazione</dt>
              <dd>{summary.photos.processing}</dd>
            </div>
            <div>
              <dt>Indicizzate</dt>
              <dd>{summary.photos.indexed}</dd>
            </div>
            <div>
              <dt>Originali in arrivo</dt>
              <dd>{summary.photos.originalsPending ?? 0}</dd>
            </div>
            <div>
              <dt>Con errori</dt>
              <dd>{summary.photos.error}</dd>
            </div>
          </dl>
        ) : (
          <p className="status">Caricamento</p>
        )}
        {eventId ? <History eventId={eventId} /> : null}
      </section>
    </div>
  );
}

/** Keeps the screen on while `active`; the lock is lost when the tab is hidden and re-taken on return. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        /* low battery or not allowed: uploads continue anyway */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

function WindowedList({ entries, onRetry }: { entries: QueueEntry[]; onRetry: (id: string) => void }) {
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef<number | null>(null);

  const height = Math.min(LIST_MAX_HEIGHT, entries.length * ROW_HEIGHT);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(entries.length, first + visible);
  const slice = entries.slice(first, last);

  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const top = event.currentTarget.scrollTop;
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      setScrollTop(top);
    });
  }

  useEffect(() => {
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <div className="window" style={{ height }} onScroll={onScroll}>
      <ul className="list windowed" style={{ height: entries.length * ROW_HEIGHT }}>
        {slice.map((item, offset) => (
          <li
            key={item.id}
            style={{ transform: `translateY(${(first + offset) * ROW_HEIGHT}px)` }}
            data-status={item.status}
          >
            <span className="name">{item.name}</span>
            <span className="meta">{rowLabel(item)}</span>
            {item.status === "error" ? (
              <button type="button" className="linkish row-action" onClick={() => onRetry(item.id)} title={item.error}>
                Riprova
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function rowLabel(item: QueueEntry): string {
  if (item.status !== "uploading") return localLabel[item.status];
  const total = item.stage === "web" ? (item.webSize ?? 0) : item.size;
  const percent = total === 0 ? 0 : Math.round((item.loaded / total) * 100);
  return item.stage === "web" ? `web ${percent}%` : item.photoId ? `originale ${percent}%` : `${percent}%`;
}

function History({ eventId }: { eventId: string }) {
  const [shown, setShown] = useState(false);
  const [items, setItems] = useState<UploadListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  async function loadMore(reset = false) {
    setPending(true);
    setError(null);
    try {
      const query = new URLSearchParams({ eventId, limit: String(HISTORY_PAGE) });
      if (!reset && cursor) query.set("cursor", cursor);
      const data = await api<UploadListResponse>(`/v1/uploads?${query.toString()}`);
      setItems((current) => (reset ? data.uploads : [...current, ...data.uploads]));
      setCursor(data.nextCursor);
      setLoadedOnce(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere lo storico.");
    } finally {
      setPending(false);
    }
  }

  if (!shown) {
    return (
      <button
        className="linkish"
        type="button"
        onClick={() => {
          setShown(true);
          void loadMore(true);
        }}
      >
        Mostra storico
      </button>
    );
  }

  return (
    <div className="history">
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {loadedOnce && items.length === 0 ? <p className="note">Nessuna foto caricata.</p> : null}
      {items.length > 0 ? (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="name">{item.objectKey.split("/").pop()}</span>
              <span className="meta">{sessionLabel[item.status]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="actions inline">
        {cursor ? (
          <button className="button quiet" type="button" onClick={() => void loadMore()} disabled={pending}>
            {pending ? "Carico…" : "Mostra altri"}
          </button>
        ) : null}
        <button className="linkish" type="button" onClick={() => setShown(false)}>
          Nascondi storico
        </button>
      </div>
    </div>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString("it-IT");
}

function formatSpeed(speed: number | null): string {
  if (speed === null) return "";
  const mb = speed / 1_000_000;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes} min ${whole % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
