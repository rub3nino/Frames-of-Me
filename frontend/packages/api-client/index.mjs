/* ============================================================================
   Frames of Me — shared API client
   Framework-agnostic (plain fetch). Used by every frontend app (landing,
   partecipanti, fotografi, admin) so there is ONE place that knows the backend.
   Talks to the existing `apps/api` (Hono). Endpoints mirror CONTRACTS.md.

   Base URL resolution (in order):
     1. the `base` passed to createClient()
     2. globalThis.REPHOTO_API_BASE  (e.g. set per-app at runtime)
     3. "/v1"  — same-origin: each app is served behind a reverse proxy that
                 routes /v1/* to the API (this is the production model, and the
                 Next dev proxy in local dev). See DEPLOY.md.

   Session is a cookie (`rephoto_session`, httpOnly) set by the API on verify,
   so every call uses credentials: "include".
   ============================================================================ */

function resolveBase(base) {
  if (base) return base.replace(/\/$/, "");
  if (typeof globalThis !== "undefined" && globalThis.REPHOTO_API_BASE)
    return String(globalThis.REPHOTO_API_BASE).replace(/\/$/, "");
  return "/v1";
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function createClient(opts = {}) {
  const base = resolveBase(opts.base);

  async function req(path, { method = "GET", json, form, headers } = {}) {
    const init = { method, credentials: "include", headers: { ...(headers || {}) } };
    if (json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.body = form; // FormData — browser sets the multipart boundary
    }
    const res = await fetch(base + path, init);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json().catch(() => null)
               : await res.text().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  return {
    base,

    /* ---- Auth (passwordless magic link) -------------------------------- */
    // role: "participant" | "photographer" | "admin"
    requestLink: (email, role = "participant") =>
      req("/auth/request-link", { method: "POST", json: { email, role } }),
    verify: (token) => req("/auth/verify", { method: "POST", json: { token } }),
    logout: () => req("/auth/logout", { method: "POST" }),

    /* ---- Login with credentials ---------------------------------------- */
    // role: "participant" | "photographer" | "admin". Since v6 participants
    // have passwords too: they self-register behind an event code.
    login: (email, password, role) =>
      req("/auth/login", { method: "POST", json: { email, password, role } }),

    /* ---- Participant self-registration (v6) ----------------------------
       The event code is the one printed on the badge or the QR. It is the
       anti-bot gate, and it is why registering sends no e-mail at all:
       the address is verified lazily, only if a password reset is asked. */
    register: (email, password, eventCode) =>
      req("/auth/register", { method: "POST", json: { email, password, eventCode } }),

    /* ---- Google (v6) ---------------------------------------------------
       A full-page navigation, not a fetch: the endpoint answers 302 and the
       state + PKCE cookie has to be set on a real document request. */
    googleStartUrl: () => `${base}/auth/google/start`,

    /* ---- Event + participant flow -------------------------------------- */
    getEvent: (slug) => req(`/events/${slug}`),
    giveConsent: (slug, textVersion, accepted = true) =>
      req(`/events/${slug}/consent`, { method: "POST", json: { textVersion, accepted } }),
    sendSelfie: (slug, fileOrBlob, liveness = "file", filename) => {
      const fd = new FormData();
      fd.append("selfie", fileOrBlob, filename || (fileOrBlob.type === "image/png" ? "selfie.png" : "selfie.jpg"));
      fd.append("liveness", liveness); // "challenge" | "file"
      return req(`/events/${slug}/selfie`, { method: "POST", form: fd });
    },
    getGallery: (slug, { cursor, limit } = {}) => {
      const q = new URLSearchParams();
      if (cursor) q.set("cursor", cursor);
      if (limit) q.set("limit", String(limit));
      const qs = q.toString();
      return req(`/events/${slug}/gallery${qs ? "?" + qs : ""}`);
    },
    downloadUrls: (slug, photoIds, variant = "original") =>
      req(`/events/${slug}/gallery/download`, { method: "POST", json: { photoIds, variant } }),
    // ZIP is a browser navigation (streamed): build the form POST target
    zipAction: (slug) => `${base}/events/${slug}/gallery/zip`,

    /* ---- Photographer uploads ------------------------------------------ */
    uploadInit: (body) => req("/uploads/init", { method: "POST", json: body }),
    uploadPart: (id, partNumber) =>
      req(`/uploads/${id}/parts`, { method: "POST", json: { partNumber } }),
    uploadComplete: (id, parts) =>
      req(`/uploads/${id}/complete`, { method: "POST", json: { parts } }),
    uploadsSummary: (eventId) =>
      req(`/uploads/summary?eventId=${encodeURIComponent(eventId)}`),

    /* ---- Admin (subset; extend as the admin app is ported) ------------- */
    adminMetrics: () => req("/admin/metrics"),
    adminEvents: () => req("/admin/events"),
    adminCreateEvent: (body) => req("/admin/events", { method: "POST", json: body }),
    adminMintLink: (email, role) =>
      req("/admin/magic-links", { method: "POST", json: { email, role } }),
    // Create/reset a staff account with a password (admin-only).
    adminCreateStaff: (email, role, password, eventId) =>
      req("/admin/staff", {
        method: "POST",
        json: eventId ? { email, role, password, eventId } : { email, role, password },
      }),

    // escape hatch for endpoints not yet wrapped
    raw: req,
  };
}

// a ready-to-use default instance (same-origin /v1 unless overridden)
export const api = createClient();
export default api;
