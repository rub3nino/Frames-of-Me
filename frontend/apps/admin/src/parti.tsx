import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { Ico } from "./icone";

/* ============================================================================
   I pezzi condivisi della console: l'inchiostro, il pannello, la finestra di
   conferma, i toast, gli esiti, il vuoto.

   Niente qui disegna da zero ciò che components.css già disegna: queste sono
   le REGOLE di comportamento che il CSS non può imporre da solo — quale
   primario resta nero, dove torna il fuoco, cosa serve per cancellare.
   ============================================================================ */

/* --- Un solo inchiostro in vista -------------------------------------------
   REGOLE §3: mentre un pannello è aperto il primario della pagina perde
   `btn--primary` e resta secondario, perché non ci sono due neri. Lo stesso
   vale mentre è aperta una finestra di conferma: lì il nero (o il rosso) è
   quello della conferma.

   È un contatore e non un booleano perché chi lo prende lo rilascia: il
   pannello e la finestra non sanno l'uno dell'altro. */
type Inchiostro = {
  occupato: boolean;
  /** Prende l'inchiostro e restituisce la funzione che lo rilascia. */
  prendi: (tipo: "pannello" | "finestra") => () => void;
};

const InchiostroCtx = createContext<Inchiostro>({ occupato: false, prendi: () => () => {} });

export function InchiostroProvider({ children }: { children: ReactNode }) {
  const [presi, setPresi] = useState<("pannello" | "finestra")[]>([]);
  const prendi = useCallback((tipo: "pannello" | "finestra") => {
    setPresi((correnti) => {
      // Uno alla volta: i pannelli non si impilano (REGOLE §4). Se succede è
      // un errore di una schermata, e si vede subito invece di diventare due
      // facciate sovrapposte in produzione.
      if (tipo === "pannello" && correnti.includes("pannello")) {
        console.warn("[admin] due pannelli laterali aperti insieme: uno alla volta.");
      }
      return [...correnti, tipo];
    });
    let rilasciato = false;
    return () => {
      if (rilasciato) return;
      rilasciato = true;
      setPresi((correnti) => {
        const i = correnti.indexOf(tipo);
        if (i < 0) return correnti;
        const dopo = correnti.slice();
        dopo.splice(i, 1);
        return dopo;
      });
    };
  }, []);
  const valore = useMemo<Inchiostro>(() => ({ occupato: presi.length > 0, prendi }), [presi.length, prendi]);
  return <InchiostroCtx.Provider value={valore}>{children}</InchiostroCtx.Provider>;
}

export const usaInchiostro = () => useContext(InchiostroCtx);

/**
 * L'azione primaria di una schermata. Una sola, in inchiostro, con verbo e
 * oggetto nell'etichetta. Quando un pannello o una finestra è aperta scende a
 * secondaria da sé: non c'è una schermata che possa dimenticarselo.
 *
 * `perche` è il motivo per cui non si può premere, e si vede: un primario
 * spento e muto è un vicolo cieco (REGOLE §3).
 */
