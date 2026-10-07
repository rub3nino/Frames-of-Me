/**
 * IndexedDB cache of file fingerprints so a re-drop (or a folder re-scan) neither re-hashes
 * nor re-sends files this browser already handled, plus the directory handles of watched
 * folders so a reload can resume. Every call degrades to a no-op when IndexedDB is missing,
 * blocked (private mode) or full (`QuotaExceededError`), so callers never need to guard.
 */

const DB_NAME = "rephoto";
const DB_VERSION = 2;
export const STORE_NAME = "rephoto-uploads";
export const FOLDER_STORE_NAME = "rephoto-folders";

export type FingerprintStatus = "hashed" | "web-sent" | "sent" | "deduped" | "error";

export type FingerprintRecord = {
  sha256: string;
  status: FingerprintStatus;
  photoId?: string;
  originalStatus?: "pending" | "present";
  updatedAt: number;
};

export type FolderRecord = {
  eventId: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  addedAt: number;
};

export function fingerprintOf(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

let opening: Promise<IDBDatabase | null> | null = null;
/** Set after a QuotaExceededError: reads keep working, writes become no-ops. */
let writesDisabled = false;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) db.createObjectStore(FOLDER_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
  });
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

/** Runs a readwrite transaction on `store`; resolves once committed, never rejects. */
async function write(store: string, apply: (objectStore: IDBObjectStore) => void): Promise<void> {
  if (writesDisabled) return;
  const db = await open();
  if (!db) return;
  try {
    const transaction = db.transaction(store, "readwrite");
    apply(transaction.objectStore(store));
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        if (isQuotaError(transaction.error)) writesDisabled = true;
        resolve();
      };
      transaction.onabort = () => {
        if (isQuotaError(transaction.error)) writesDisabled = true;
        resolve();
      };
    });
  } catch (error) {
    if (isQuotaError(error)) writesDisabled = true;
    /* otherwise ignore: the cache is an optimisation only */
  }
}

export async function readFingerprints(keys: string[]): Promise<Map<string, FingerprintRecord>> {
  const found = new Map<string, FingerprintRecord>();
  if (keys.length === 0) return found;
  const db = await open();
  if (!db) return found;
  try {
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const rows = await Promise.all(keys.map((key) => wrap(store.get(key) as IDBRequest<FingerprintRecord | undefined>)));
    rows.forEach((row, index) => {
      const key = keys[index];
      if (row && key && typeof row.sha256 === "string") found.set(key, row);
    });
  } catch {
    /* unavailable: behave as an empty cache */
  }
  return found;
}

export function writeFingerprint(key: string, record: Omit<FingerprintRecord, "updatedAt">): Promise<void> {
  return write(STORE_NAME, (store) => {
    store.put({ ...record, updatedAt: Date.now() } satisfies FingerprintRecord, key);
  });
}

/** True when a later write may still succeed (no quota error seen yet). */
export function fingerprintCacheWritable(): boolean {
  return !writesDisabled;
}

/* ---- watched folders (one per event) ---- */

export async function readFolder(eventId: string): Promise<FolderRecord | null> {
  const db = await open();
  if (!db) return null;
  try {
    const store = db.transaction(FOLDER_STORE_NAME, "readonly").objectStore(FOLDER_STORE_NAME);
    const row = await wrap(store.get(eventId) as IDBRequest<FolderRecord | undefined>);
    if (row && row.handle && typeof row.name === "string") return row;
  } catch {
    /* unavailable */
  }
  return null;
}

export function writeFolder(eventId: string, handle: FileSystemDirectoryHandle, name: string): Promise<void> {
  return write(FOLDER_STORE_NAME, (store) => {
    store.put({ eventId, handle, name, addedAt: Date.now() } satisfies FolderRecord, eventId);
  });
}

export function removeFolder(eventId: string): Promise<void> {
  return write(FOLDER_STORE_NAME, (store) => {
    store.delete(eventId);
  });
}
