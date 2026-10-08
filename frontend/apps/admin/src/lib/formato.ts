/**
 * Formati. Italiano, cifre tabellari, mai troncati, e un dato assente è `—`
 * (REGOLE §1.5 e §7). Un `0` al posto di un dato che manca è una bugia: dice
 * «ne ho contati zero» quando la verità è «non lo so».
 */

export const ASSENTE = "—";

export function numero(valore: number | null | undefined): string {
  return typeof valore === "number" && Number.isFinite(valore)
    ? valore.toLocaleString("it-IT")
    : ASSENTE;
}

/** gg/mm/aaaa, ora e minuti. */
export function quando(iso: string | null | undefined): string {
  if (!iso) return ASSENTE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ASSENTE;
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Solo il giorno, per le colonne dove l'ora non serve. */
export function giorno(iso: string | null | undefined): string {
  if (!iso) return ASSENTE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ASSENTE;
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Un'attesa in secondi detta come la direbbe una persona. */
export function eta(secondi: number | null | undefined): string {
  if (typeof secondi !== "number" || !Number.isFinite(secondi)) return ASSENTE;
  if (secondi < 60) return `${Math.round(secondi)} s`;
  if (secondi < 3600) return `${Math.round(secondi / 60)} min`;
  return `${(secondi / 3600).toLocaleString("it-IT", { maximumFractionDigits: 1 })} h`;
}

export function peso(byte: number | null | undefined): string {
  if (typeof byte !== "number" || !Number.isFinite(byte)) return ASSENTE;
  if (byte >= 1e6) return `${(byte / 1e6).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
  return `${Math.round(byte / 1024).toLocaleString("it-IT")} kB`;
}

/** Un id lungo in una riga densa: le prime otto cifre bastano a riconoscerlo. */
export function id(valore: string | null | undefined): string {
  if (!valore) return ASSENTE;
  return valore.length > 12 ? `${valore.slice(0, 8)}…` : valore;
}

export const emailValida = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
export const uuidValido = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
