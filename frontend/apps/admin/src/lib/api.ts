// @ts-ignore plain module
import { createClient, ApiError } from "@api";

/**
 * Il client condiviso, più quattro funzioni tipizzate.
 *
 * `api.raw` esiste per le rotte che il client non avvolge (sono la maggior
 * parte di quelle di servizio) ma non è tipizzata, e una console che legge
 * venti forme diverse senza tipi è una console che sbaglia un nome di campo e
 * mostra una colonna vuota per sempre. Queste quattro la tipizzano in un
 * punto solo.
 *
 * Il percorso si scrive SENZA `/v1`: il client lo mette lui (`base`). Il
 * vecchio codice qui dentro passava a volte `/v1/...`, che diventava
 * `/v1/v1/...` e rispondeva 404 — una delle due cancellazioni per id non ha
 * mai funzionato.
 */
export const api = createClient();
export { ApiError };

export const leggi = <T,>(percorso: string): Promise<T> => api.raw(percorso) as Promise<T>;
export const invia = <T,>(percorso: string, json?: unknown): Promise<T> =>
  api.raw(percorso, json === undefined ? { method: "POST" } : { method: "POST", json }) as Promise<T>;
export const correggi = <T,>(percorso: string, json: unknown): Promise<T> =>
  api.raw(percorso, { method: "PATCH", json }) as Promise<T>;
export const cancella = <T,>(percorso: string): Promise<T> =>
  api.raw(percorso, { method: "DELETE" }) as Promise<T>;

/** Lo stato HTTP di un errore del client, quando c'è. */
export function stato(errore: unknown): number | null {
  const n = (errore as { status?: unknown } | null)?.status;
  return typeof n === "number" ? n : null;
}

/**
 * Il messaggio dell'api quando c'è, altrimenti quello passato. L'errore deve
 * dire cosa è andato storto, non «errore» (REGOLE §7).
 */
export function messaggio(errore: unknown, ripiego: string): string {
  const m = (errore as { message?: unknown } | null)?.message;
  return typeof m === "string" && m.length > 0 && m !== "Failed to fetch" ? m : ripiego;
}
