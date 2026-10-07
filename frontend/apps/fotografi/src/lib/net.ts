// Low-level fetch wrapper used by the ported upload.ts (full /v1 paths, same-origin
// behind the Vite dev proxy). Session cookie is sent with every call.

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super((body as any)?.error || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type UploadMode = "single" | "multipart";
export type UploadInitResponse = { id: string; objectKey: string; mode: UploadMode; url?: string; partSize?: number };
export type UploadCompleteResponse = { photoId: string; status: "uploaded" | "original_received" };
export type UploadLookupResponse = { photoId: string; originalStatus: "pending" | "present"; status: "uploaded" | "processing" | "indexed" | "error" };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { credentials: "include", ...init, headers });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
