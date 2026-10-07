// Shared API client, same-origin /v1 (Vite dev proxy / prod reverse proxy).
// @ts-ignore - plain ES module without bundled types
import { createClient, ApiError } from "@api";

export const api = createClient();
export { ApiError };

export const EVENT_SLUG = "demo"; // TODO: from /api/config or the URL in later phases
