# Frames of Me v3 — continuous uploader spec

Builds on `docs/v2-spec.md` and the current code. Goal: a photographer on Chrome/Edge picks a folder once, presses "Avvia", and the page keeps uploading whatever lands in that folder, adapting to the available bandwidth, surviving browser restarts, and optionally sending a 1600 px "web" version first so matching starts within seconds while the originals trickle in. No desktop app, no browser extension, no Lightroom plugin.

Language: code/comments English, UI Italian. Keep existing conventions.

---

## 1. Two-stage upload ("prima il web, poi l'originale")

Today an upload is: `init` (original) → PUT → `complete` → `derive` (thumb+web from original) → `index` → `attach`.

New optional flow, chosen per batch by the photographer:

1. **Web stage**: the browser renders the original to a JPEG, long edge 1600, quality 0.8, EXIF-oriented (`createImageBitmap(file, { imageOrientation: "from-image" })`, OffscreenCanvas in a Web Worker). `init` with `stage: "web"` → PUT to `web/{photoId}.jpg` → `complete`. The server creates the `photos` row with `original_status = 'pending'`, the `web` derivative row, and enqueues `derive`. The worker's `derive` sees the pending original and builds only the thumb from the web derivative, then `index` → `attach` as usual. **The photo is searchable within seconds.**
2. **Original stage** (later, when the web queue is empty or the photographer is on a better network): `init` with `stage: "original"` and `photoId` → PUT/multipart to `originals/{eventId}/{photoId}` → `complete`. The server sets `original_status = 'present'` and enqueues `verify` (sha256 check, low priority). **No re-derive, no re-index** (FaceIds stay valid).

Until the original is present, "Originali" downloads/ZIP fall back to the web derivative for that photo (the UI shows it as "solo web").

### Schema — `packages/db/migrations/004_two_stage.sql`

```sql
alter table photos add column original_status text not null default 'present'
  check (original_status in ('pending', 'present'));
create index photos_event_original_pending_idx on photos (event_id) where original_status = 'pending';

alter table upload_sessions add column stage text not null default 'original'
  check (stage in ('original', 'web'));
alter table upload_sessions add column photo_id uuid null references photos (id) on delete set null;
```

`PhotoRow.originalStatus: "pending" | "present"`. `UploadSessionRow.stage`, `UploadSessionRow.photoId: string | null`.

`photos.sha256` and `photos.bytes` are **always the original's** (declared by the client at the web stage, verified when the original arrives). `photos.content_type` is the original's type.

### Jobs

New type `verify` (priority 70, dedupe `verify:{photoId}`, payload `{ photoId }`): reads the original, computes sha256, compares with `photos.sha256` and `bytes` with the object size. Mismatch → delete the original object, set `original_status = 'pending'`, `photos.error = "sha256 mismatch"` (status unchanged), log. Match → clear `photos.error` if it was that string.

`derive` when `original_status = 'pending'`: source is `web/{photoId}.jpg` (must exist, else throw), thumb only (480), `setPhotoStatus(processing)`, upsert `thumb` derivative, enqueue `index`. Do not touch the web derivative. No sha check here.

`retention`/`purgePhoto`: unchanged (deleting a missing original key is already a no-op).

### HTTP (`packages/contracts/src/http.ts`, `apps/api/src/routes.ts`)

`POST /v1/uploads/init` body (discriminated by `stage`, default `"original"`):

```ts
// stage original, fresh photo (today's behaviour)
{ eventId, filename, contentType, sha256, bytes, stage?: "original" }
// stage original for a web-first photo
{ eventId, filename, contentType, sha256, bytes, stage: "original", photoId }
// stage web
{ eventId, filename, contentType: "image/jpeg", sha256, bytes, stage: "web",
  originalContentType: "image/jpeg" | "image/png", originalBytes }
```

