/**
 * Continuous upload queue: owns the per-file state (a Map, never React state), the network
 * slots, the adaptive concurrency, the optional watched folder and the IndexedDB persistence.
 * The UI only ever receives throttled snapshots (at most ~10 per second).
 *
 * Modes:
 * - "original": one task per file, today's flow (`uploadOriginal`).
 * - "web-first": two tasks per file. `web` renders a 1600 px JPEG and sends it
 *   (`uploadWebStage`) so matching starts within seconds; `original` sends the full file
 *   later (`uploadOriginalStage`). Web tasks are always scheduled before originals; originals
 *   start only when no web task is pending, and a new web task pre-empts further originals
 *   (running ones finish).
 *
 * Memory: only in-flight files are read; the rendered web blob lives for the duration of its
 * upload and is dropped right after.
 */

import { ApiError } from "@/lib/api";
import { ensurePermission, scanFolder } from "@/lib/folder-watch";
import { isWebRenderSupported, renderWebJpeg, UnsupportedImageError } from "@/lib/image-resize";
import {
  contentTypeOf,
  lookupUpload,
  safeFilename,
  sha256Hex,
  uploadOriginal,
  uploadOriginalStage,
  uploadWebStage,
  UPLOAD_MAX_BYTES,
  type ImageType,
} from "@/lib/upload";
import { fingerprintOf, readFingerprints, writeFingerprint } from "@/lib/upload-store";

/** Snapshots are flushed to the UI at most this often (about 10 renders per second). */
const FLUSH_INTERVAL_MS = 100;
/** Transfer speed is a moving average over this window. */
const SPEED_WINDOW_MS = 5_000;
/** The watched folder is listed again this often while running. */
export const SCAN_INTERVAL_MS = 10_000;
/** Adaptive concurrency: measure every 5 s, step between 1 and 6, cool down 10 s after an error. */
const ADAPT_INTERVAL_MS = 5_000;
const ADAPT_COOLDOWN_MS = 10_000;
const ADAPT_GROWTH = 1.1;
/** After a probe that did not pay off, the next step-up attempt waits this long. */
const ADAPT_HOLD_MS = 30_000;
export const CONCURRENCY_START = 2;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 6;
/** While running, stats (speed/eta) are refreshed this often even without progress events. */
const HEARTBEAT_MS = 1_000;
/** Folder files that failed are retried by a later scan once this much time has passed. */
const FOLDER_RETRY_MS = 60_000;

export type QueueMode = "original" | "web-first";
export type QueueState = "idle" | "running" | "paused";
export type QueueStage = "web" | "original";
export type QueueSource = "drop" | "folder";
export type QueueStatus =
  | "queued"
  | "hashing"
  | "rendering"
  | "uploading"
  /** The web version is up and searchable; the original is still to be sent. */
  | "web-sent"
  | "sent"
  | "deduped"
  | "skipped"
  | "error";

export type QueueEntry = {
  /** The file fingerprint `name|size|lastModified`, unique inside the queue. */
  id: string;
  name: string;
  /** Original file size. */
  size: number;
  status: QueueStatus;
  /** Which task the entry is in (or waiting for). */
  stage: QueueStage;
  /** Bytes transferred of the current stage. */
  loaded: number;
  /** Size of the rendered web JPEG once known. */
  webSize?: number;
  photoId?: string;
  error?: string;
  source: QueueSource;
};

export type QueueStats = {
  total: number;
  queued: number;
  /** Hashing or rendering (CPU work before the network). */
  rendering: number;
  uploading: number;
  /** Finished entries: sent, already present, or skipped. */
  done: number;
  sent: number;
  /** Web version up, original still to send (includes originals currently uploading). */
  originalsPending: number;
  failed: number;
  bytesTotal: number;
  bytesLoaded: number;
  /** Bytes per second over the last SPEED_WINDOW_MS, null before any sample or when idle. */
  speed: number | null;
  /** Seconds left at the current speed, null when unknown. */
  eta: number | null;
  /** Network slots currently allowed (adaptive, 1..6). */
  concurrency: number;
  /** Network slots in use. */
  inFlight: number;
  state: QueueState;
  /** True while something is in flight or waiting and the queue is running. */
  active: boolean;
};

