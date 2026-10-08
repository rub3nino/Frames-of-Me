import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";

/**
 * Il guscio dello strumento e i pochi mattoni che le pagine dei fotografi
 * condividono. Tutto il resto viene da `components.css`: qui non si inventa
 * un componente che esiste già.
 *
 * Tre regole governano questo file:
 * 1. Nessuno stato è solo colore. `Esito` ha una forma E una parola, sempre:
 *    il rosso è riservato a ciò che è bloccato o irreversibile, «guarda qui»
 *    è ambra. Un caricamento non riuscito ma ritentabile è ambra, non rosso.
 * 2. Una proporzione è un numero più dei segni, non una tinta. `Quota` scrive
 *    la cifra e accende i segni; se il denominatore non c'è, scrive «—».
 * 3. Un pulsante con la sola icona ha un `aria-label`, e l'anello di fuoco
 *    non si toglie mai.
 */

/* --- Marchio: la cornice di messa a fuoco ---------------------------------- */
export function Mark() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
        <path d="M22 36 V28 a6 6 0 0 1 6-6 H36" /><path d="M64 22 H72 a6 6 0 0 1 6 6 V36" />
        <path d="M78 64 V72 a6 6 0 0 1-6 6 H64" /><path d="M36 78 H28 a6 6 0 0 1-6-6 V64" />
      </g>
      <circle cx="50" cy="50" r="7.5" fill="var(--accent)" />
    </svg>
  );
}

/* --- Numeri -----------------------------------------------------------------
   Formato italiano, mai troncato. Un valore assente è «—», non 0: zero è un
   conteggio vero e dire zero quando non si sa è una bugia. */