Rules:
- `stage: "web"`: `bytes` is the web JPEG size, max **8 MiB** (`WEB_STAGE_MAX_BYTES`), always `mode: "single"`, `objectKey = web/{photoId}.jpg`, presigned PUT with ContentLength. Dedupe on `(eventId, sha256)` as today → `409` when a photo with that sha exists (any `original_status`).
- `stage: "original"` with `photoId`: photo must exist, belong to the caller, be in the event, have `original_status = 'pending'`, and `sha256`/`bytes` must equal the stored ones (else `400`); `objectKey = photo.original_key`; single/multipart by size as today. Session gets `stage = 'original'`, `photo_id`.
- `stage: "original"` without `photoId`: today's path.

`POST /v1/uploads/:id/complete`:
- web stage: head → `bytes === session.bytes`; insert photo `{ id, eventId, photographerId, sha256, originalKey: originals/{eventId}/{photoId}, contentType: originalContentType, bytes: originalBytes, originalStatus: 'pending' }` (store `originalContentType`/`originalBytes` on the session: add columns `original_content_type text null`, `original_bytes bigint null` to `upload_sessions` in the same migration); upsert derivative `web` = session.objectKey; enqueue `derive` (deduped); response `{ photoId, status: "uploaded" }`.
- original stage with `photo_id`: head → `bytes === photo.bytes`; `setOriginalStatus(photoId, 'present')`; enqueue `verify`; response `{ photoId, status: "original_received" }`.
- duplicate-sha handling as today.

`GET /v1/uploads/lookup?eventId=&sha256=` (photographer, own photos only): `200 { photoId, originalStatus, status }` or `404`. Lets the client resume the original stage after losing its local cache.

`GET /v1/uploads/summary`: `photos` gains `originalsPending`.

Gallery/download/zip: `variantKey(photo, "original")` returns the web key when `original_status = 'pending'`; zip entry extension follows the actual object. `GET .../gallery` items gain `originalReady: boolean`.

Admin metrics: `photosByStatus` unchanged; add `originalsPending`.

`uploadCompleteResponseSchema.status`: `"uploaded" | "original_received"`.

---

## 2. Web uploader (`apps/web`)

### Modules and interfaces (two agents work concurrently — respect these signatures exactly)

`lib/image-resize.ts` (agent B):
```ts
export type WebRender = { blob: Blob; width: number; height: number };
/** 1600 px long edge, JPEG q0.8, EXIF-oriented. Runs in a Worker pool (navigator.hardwareConcurrency-1, max 4). Rejects with UnsupportedImageError for undecodable files. */
export function renderWebJpeg(file: File): Promise<WebRender>;
export function isWebRenderSupported(): boolean; // OffscreenCanvas + createImageBitmap
```
`lib/resize.worker.ts`: the worker (`new Worker(new URL("./resize.worker.ts", import.meta.url))`, Next supports this).

`lib/upload.ts` (agent B) — keep `sha256Hex`, `contentTypeOf`, `safeFilename`; refactor `uploadPhoto` into:
```ts
export type Progress = (loaded: number, total: number) => void;
export type UploadOutcome = { photoId: string };
export function uploadOriginal(file: File, eventId: string, type: ImageType, sha256: string, onProgress: Progress, signal?: AbortSignal): Promise<UploadOutcome>;           // today's flow
export function uploadWebStage(file: File, web: Blob, eventId: string, type: ImageType, sha256: string, onProgress: Progress, signal?: AbortSignal): Promise<UploadOutcome>;
export function uploadOriginalStage(file: File, photoId: string, eventId: string, type: ImageType, sha256: string, onProgress: Progress, signal?: AbortSignal): Promise<UploadOutcome>;
export function lookupUpload(eventId: string, sha256: string): Promise<{ photoId: string; originalStatus: "pending" | "present" } | null>;
```
All three honour `AbortSignal` (abort the in-flight XHR) and throw `ApiError` on HTTP errors (409 = already present).

`lib/upload-store.ts` (agent A): extend the record to `{ sha256, status, photoId?, originalStatus?: "pending" | "present", updatedAt }` and add a second store `rephoto-folders` holding `{ eventId, handle: FileSystemDirectoryHandle, name, addedAt }` (handles are structured-cloneable into IndexedDB).