export type FolderStatus = {
  name: string;
  /** Files seen in the last scan. */
  seen: number;
  /** Folder files finished (sent, already present or skipped). */
  uploaded: number;
  lastScanAt: number | null;
  scanning: boolean;
};

export type QueueSnapshot = {
  entries: QueueEntry[];
  stats: QueueStats;
  folder: FolderStatus | null;
};

export type QueueEvent =
  | { type: "folder-permission-lost" }
  | { type: "folder-error"; message: string }
  /** Nothing left to do (all tasks finished, no folder keeping the queue alive). */
  | { type: "drained" };

export type QueueOptions = {
  eventId: string;
  mode: QueueMode;
  onChange: (snapshot: QueueSnapshot) => void;
  onEvent?: (event: QueueEvent) => void;
};

export type Rejection = { name: string; reason: string };

type Internal = {
  entry: QueueEntry;
  file: File;
  type: ImageType;
  sha256: string | null;
  photoId: string | null;
  /** The cache knew the hash but not the outcome: ask the server before doing anything. */
  needsLookup: boolean;
  controller: AbortController | null;
  /** performance.now() of the last failure (for the folder retry backoff). */
  erroredAt: number;
};

const FINISHED: ReadonlySet<QueueStatus> = new Set(["sent", "deduped", "skipped"]);

export class UploadQueue {
  private readonly eventId: string;
  private readonly onChange: (snapshot: QueueSnapshot) => void;
  private readonly onEvent: ((event: QueueEvent) => void) | undefined;
  private mode: QueueMode;

  private readonly items = new Map<string, Internal>();
  private readonly order: string[] = [];
  private readonly pendingWeb: string[] = [];
  private readonly pendingOriginal: string[] = [];
  private running = 0;
  private state: QueueState = "idle";
  private closed = false;

  // adaptive concurrency
  private concurrency = CONCURRENCY_START;
  private baseline: number | null = null;
  private errorSinceStep = false;
  private cooldownUntil = 0;
  /** True between a tentative +1 and the measurement that confirms or reverts it. */
  private probing = false;
  private holdUntil = 0;
  private adaptTimer: number | null = null;
  private heartbeatTimer: number | null = null;

  // UI snapshots
  private dirty = new Set<string>();
  private listDirty = false;
  private flushTimer: number | null = null;
  private lastEntries: QueueEntry[] = [];
  private bytesSent = 0;
  private samples: { at: number; bytes: number }[] = [];

  // watched folder
  private folderHandle: FileSystemDirectoryHandle | null = null;
  private folder: FolderStatus | null = null;
  private scanTimer: number | null = null;
  private scanning = false;

  constructor(options: QueueOptions) {
    this.eventId = options.eventId;
    this.mode = options.mode;
    this.onChange = options.onChange;
    this.onEvent = options.onEvent;
  }

  /* ---- configuration ---- */

  getMode(): QueueMode {
    return this.mode;
  }

  /** Applies to files added from now on; files already queued keep their stage. */
  setMode(mode: QueueMode): void {
    this.mode = mode;
  }

  private webFirst(): boolean {
    return this.mode === "web-first" && isWebRenderSupported();
  }

  /** Cache records are per event: the same file sent to another event must be sent again. */
  private cacheKey(id: string): string {
    return `${this.eventId}|${id}`;
  }

  private remember(item: Internal, record: Parameters<typeof writeFingerprint>[1]): void {
    void writeFingerprint(this.cacheKey(item.entry.id), record);
  }

  /* ---- adding files ---- */