export const nf = (n: number) => n.toLocaleString("it-IT");
export const num = (n: number | null | undefined) => (n == null ? "—" : nf(n));
/** Una percentuale con un decimale, in formato italiano (12,5 %). */
export const pf = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** Byte in MB/KB. La cifra resta tabulare nel foglio di stile. */
export const bytes = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`
               : `${Math.max(1, Math.round(b / 1024)).toLocaleString("it-IT")} KB`;
/** Data gg/mm/aaaa e ora, come vuole la norma sui formati. Assente: «—». */
export const quando = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const data = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
  const ora = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return `${data} ${ora}`;
};

/* --- Esito: forma + parola -------------------------------------------------
   `spento` è il trattino neutro (in coda, già presente: nessun giudizio).
   `attesa` è il cerchio vuoto ambra: guarda qui, c'è qualcosa da fare.
   `bloccato` è il rombo rosso: non si può rimediare da qui. */
export type EsitoTipo = "spento" | "corso" | "fatto" | "attesa" | "bloccato";
const ESITO_CLASSE: Record<EsitoTipo, string> = {
  spento: "esito--non-pertinente",
  corso: "esito--in-esame",
  fatto: "esito--chiarita",
  attesa: "esito--da-esaminare",
  bloccato: "esito--eccezione",
};
export function Esito({ tipo, children }: { tipo: EsitoTipo; children: ReactNode }) {
  return <span className={`esito ${ESITO_CLASSE[tipo]}`}>{children}</span>;
}

/* --- Quota: un numero e dei segni, non un colore --------------------------- */
export function Quota({
  n, su, attenzione = false, suffisso,
}: { n: number | null | undefined; su: number | null | undefined; attenzione?: boolean; suffisso?: string }) {
  const noto = n != null && su != null && su > 0;
  const q = noto ? Math.min(1, n / su) : 0;
  const acceso = noto ? Math.round(q * 12) : 0;
  const etichetta = noto ? `${pf(q * 100)} %` : "—";
  return (
    <span className={"score" + (attenzione ? " score--sel" : "")}>
      <span className="score__n">{etichetta}</span>
      <span className="score__bar" role="img" aria-label={noto ? `${etichetta}${suffisso ? " " + suffisso : ""}` : "dato non disponibile"}>
        {Array.from({ length: 12 }, (_, i) => <i key={i} className={i < acceso ? "on" : undefined} />)}
      </span>
    </span>
  );
}

/* --- Attesa dentro il pulsante che l'ha iniziata --------------------------- */
export const Spin = () => <span className="btn-spin" aria-hidden="true" />;

/* --- Icone ----------------------------------------------------------------- */
const svg = (d: ReactNode, w = "1.8") => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
export const IconCarica = () => svg(<><path d="M12 15V4" /><path d="M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>);
export const IconAlbum = () => svg(<><path d="m12 2.6 8.5 4.2-8.5 4.2L3.5 6.8 12 2.6Z" /><path d="m3.5 12 8.5 4.2 8.5-4.2" /><path d="m3.5 17.2 8.5 4.2 8.5-4.2" /></>);
export const IconCopertura = () => svg(<><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M8 3v3M16 3v3M3 10h18" /></>);
export const IconQualita = () => svg(<><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4" /><path d="M12 17.5h.01" /></>);
export const IconStat = () => svg(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>);
export const IconChiudi = () => svg(<><path d="M6 6l12 12M18 6 6 18" /></>, "2");
export const IconInfo = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></>);
export const IconAvviso = () => svg(<><path d="M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>);
export const IconOk = () => svg(<><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.2 2.2 4.8-5" /></>);
export const IconCartella = () => svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></>);
export const IconApri = () => svg(<><path d="M7 17 17 7" /><path d="M8 7h9v9" /></>);
export const IconPiu = () => svg(<><path d="M12 5v14M5 12h14" /></>);
export const IconSezioni = () => svg(<><path d="M4 7h16M4 12h16M4 17h16" /></>, "2");

/* --- Guscio ---------------------------------------------------------------- */
const NAV: { to: string; label: string; icona: () => ReactNode; gruppo: string }[] = [
  { to: "/upload", label: "Caricamento", icona: IconCarica, gruppo: "Il lavoro" },
  { to: "/album", label: "Album", icona: IconAlbum, gruppo: "Il lavoro" },
  { to: "/copertura", label: "Copertura", icona: IconCopertura, gruppo: "Il lavoro" },
  { to: "/qualita", label: "Qualità", icona: IconQualita, gruppo: "Il controllo" },
  { to: "/statistiche", label: "Statistiche", icona: IconStat, gruppo: "Il controllo" },
];

export type Conteggi = Partial<Record<string, number>>;

export function Shell({
  titolo, dove, evento, azioni, conteggi, children,
}: {
  titolo: string;
  dove?: string;
  evento?: string | null;
  azioni?: ReactNode;
  conteggi?: Conteggi;
  children: ReactNode;
}) {
  const email = (() => {
    try { return sessionStorage.getItem("rephoto.email") || "Fotografo"; } catch { return "Fotografo"; }
  })();
  // Sotto i 1024 px la barra laterale è un cassetto. Esc lo chiude e il fuoco
  // torna al pulsante che l'ha aperto, come per il pannello.
  const [cassetto, setCassetto] = useState(false);
  const apriCassetto = useRef<HTMLButtonElement | null>(null);
  const chiudiCassetto = () => { setCassetto(false); apriCassetto.current?.focus(); };
  useEffect(() => {
    if (!cassetto) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") chiudiCassetto(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cassetto]);

  let gruppo = "";
  return (
    <div className="guscio">
      <aside className="lat" data-open={cassetto || undefined}>
        <a className="lat__marchio" href="/upload"><Mark /> Frames of Me</a>
        <nav className="lat__nav" aria-label="Sezioni">
          {NAV.map((v) => {
            const nuovoGruppo = v.gruppo !== gruppo;
            gruppo = v.gruppo;
            const n = conteggi?.[v.to];
            return (
              <div key={v.to}>
                {nuovoGruppo && <div className="lat__gruppo">{v.gruppo}</div>}
                {/* NavLink mette da sé aria-current="page" sulla voce attiva:
                    è il selettore con cui il foglio di stile la segna. */}
                <NavLink to={v.to} className="lat__voce" onClick={() => setCassetto(false)}>
                  {v.icona()}
                  {v.label}
                  {n != null && n > 0 && <span className="lat__n dato">{nf(n)}</span>}
                </NavLink>
              </div>
            );
          })}
        </nav>
        <div className="lat__piede">
          <div className="lat__chi">
            <span className="avatar avatar--b" aria-hidden="true">{email.slice(0, 2).toUpperCase()}</span>
            <span className="lat__chi-testo">
              <span className="lat__chi-nome" title={email}>{email}</span>
              <span className="lat__chi-ruolo">Fotografo dell'evento</span>
            </span>
          </div>
        </div>
      </aside>

      {/* Il cassetto non è un dialogo: nessun velo, e il clic fuori è un clic
          che lo richiude. Esiste solo quando il cassetto è aperto. */}
      {cassetto && (
        <button className="fuori-cassetto" type="button" onClick={chiudiCassetto} aria-label="Chiudi le sezioni" />
      )}

      <div className="corpo">
        <header className="topbar">
          <button
            ref={apriCassetto}
            className="btn btn--ghost btn--icon topbar__cassetto"
            type="button"
            aria-label="Apri le sezioni"
            aria-expanded={cassetto}
            onClick={() => (cassetto ? chiudiCassetto() : setCassetto(true))}
          >
            <IconSezioni />
          </button>
          <h1>{titolo}</h1>
          {dove && <span className="topbar__dove">{dove}</span>}
          <div className="topbar__fine">
            {evento !== undefined && <span className="topbar__evento" title={evento ?? undefined}>{evento ?? "—"}</span>}
            {azioni}
          </div>
        </header>
        <main className="lavoro">{children}</main>
      </div>
    </div>
  );
}

/* --- Schermata di accesso -------------------------------------------------- */
export function Accesso({ children }: { children: ReactNode }) {
  return (
    <div className="accesso-area">
      <div className="accesso">{children}</div>
    </div>
  );
}

/* --- Pannello laterale ----------------------------------------------------
   Non è un dialogo: la pagina dietro resta usabile, non c'è velo e il clic
   fuori è un clic sulla pagina. Esc chiude. Uno alla volta. */
export function Pannello({
  aperto, titolo, sotto, onChiudi, piede, children,
}: {
  aperto: boolean; titolo: string; sotto?: string; onChiudi: () => void; piede?: ReactNode; children: ReactNode;
}) {
  // Esc chiude E il fuoco torna a chi l'ha aperto: senza il ritorno del fuoco
  // la tastiera resta in un pannello che non c'è più.
  const chiApri = useRef<Element | null>(null);
  useEffect(() => {
    if (aperto) { chiApri.current = document.activeElement; return; }
    const chi = chiApri.current as HTMLElement | null;
    chiApri.current = null;
    if (chi && typeof chi.focus === "function" && document.contains(chi)) chi.focus();
  }, [aperto]);

  useEffect(() => {
    if (!aperto) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onChiudi(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aperto, onChiudi]);

  return (
    <aside className="panel-lat" data-open={aperto || undefined} aria-label={titolo} aria-hidden={!aperto || undefined}>
      <div className="panel__head">
        <div className="panel__title">
          {titolo}
          {sotto && <span className="panel__sotto">{sotto}</span>}
        </div>
        <button className="btn btn--ghost btn--icon" type="button" onClick={onChiudi} aria-label="Chiudi il pannello">
          <IconChiudi />
        </button>
      </div>
      <div className="panel__body">{children}</div>
      {piede && <div className="panel__foot">{piede}</div>}
    </aside>
  );
}

/* --- Toast ----------------------------------------------------------------
   Dice «è fatto» DOPO un gesto già compiuto, e non chiede nessuna decisione:
   per quello c'è un callout con il suo pulsante. Il fondo resta inchiostro,
   cambia solo l'icona — un toast verde o rosso sarebbe un errore. */
export type Avviso = { testo: string; variante: "success" | "error" } | null;

export function useAvviso(ms = 4000) {
  const [avviso, setAvviso] = useState<Avviso>(null);
  useEffect(() => {
    if (!avviso) return;
    const t = window.setTimeout(() => setAvviso(null), ms);
    return () => window.clearTimeout(t);
  }, [avviso, ms]);
  return { avviso, mostra: setAvviso };
}

export function Toast({ avviso }: { avviso: Avviso }) {
  if (!avviso) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      <div className="toast" data-variante={avviso.variante}>
        {avviso.variante === "success" ? <IconOk /> : <IconAvviso />}
        {avviso.testo}
      </div>
    </div>
  );
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