export function Primario({
  perche, children, className, disabled, attesa, type, blocco, ...resto
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { perche?: string; attesa?: boolean; blocco?: boolean }) {
  const { occupato } = usaInchiostro();
  const motivoId = useId();
  const spento = Boolean(disabled) || Boolean(attesa);
  const classi = ["btn", occupato ? "" : "btn--primary", blocco ? "btn--block" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={blocco ? "primario primario--blocco" : "primario"}>
      <button
        {...resto}
        type={type ?? "button"}
        className={classi}
        disabled={spento}
        aria-describedby={spento && perche ? motivoId : undefined}
        title={spento ? perche : undefined}
        data-loading={attesa || undefined}
      >
        {attesa && <span className="btn-spin" aria-hidden="true" />}
        {children}
      </button>
      {spento && perche && <span className="motivo" id={motivoId}>{perche}</span>}
    </span>
  );
}

/* --- Pannello laterale -----------------------------------------------------
   Non è un dialogo: la pagina dietro resta usabile, non c'è velo, il clic
   fuori è un clic sulla pagina. Esc chiude e il fuoco torna a chi l'ha
   aperto (REGOLE §4).

   Il fuoco: all'apertura si sposta sul corpo del pannello, così chi usa la
   tastiera continua da dentro, ma NON è intrappolato — Tab esce e va nella
   pagina, che è ancora viva. Alla chiusura torna all'elemento che era attivo
   al momento dell'apertura; se quell'elemento non c'è più (è la riga che
   abbiamo appena cancellato) va alla regione principale, che ha tabIndex -1
   per poterlo ricevere. Mai lasciarlo sul `body`: da lì Tab ricomincia dal
   guscio e si perde il posto. */
export function Pannello({
  aperto, titolo, dek, onChiudi, primario, secondarie, children,
}: {
  aperto: boolean;
  titolo: string;
  dek?: ReactNode;
  onChiudi: () => void;
  /** Il primario del pannello: sta a SINISTRA nel piede, Annulla dopo. */
  primario?: ReactNode;
  secondarie?: ReactNode;
  children: ReactNode;
}) {
  const corpo = useRef<HTMLDivElement | null>(null);
  const tornaA = useRef<HTMLElement | null>(null);
  const { prendi } = usaInchiostro();
  const titoloId = useId();

  /**
   * `onChiudi` arriva come funzione in linea, quindi cambia identità a ogni
   * render: se fosse una dipendenza dell'effetto qui sotto, l'effetto
   * ripartirebbe a ogni battuta di tastiera dentro il pannello — e il suo
   * ritorno rimetterebbe il fuoco sul corpo del pannello dopo il primo
   * carattere, rendendo i campi inutilizzabili. Sta in un riferimento, e
   * l'effetto dipende solo dall'apertura.
   */
  const chiudiRif = useRef(onChiudi);
  useEffect(() => { chiudiRif.current = onChiudi; });

  useEffect(() => {
    if (!aperto) return;
    const attivo = document.activeElement;
    tornaA.current = attivo instanceof HTMLElement && attivo !== document.body ? attivo : null;
    const rilascia = prendi("pannello");
    const t = window.setTimeout(() => corpo.current?.focus(), 0);
    function allaTastiera(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      chiudiRif.current();
    }
    document.addEventListener("keydown", allaTastiera);
    return () => {
      document.removeEventListener("keydown", allaTastiera);
      window.clearTimeout(t);
      rilascia();
      const indietro = tornaA.current;
      tornaA.current = null;
      if (indietro && document.contains(indietro)) indietro.focus();
      else document.getElementById("principale")?.focus();
    };
  }, [aperto, prendi]);

  return (
    <aside
      className="panel-lat"
      data-open={aperto ? "true" : "false"}
      aria-labelledby={titoloId}
      aria-hidden={aperto ? undefined : true}
    >
      <div className="panel__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="panel__title" id={titoloId}>{titolo}</div>
          {dek && <span className="cell-sub">{dek}</span>}
        </div>
        <button className="btn btn--ghost btn--icon btn--sm" type="button" onClick={onChiudi} aria-label="Chiudi il pannello (Esc)" title="Chiudi (Esc)">
          {Ico.chiudi}
        </button>
      </div>
      <div className="panel__body" ref={corpo} tabIndex={-1}>{children}</div>
      {(primario || secondarie) && (
        <div className="panel__foot">
          {primario}
          <button className="btn" type="button" onClick={onChiudi}>Annulla</button>
          {secondarie}
        </div>
      )}
    </aside>
  );
}

/** Il primario di un pannello: è nero anche mentre il pannello è aperto,
    perché l'inchiostro della schermata in quel momento è il suo. */
export function PrimarioPannello({
  children, className, disabled, attesa, perche, type, ...resto
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { attesa?: boolean; perche?: string }) {
  const spento = Boolean(disabled) || Boolean(attesa);
  return (
    <button
      {...resto}
      type={type ?? "button"}
      className={["btn", "btn--primary", className ?? ""].filter(Boolean).join(" ")}
      disabled={spento}
      title={spento ? perche : undefined}
      data-loading={attesa || undefined}
    >
      {attesa && <span className="btn-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

/* --- Finestra di conferma --------------------------------------------------
   REGOLE §4: una conferma irreversibile è un DIALOGO, non un pannello — e il
   kit non ne ha l'anatomia, quindi è il `<dialog>` nativo con `showModal()`.
   La scelta non è una scorciatoia: showModal dà quattro cose che una finestra
   finta dovrebbe rifare a mano e sbaglierebbe — il fuoco intrappolato finché
   la domanda non ha risposta, la pagina inerte (nessun tasto della coda
   arriva più), Esc, e il fuoco che torna da sé a chi l'ha aperta.

   Dentro, il primario è `btn--primary btn--danger` e sta a sinistra; Annulla
   è secondario e subito dopo. */
export function Finestra({
  aperta, titolo, onChiudi, azione, children,
}: {
  aperta: boolean;
  titolo: string;
  onChiudi: () => void;
  /** Il primario della conferma. Sta a sinistra nel piede. */
  azione: ReactNode;
  children: ReactNode;
}) {
  const rif = useRef<HTMLDialogElement | null>(null);
  const { prendi } = usaInchiostro();
  const titoloId = useId();

  /* Come nel pannello: `onChiudi` cambia identità a ogni render, e come
     dipendenza dell'effetto chiuderebbe e riaprirebbe la finestra a ogni
     spunta e a ogni carattere digitato — perdendo il fuoco a metà di una
     conferma, che è l'ultimo posto dove si vuole perdere il fuoco. */
  const chiudiRif = useRef(onChiudi);
  useEffect(() => { chiudiRif.current = onChiudi; });

  useEffect(() => {
    const d = rif.current;
    if (!d) return;
    if (!aperta) {
      if (d.open) d.close();
      return;
    }
    if (!d.open) d.showModal();
    const rilascia = prendi("finestra");
    // `cancel` è Esc: il browser chiude, noi allineiamo lo stato.
    const allAnnulla = (e: Event) => { e.preventDefault(); chiudiRif.current(); };
    d.addEventListener("cancel", allAnnulla);
    return () => {
      d.removeEventListener("cancel", allAnnulla);
      rilascia();
      if (d.open) d.close();
    };
  }, [aperta, prendi]);

  return (
    <dialog className="finestra" ref={rif} aria-labelledby={titoloId}>
      <div className="finestra__corpo">
        <h2 id={titoloId}>{titolo}</h2>
        {children}
      </div>
      <div className="finestra__pie">
        {azione}
        <button className="btn" type="button" onClick={onChiudi}>Annulla</button>
      </div>
    </dialog>
  );
}

/* --- Toast -----------------------------------------------------------------
   Dice «è fatto» o «non è riuscito» DOPO un gesto già compiuto, e non chiede
   decisioni. Il fondo resta inchiostro: cambia solo l'icona (REGOLE §4). */
type Variante = "success" | "error" | "warning" | "info";
type Avviso = { id: number; testo: string; dettaglio?: string; variante: Variante };

const AvvisiCtx = createContext<(testo: string, variante?: Variante, dettaglio?: string) => void>(() => {});
export const usaAvvisi = () => useContext(AvvisiCtx);

const ICONA: Record<Variante, ReactNode> = {
  success: Ico.ok, error: Ico.errore, warning: Ico.guarda, info: Ico.info,
};

export function AvvisiProvider({ children }: { children: ReactNode }) {
  const [avvisi, setAvvisi] = useState<Avviso[]>([]);
  const prossimo = useRef(1);
  const mostra = useCallback((testo: string, variante: Variante = "success", dettaglio?: string) => {
    const id = prossimo.current++;
    setAvvisi((correnti) => [...correnti, { id, testo, variante, ...(dettaglio ? { dettaglio } : {}) }]);
    window.setTimeout(() => setAvvisi((correnti) => correnti.filter((a) => a.id !== id)), 4000);
  }, []);
  return (
    <AvvisiCtx.Provider value={mostra}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {avvisi.map((a) => (
          <div className="toast" key={a.id} data-variante={a.variante}>
            {ICONA[a.variante]}
            <span>{a.testo}</span>
            {a.dettaglio && <span className="toast__dett">{a.dettaglio}</span>}
          </div>
        ))}
      </div>
    </AvvisiCtx.Provider>
  );
}

/* --- Esiti -----------------------------------------------------------------
   Forma e parola insieme, mai il colore da solo (REGOLE §1.3). Le forme sono
   quelle di components.css: cerchio vuoto, mezzo pieno, pieno, rombo,
   trattino. */
export function Esito({ forma, children }: { forma: string; children: ReactNode }) {
  return <span className={`esito esito--${forma}`}>{children}</span>;
}

const ESITO_FOTO: Record<string, [string, string]> = {
  indexed: ["chiarita", "Indicizzata"],
  processing: ["in-esame", "In elaborazione"],
  uploaded: ["attesa", "Caricata"],
  error: ["eccezione", "Errore"],
};

export function EsitoFoto({ stato }: { stato: string }) {
  const [forma, parola] = ESITO_FOTO[stato] ?? ["non-pertinente", stato];
  return <Esito forma={forma}>{parola}</Esito>;
}

const ESITO_MODERAZIONE: Record<string, [string, string]> = {
  // Ambra e cerchio vuoto: aspetta una persona, ed è il «guarda qui».
  pending: ["da-esaminare", "In attesa"],
  // Mezzo pieno: ha deciso la macchina, non ancora una persona.
  auto_rejected: ["in-esame", "Scartata dallo screening"],
  approved: ["chiarita", "Approvata"],
  // Rombo rosso: è l'eccezione, e qui vuol dire che il file non c'è più.
  rejected: ["eccezione", "Rifiutata, file cancellato"],
};

export function EsitoModerazione({ stato }: { stato: string | undefined }) {
  const [forma, parola] = ESITO_MODERAZIONE[stato ?? ""] ?? ["non-pertinente", stato ?? "—"];
  return <Esito forma={forma}>{parola}</Esito>;
}

/* --- Vuoto -----------------------------------------------------------------
   Dice PERCHÉ è vuoto e porta il verbo. Quando è vuoto per colpa di un
   filtro, dice QUALE filtro togliere: «nessun risultato» non si corregge da
   sé (REGOLE §4, tabella). */
export function Vuoto({ titolo, children, azione }: { titolo: string; children?: ReactNode; azione?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{titolo}</h2>
      {children && <p>{children}</p>}
      {azione}
    </div>
  );
}

/** Lo scheletro di una lista: righe che respirano, non uno spinner. */
export function RigheFinte({ righe, colonne }: { righe: number; colonne: number }) {
  return (
    <>
      {Array.from({ length: righe }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: colonne }).map((_, c) => (
            <td key={c}><span className="skel" style={{ display: "block", width: c === 0 ? "60%" : "40%" }} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Un avviso in pagina: resta e porta l'azione che risolve. */
export function Callout({
  genere = "info", children, azione, ruolo,
}: { genere?: "info" | "attention" | "errore" | "ok"; children: ReactNode; azione?: ReactNode; ruolo?: "alert" | "status" }) {
  const icona = genere === "errore" ? Ico.errore : genere === "attention" ? Ico.guarda : genere === "ok" ? Ico.ok : Ico.info;
  return (
    <div className={`callout callout--${genere}`} role={ruolo}>
      {icona}
      <span className="callout__text">{children}</span>
      {azione}
    </div>
  );
}

export function Tasto({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