  /**
   * Validates, collapses duplicates and enqueues. Known fingerprints skip hashing; finished
   * ones skip sending; web-sent ones go straight to the original stage. Starts the queue when
   * idle. Resolves once the cache lookup is done (files are not read here).
   */
  async add(files: File[], source: QueueSource = "drop"): Promise<{ added: number; rejected: Rejection[] }> {
    const rejected: Rejection[] = [];
    const fresh: Internal[] = [];
    const seen = new Set<string>();
    let retried = false;

    for (const file of files) {
      const id = fingerprintOf(file);
      if (seen.has(id)) continue;
      seen.add(id);
      const existing = this.items.get(id);
      if (existing) {
        if (existing.entry.status === "error") {
          // A re-drop retries at once; a folder scan retries after a backoff.
          if (source === "drop" || performance.now() - existing.erroredAt >= FOLDER_RETRY_MS) {
            this.requeue(existing);
            retried = true;
          }
        }
        continue;
      }
      const type = contentTypeOf(file);
      const reason = validate(file, type);
      if (reason || !type) {
        if (source === "drop") rejected.push({ name: file.name, reason: reason ?? "Solo jpeg e png." });
        continue;
      }
      fresh.push({
        file,
        type,
        sha256: null,
        photoId: null,
        needsLookup: false,
        controller: null,
        erroredAt: 0,
        entry: { id, name: file.name, size: file.size, status: "queued", stage: "original", loaded: 0, source },
      });
    }

    let added = 0;
    if (fresh.length > 0) {
      const known = await readFingerprints(fresh.map((item) => this.cacheKey(item.entry.id)));
      if (this.closed) return { added: 0, rejected };
      const webFirst = this.webFirst();
      for (const item of fresh) {
        // A concurrent add (drop during a folder scan) may have registered the same file
        // while the cache was being read: never process one fingerprint twice.
        if (this.items.has(item.entry.id)) continue;
        added += 1;
        const record = known.get(this.cacheKey(item.entry.id));
        if (record) {
          item.sha256 = record.sha256;
          if (record.status === "sent" || record.status === "deduped") {
            item.entry.status = "skipped";
            item.entry.loaded = item.file.size;
            item.entry.photoId = record.photoId;
          } else if (record.status === "web-sent" && record.photoId) {
            item.photoId = record.photoId;
            item.entry.status = "web-sent";
            item.entry.photoId = record.photoId;
          } else {
            // "hashed", "error", or a web-sent record without photoId: the server knows better.
            item.needsLookup = true;
          }
        }
        this.items.set(item.entry.id, item);
        this.order.push(item.entry.id);
        if (item.entry.status === "web-sent") {
          item.entry.stage = "original";
          this.pendingOriginal.push(item.entry.id);
        } else if (item.entry.status === "queued") {
          if (webFirst) {
            item.entry.stage = "web";
            this.pendingWeb.push(item.entry.id);
          } else {
            this.pendingOriginal.push(item.entry.id);
          }
        }
      }
      this.listDirty = true;
    }
    if (added > 0 || retried) {
      if (this.state === "idle") this.start();
      this.schedule();
      this.pump();
    }

    return { added, rejected };
  }

  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || item.entry.status !== "error") return;
    this.requeue(item);
    if (this.state === "idle") this.start();
    this.schedule();
    this.pump();
  }

  retryAll(): void {
    let any = false;
    for (const item of this.items.values()) {
      if (item.entry.status === "error") {
        this.requeue(item);
        any = true;
      }
    }
    if (!any) return;
    if (this.state === "idle") this.start();
    this.schedule();
    this.pump();
  }

  /* ---- run control ---- */

  getState(): QueueState {
    return this.state;
  }

  /** Starts (or resumes) processing and the folder watcher. */
  start(): void {
    if (this.closed || this.state === "running") return;
    this.state = "running";
    this.baseline = null;
    this.errorSinceStep = false;
    this.probing = false;
    this.startTimers();
    this.schedule();
    this.pump();
    this.scheduleScan(true);
  }

  /** Aborts in-flight transfers (they are requeued at the front) and stops the watcher. */
  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.abortAll();
    this.stopTimers();
    this.schedule();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.start();
  }

  /** Like pause, but back to idle: nothing runs until `start()` or new files arrive. */
  stop(): void {
    if (this.state === "idle") return;
    this.state = "idle";
    this.abortAll();
    this.stopTimers();
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.state = "idle";
    this.abortAll();
    this.stopTimers();
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private abortAll(): void {
    for (const item of this.items.values()) item.controller?.abort();
  }

  private startTimers(): void {
    if (this.adaptTimer === null) this.adaptTimer = window.setInterval(() => this.adapt(), ADAPT_INTERVAL_MS);
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = window.setInterval(() => {
        this.sample();
        this.schedule();
      }, HEARTBEAT_MS);
    }
  }

  private stopTimers(): void {
    if (this.adaptTimer !== null) {
      window.clearInterval(this.adaptTimer);
      this.adaptTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /* ---- watched folder ---- */

  /** Attaches a folder; it is scanned right away when running, then every SCAN_INTERVAL_MS. */
  attachFolder(handle: FileSystemDirectoryHandle, name: string): void {
    this.folderHandle = handle;
    this.folder = { name, seen: 0, uploaded: 0, lastScanAt: null, scanning: false };
    this.schedule();
    this.scheduleScan(true);
  }

  detachFolder(): void {
    this.folderHandle = null;
    this.folder = null;
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.schedule();
  }

  hasFolder(): boolean {
    return this.folderHandle !== null;
  }

  /** Lists the folder now (when attached and running) and enqueues new files. */
  async scanNow(): Promise<void> {
    const handle = this.folderHandle;
    if (!handle || !this.folder || this.scanning || this.state !== "running" || this.closed) return;
    this.scanning = true;
    this.folder = { ...this.folder, scanning: true };
    this.schedule();
    try {
      if (!(await ensurePermission(handle))) {
        this.permissionLost();
        return;
      }
      const files = await scanFolder(handle);
      if (this.closed || this.folderHandle !== handle) return;
      this.folder = { ...this.folder, seen: files.length, lastScanAt: Date.now() };
      await this.add(files, "folder");
    } catch (cause) {
      if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
        this.permissionLost();
      } else {
        this.onEvent?.({ type: "folder-error", message: cause instanceof Error ? cause.message : "Lettura della cartella non riuscita." });
      }
    } finally {
      this.scanning = false;
      if (this.folder) this.folder = { ...this.folder, scanning: false };
      this.schedule();
      this.scheduleScan(false);
    }
  }

  private permissionLost(): void {
    this.stop();
    this.onEvent?.({ type: "folder-permission-lost" });
  }

  private scheduleScan(immediate: boolean): void {
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (!this.folderHandle || this.state !== "running" || this.closed) return;
    this.scanTimer = window.setTimeout(
      () => {
        this.scanTimer = null;
        void this.scanNow();
      },
      immediate ? 0 : SCAN_INTERVAL_MS,
    );
  }

  /* ---- scheduling ---- */

  private requeue(item: Internal, front = false): void {
    const stage: QueueStage = item.photoId ? "original" : this.stageFor(item);
    const status: QueueStatus = item.photoId ? "web-sent" : "queued";
    item.entry = { ...item.entry, status, stage, loaded: 0, error: undefined };
    const list = stage === "web" ? this.pendingWeb : this.pendingOriginal;
    if (front) list.unshift(item.entry.id);
    else list.push(item.entry.id);
    this.dirty.add(item.entry.id);
  }

  private stageFor(item: Internal): QueueStage {
    if (item.entry.stage === "web") return this.webFirst() ? "web" : "original";
    return "original";
  }

  private pump(): void {
    if (this.state !== "running" || this.closed) return;
    while (this.running < this.concurrency) {
      // Web tasks first; originals only when no web task is waiting.
      const id = this.pendingWeb.shift() ?? this.pendingOriginal.shift();
      if (id === undefined) break;
      const item = this.items.get(id);
      if (!item) continue;
      this.running += 1;
      void this.process(item).finally(() => {
        this.running -= 1;
        this.schedule();
        this.pump();
        this.maybeDrained();
      });
    }
  }

  private maybeDrained(): void {
    if (this.state !== "running" || this.running > 0 || this.pendingWeb.length > 0 || this.pendingOriginal.length > 0) return;
    if (this.folderHandle) return; // the watcher keeps the queue alive
    this.onEvent?.({ type: "drained" });
  }

  /* ---- processing one task ---- */

  private async process(item: Internal): Promise<void> {
    const controller = new AbortController();
    item.controller = controller;
    const signal = controller.signal;
    try {
      if (!item.sha256) {
        this.set(item, { status: "hashing" });
        item.sha256 = await sha256Hex(item.file);
        this.remember(item, { sha256: item.sha256, status: "hashed" });
      }
      const sha256 = item.sha256;
      if (signal.aborted) throw abortError();

      if (item.needsLookup) {
        item.needsLookup = false;
        if (await this.resolveFromServer(item, sha256)) return;
        if (signal.aborted) throw abortError();
        if (item.photoId) {
          // Web version already up: the original goes through the originals queue.
          this.pendingOriginal.push(item.entry.id);
          return;
        }
      }

      if (item.entry.stage === "web" && !item.photoId) {
        if (await this.runWebStage(item, sha256, signal)) return;
        // Unsupported image or 409 resolved to a pending original: fall through.
      }

      // Original stage (fresh photo, or the original of a web-first photo).
      await this.runOriginalStage(item, sha256, signal);
    } catch (cause) {
      this.fail(item, cause);
    } finally {
      item.controller = null;
    }
  }

  /**
   * Asks the server about a hash the cache knew without an outcome. Returns true when the
   * item is finished (already present).
   */
  private async resolveFromServer(item: Internal, sha256: string): Promise<boolean> {
    const found = await lookupUpload(this.eventId, sha256);
    if (!found) return false;
    item.photoId = found.photoId;
    if (found.originalStatus === "present") {
      this.set(item, { status: "skipped", loaded: item.file.size, photoId: found.photoId, stage: "original" });
      this.remember(item, { sha256, status: "sent", photoId: found.photoId, originalStatus: "present" });
      return true;
    }
    this.set(item, { status: "web-sent", stage: "original", loaded: 0, photoId: found.photoId });
    this.remember(item, { sha256, status: "web-sent", photoId: found.photoId, originalStatus: "pending" });
    return false;
  }

  /** Returns true when the slot should be released (web sent: the original was queued). */
  private async runWebStage(item: Internal, sha256: string, signal: AbortSignal): Promise<boolean> {
    this.set(item, { status: "rendering", stage: "web", loaded: 0 });
    let web: Blob | null;
    try {
      web = (await renderWebJpeg(item.file)).blob;
    } catch (cause) {
      if (cause instanceof UnsupportedImageError) {
        // Cannot render in the browser: send the original as a fresh photo instead.
        this.set(item, { stage: "original" });
        return false;
      }
      throw cause;
    }
    if (signal.aborted) {
      web = null;
      throw abortError();
    }
    try {
      this.set(item, { status: "uploading", loaded: 0, webSize: web.size });
      let last = 0;
      const outcome = await uploadWebStage(
        item.file,
        web,
        this.eventId,
        item.type,
        sha256,
        (loaded) => {
          const delta = loaded - last;
          last = loaded;
          if (delta !== 0) this.progress(item, loaded, delta);
        },
        signal,
      );
      item.photoId = outcome.photoId;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // Same hash already known: present → done, pending → only the original is due.
        if (await this.resolveFromServer(item, sha256)) return true;
        if (item.photoId) {
          this.pendingOriginal.push(item.entry.id);
          return true;
        }
        this.set(item, { status: "deduped", stage: "original", loaded: item.file.size });
        this.remember(item, { sha256, status: "deduped" });
        return true;
      }
      throw cause;
    } finally {
      web = null; // release the rendered blob as soon as the transfer is over
    }
    this.set(item, { status: "web-sent", stage: "original", loaded: 0, photoId: item.photoId });
    this.remember(item, { sha256, status: "web-sent", photoId: item.photoId, originalStatus: "pending" });
    this.pendingOriginal.push(item.entry.id);
    return true;
  }

  private async runOriginalStage(item: Internal, sha256: string, signal: AbortSignal): Promise<void> {
    this.set(item, { status: "uploading", stage: "original", loaded: 0 });
    let last = 0;
    const onProgress = (loaded: number) => {
      const delta = loaded - last;
      last = loaded;
      if (delta !== 0) this.progress(item, loaded, delta);
    };
    let photoId: string;
    try {
      if (item.photoId) {
        photoId = (await uploadOriginalStage(item.file, item.photoId, this.eventId, item.type, sha256, onProgress, signal)).photoId;
      } else {
        photoId = (await uploadOriginal(item.file, this.eventId, item.type, sha256, onProgress, signal)).photoId;
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404 && item.photoId) {
        // The cached photo no longer exists (deleted, or another event): forget it and
        // start this file over, as a fresh photo in the mode in force.
        item.photoId = null;
        this.remember(item, { sha256, status: "hashed" });
        if (this.webFirst()) {
          this.set(item, { status: "queued", stage: "web", loaded: 0, photoId: undefined });
          this.pendingWeb.push(item.entry.id);
          return;
        }
        this.set(item, { photoId: undefined });
        await this.runOriginalStage(item, sha256, signal);
        return;
      }
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
      if (item.photoId) {
        // The original is already there for this photo.
        photoId = item.photoId;
      } else {
        // A photo with this hash exists: maybe only as web version, then its original is due.
        const found = await lookupUpload(this.eventId, sha256);
        if (found && found.originalStatus === "pending") {
          item.photoId = found.photoId;
          this.set(item, { status: "web-sent", stage: "original", loaded: 0, photoId: found.photoId });
          this.remember(item, { sha256, status: "web-sent", photoId: found.photoId, originalStatus: "pending" });
          this.pendingOriginal.push(item.entry.id);
          return;
        }
        this.set(item, { status: "deduped", loaded: item.file.size, photoId: found?.photoId });
        this.remember(item, { sha256, status: "deduped", photoId: found?.photoId, originalStatus: "present" });
        return;
      }
    }
    this.set(item, { status: "sent", loaded: item.file.size, photoId });
    this.remember(item, { sha256, status: "sent", photoId, originalStatus: "present" });
  }

  private fail(item: Internal, cause: unknown): void {
    if (isAbort(cause)) {
      // Paused/stopped: back to the front of its queue, same stage.
      this.requeue(item, true);
      this.schedule();
      return;
    }
    if (isMissingFile(cause)) {
      // Removed or renamed between the scan and the read: nothing to send.
      this.set(item, { status: "skipped", loaded: item.file.size, error: "File non più presente." });
      return;
    }
    if (!(cause instanceof ApiError)) this.networkError();
    else if (cause.status >= 500) this.errorSinceStep = true;
    const message = cause instanceof Error ? cause.message : "Errore";
    item.erroredAt = performance.now();
    this.set(item, { status: "error", error: message, loaded: 0 });
    if (item.sha256) {
      this.remember(item, {
        sha256: item.sha256,
        status: item.photoId ? "web-sent" : "error",
        photoId: item.photoId ?? undefined,
        originalStatus: item.photoId ? "pending" : undefined,
      });
    }
  }

  /* ---- adaptive concurrency ---- */

  private networkError(): void {
    this.errorSinceStep = true;
    const now = performance.now();
    if (now < this.cooldownUntil) return;
    this.cooldownUntil = now + ADAPT_COOLDOWN_MS;
    this.probing = false;
    if (this.concurrency > CONCURRENCY_MIN) {
      this.concurrency -= 1;
      this.baseline = null;
      this.schedule();
    }
  }

  private adapt(): void {
    if (this.state !== "running") return;
    this.sample();
    const throughput = this.speed();
    const now = performance.now();
    if (throughput === null || this.running === 0) return;
    if (now < this.cooldownUntil) {
      this.baseline = throughput;
      return;
    }
    const demand = this.pendingWeb.length + this.pendingOriginal.length;
    if (this.baseline === null) {
      this.baseline = throughput;
      this.errorSinceStep = false;
      this.probing = false;
      return;
    }
    if (this.probing) {
      // Measure the step taken last tick: kept when throughput grew >= 10 %, reverted otherwise
      // (a flat link never grows on its own, so the step must be tried, not waited for).
      this.probing = false;
      if (!this.errorSinceStep && throughput >= this.baseline * ADAPT_GROWTH) {
        this.baseline = throughput;
      } else {
        if (this.concurrency > CONCURRENCY_MIN) this.concurrency -= 1;
        this.baseline = throughput;
        this.holdUntil = now + ADAPT_HOLD_MS;
        this.schedule();
      }
    } else if (!this.errorSinceStep && now >= this.holdUntil && this.concurrency < CONCURRENCY_MAX && demand > 0) {
      this.concurrency += 1;
      this.baseline = throughput;
      this.probing = true;
      this.pump();
      this.schedule();
    }
    this.errorSinceStep = false;
  }

  /* ---- progress, snapshots, stats ---- */

  private progress(item: Internal, loaded: number, delta: number): void {
    item.entry = { ...item.entry, loaded };
    this.dirty.add(item.entry.id);
    this.bytesSent += Math.max(0, delta);
    this.schedule();
  }

  private sample(): void {
    const now = performance.now();
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.at < 50) return;
    this.samples.push({ at: now, bytes: this.bytesSent });
    const cutoff = now - SPEED_WINDOW_MS;
    while (this.samples.length > 1 && (this.samples[1]?.at ?? 0) <= cutoff) this.samples.shift();
  }

  private speed(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at - first.at < 250) return null;
    return ((last.bytes - first.bytes) / (last.at - first.at)) * 1000;
  }

  private set(item: Internal, patch: Partial<QueueEntry>): void {
    item.entry = { ...item.entry, ...patch };
    this.dirty.add(item.entry.id);
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      window.requestAnimationFrame(() => this.flush());
    }, FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    if (this.closed) return;
    this.sample();
    if (this.listDirty || this.dirty.size > 0) {
      this.lastEntries = this.order.map((id) => this.items.get(id)!.entry);
      this.listDirty = false;
      this.dirty.clear();
    }
    const stats = this.stats();
    this.onChange({ entries: this.lastEntries, stats, folder: this.folder });
  }

  private stats(): QueueStats {
    let queued = 0;
    let rendering = 0;
    let uploading = 0;
    let done = 0;
    let sent = 0;
    let originalsPending = 0;
    let failed = 0;
    let bytesTotal = 0;
    let bytesLoaded = 0;
    let folderDone = 0;
    for (const entry of this.lastEntries) {
      const webSize = entry.webSize ?? 0;
      bytesTotal += entry.size + webSize;
      switch (entry.status) {
        case "queued":
          queued += 1;
          break;
        case "hashing":
        case "rendering":
          rendering += 1;
          break;
        case "uploading":
          uploading += 1;
          if (entry.stage === "original") {
            bytesLoaded += webSize + Math.min(entry.loaded, entry.size);
            if (entry.photoId) originalsPending += 1;
          } else {
            bytesLoaded += Math.min(entry.loaded, webSize);
          }
          break;
        case "web-sent":
          originalsPending += 1;
          bytesLoaded += webSize;
          break;
        case "sent":
          sent += 1;
          done += 1;
          bytesLoaded += entry.size + webSize;
          break;
        case "deduped":
        case "skipped":
          done += 1;
          bytesLoaded += entry.size + webSize;
          break;
        case "error":
          failed += 1;
          break;
      }
      if (entry.source === "folder" && FINISHED.has(entry.status)) folderDone += 1;
    }
    if (this.folder && this.folder.uploaded !== folderDone) this.folder = { ...this.folder, uploaded: folderDone };

    const pending = this.pendingWeb.length + this.pendingOriginal.length;
    const active = this.state === "running" && (this.running > 0 || pending > 0);
    const speed = active ? this.speed() : null;
    const remaining = Math.max(0, bytesTotal - bytesLoaded);
    const eta = active && speed && speed > 0 ? remaining / speed : null;
    return {
      total: this.lastEntries.length,
      queued,
      rendering,
      uploading,
      done,
      sent,
      originalsPending,
      failed,
      bytesTotal,
      bytesLoaded,
      speed,
      eta,
      concurrency: this.concurrency,
      inFlight: this.running,
      state: this.state,
      active,
    };
  }
}

function validate(file: File, type: ImageType | null): string | null {
  if (!type) return "Solo jpeg e png.";
  if (!safeFilename(file.name)) return "Nome file non valido.";
  if (file.size < 1) return "File vuoto.";
  if (file.size > UPLOAD_MAX_BYTES) return "Oltre 60 MB.";
  return null;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("Caricamento annullato.", "AbortError");
  const error = new Error("Caricamento annullato.");
  error.name = "AbortError";
  return error;
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** The File came from a folder scan and vanished before (or while) being read. */
function isMissingFile(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === "NotFoundError" || cause.name === "NotReadableError");
}