`lib/folder-watch.ts` (agent A):
```ts
export function isFolderWatchSupported(): boolean; // "showDirectoryPicker" in window
export function pickFolder(): Promise<FileSystemDirectoryHandle>;
export function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean>; // queryPermission → requestPermission({ mode: "read" })
/** Recursively lists jpeg/png files (skips dotfiles, files modified < 3 s ago = still being written). */
export function scanFolder(handle: FileSystemDirectoryHandle): Promise<File[]>;
```

`lib/upload-queue.ts` (agent A) — evolve the existing `UploadQueue`:
- Modes: `"original"` (today) and `"web-first"`. In web-first, each file has two tasks: `web` (render + uploadWebStage) and `original` (uploadOriginalStage). Scheduling: web tasks always before original tasks; originals start only when no web task is pending; a new web task pre-empts further originals (running ones finish).
- **Adaptive concurrency**: start at 2, measure throughput every 5 s; if no errors and throughput grew ≥10 % since the last step, +1 (max 6); on any timeout/network error, −1 (min 1) and 10 s cool-down; XHR timeout 120 s per part.
- `pause()` / `resume()` / `stop()`; pausing aborts in-flight XHRs and requeues them.
- Persistence: every file status change is written to IndexedDB; on page load, pending `original` stages for known fingerprints are re-queued when the folder is re-attached (file bytes are re-read from the handle; for drag-and-drop files, only after a re-drop).
- Stats: queued/rendering/uploading/sent/originalsPending/errors, bytes, MB/s (5 s window), ETA, concurrency.
- Folder watcher: when a folder is attached and running, `scanFolder` every 10 s; new fingerprints enter the queue; removed files are ignored.
- Keep the 10 renders/s throttle.

`app/upload/page.tsx` (agent A):
- Section "Cartella sorvegliata" (shown only when supported, otherwise a note "Usa Chrome o Edge per caricare una cartella in automatico"): "Scegli cartella" → name shown, "Avvia"/"Pausa"/"Ferma", status line ("Controllo la cartella ogni 10 s · 1.234 file visti · 1.100 caricate"), "Rimuovi cartella". On load, if a folder is stored for this event: "Riprendi `<nome>`" (one click, triggers the permission prompt).
- Mode toggle "Prima il web, poi gli originali" (default ON when supported; stored in localStorage), with a one-line explanation.
- Wake Lock (`navigator.wakeLock.request("screen")`) while running; re-acquire on `visibilitychange`.
- `beforeunload` warning while uploads are running.
- PWA: `app/manifest.ts` (name Frames of Me Upload, display standalone, start_url `/upload`, icons from `app/icon.svg` → add 192/512 PNG under `public/`), minimal service worker `public/sw.js` registered from the upload page only (cache nothing except the manifest/icons; it exists only for installability), "Installa come app" hint when `beforeinstallprompt` fires.
- Drag-and-drop stays for Safari/Firefox and goes through the same queue/mode.
- Keep the windowed list, summary polling (now shows `originalsPending`), history.

`components/gallery.tsx` / `viewer.tsx` (agent B, small): items with `originalReady === false` show a "solo web" tag; the "Originali" ZIP/download option explains it will use the web version for those.

CSS: both agents add their classes in `globals.css` at the END of the file under a comment header naming the module, to avoid conflicts.

---

## 3. Ownership

| Agent | Paths |
| --- | --- |
| backend | `packages/contracts/**`, `packages/db/**`, `apps/api/**`, `apps/worker/**` (incl. tests) |
| web A (folder/queue/PWA) | `apps/web/lib/upload-queue.ts`, `apps/web/lib/upload-store.ts`, `apps/web/lib/folder-watch.ts`, `apps/web/app/upload/**`, `apps/web/app/manifest.ts`, `apps/web/public/**`, `apps/web/app/layout.tsx` (manifest link only), `apps/web/lib/types.ts` (upload-related types) |
| web B (resize/stages/gallery tag) | `apps/web/lib/image-resize.ts`, `apps/web/lib/resize.worker.ts`, `apps/web/lib/upload.ts`, `apps/web/components/gallery.tsx`, `apps/web/components/viewer.tsx`, `apps/web/lib/types.ts` (gallery-related types only; coordinate: add fields, never remove) |

Both web agents edit `apps/web/app/globals.css` only by appending. `apps/web/next.config.ts`: agent A only (if the worker needs config).
