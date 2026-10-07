/**
 * File System Access helpers for the watched folder (Chrome/Edge only). Handles survive in
 * IndexedDB; permission has to be re-granted after a browser restart, which only works from a
 * user gesture, so `ensurePermission` is called from click handlers and from the scan timer
 * (where it silently reports `false` when a prompt would be needed).
 */

/* The TypeScript DOM lib has the handle types but neither the picker nor the permission
 * methods nor async iteration (lib "dom.asynciterable" is not enabled): declare the minimum. */
type PermissionMode = { mode?: "read" | "readwrite" };
type PermissionResult = "granted" | "denied" | "prompt";

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?: (descriptor?: PermissionMode) => Promise<PermissionResult>;
    requestPermission?: (descriptor?: PermissionMode) => Promise<PermissionResult>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
}

/** Files modified more recently than this are assumed still being written and are skipped. */
export const SETTLE_MS = 3_000;
/** Safety cap so a wrong folder (e.g. the whole disk) does not freeze the tab. */
const MAX_FILES = 50_000;
const MAX_DEPTH = 12;

export function isFolderWatchSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export class FolderPickCancelled extends Error {
  constructor() {
    super("Scelta annullata.");
    this.name = "FolderPickCancelled";
  }
}

/** Opens the native picker. Rejects with FolderPickCancelled when the user dismisses it. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  if (!isFolderWatchSupported() || !window.showDirectoryPicker) {
    throw new Error("Questo browser non supporta la cartella sorvegliata.");
  }
  try {
    return await window.showDirectoryPicker({ id: "rephoto-upload", mode: "read" });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw new FolderPickCancelled();
    throw cause;
  }
}

/** queryPermission → requestPermission({ mode: "read" }). False when denied or when a prompt is impossible. */
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: "read" })) === "granted") return true;
    if (!handle.requestPermission) return false;
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    /* SecurityError without user activation, or a revoked handle */
    return false;
  }
}

/** Read-only check, never prompts. */
export async function hasPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return (await handle.queryPermission?.({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png");
}

/**
 * Recursively lists jpeg/png files. Skips dotfiles and dot-directories, and files modified
 * less than SETTLE_MS ago (still being written by the camera/tether software).
 * Rejects with a `NotAllowedError` DOMException when permission was lost.
 */
export async function scanFolder(handle: FileSystemDirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  const cutoff = Date.now() - SETTLE_MS;
  await walk(handle, 0);
  return files;

  async function walk(directory: FileSystemDirectoryHandle, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    for await (const child of directory.values()) {
      if (files.length >= MAX_FILES) return;
      if (child.name.startsWith(".")) continue;
      if (child.kind === "directory") {
        await walk(child as FileSystemDirectoryHandle, depth + 1);
        continue;
      }
      if (!isImageName(child.name)) continue;
      let file: File;
      try {
        file = await (child as FileSystemFileHandle).getFile();
      } catch (cause) {
        // Removed between listing and read, or locked: next scan will see it again.
        if (cause instanceof DOMException && cause.name === "NotAllowedError") throw cause;
        continue;
      }
      if (file.lastModified > cutoff) continue;
      files.push(file);
    }
  }
}
