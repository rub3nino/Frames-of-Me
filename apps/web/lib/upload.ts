import { api } from "@/lib/api";
import type { UploadInitResponse } from "@/lib/types";

export type ImageType = "image/jpeg" | "image/png";

export function contentTypeOf(file: File): ImageType | null {
  if (file.type === "image/jpeg" || file.type === "image/png") return file.type;
  if (file.type === "image/jpg") return "image/jpeg";
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  return null;
}

export function safeFilename(name: string): string | null {
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!base || base === "." || base === ".." || base.length > 200) return null;
  if (/[/\\]/.test(base)) return null;
  return base;
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function putPart(url: string, blob: Blob, onLoaded: (loaded: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader("ETag")?.trim() ?? null);
        return;
      }
      reject(new Error("Caricamento della parte non riuscito."));
    };
    xhr.onerror = () => reject(new Error("Connessione interrotta."));
    xhr.send(blob);
  });
}

export async function uploadPhoto(
  file: File,
  eventId: string,
  contentType: ImageType,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const filename = safeFilename(file.name);
  if (!filename) throw new Error("Il nome file non è valido.");
  if (file.size < 1) throw new Error("Il file è vuoto.");

  onProgress(0, file.size);
  const sha256 = await sha256Hex(file);
  const created = await api<UploadInitResponse>("/v1/uploads/init", {
    method: "POST",
    body: JSON.stringify({
      eventId,
      filename,
      contentType,
      sha256,
      bytes: file.size,
    }),
  });

  if (created.mode === "single") {
    if (!created.url) throw new Error("Manca l'url di caricamento.");
    await putPart(created.url, file, (loaded) => onProgress(loaded, file.size));
    await api(`/v1/uploads/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ parts: [] }),
    });
    onProgress(file.size, file.size);
    return;
  }

  const partSize = created.partSize ?? 8_388_608;
  const partCount = Math.ceil(file.size / partSize);
  const parts: { partNumber: number; etag: string }[] = [];
  let uploaded = 0;

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const signed = await api<{ url: string; partNumber: number }>(`/v1/uploads/${created.id}/parts`, {
      method: "POST",
      body: JSON.stringify({ partNumber }),
    });
    const start = (partNumber - 1) * partSize;
    const blob = file.slice(start, Math.min(start + partSize, file.size));
    const etag = await putPart(signed.url, blob, (loaded) => {
      onProgress(Math.min(file.size, uploaded + loaded), file.size);
    });
    if (!etag) throw new Error("Manca l'etag del caricamento.");
    uploaded += blob.size;
    onProgress(Math.min(file.size, uploaded), file.size);
    parts.push({ partNumber, etag });
  }

  await api(`/v1/uploads/${created.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ parts }),
  });
  onProgress(file.size, file.size);
}
