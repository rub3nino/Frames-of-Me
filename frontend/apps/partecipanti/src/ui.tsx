import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Il guscio dell'app partecipante.
 *
 * L'identità è scritta per uno strumento professionale da scrivania, e qui
 * siamo sull'altro lato: seimila persone, due minuti ciascuna, una volta, in
 * piedi in una sala. Quindi la LINGUA vale per intero — colore, tipo, spazio,
 * movimento, anatomia dei componenti, ogni divieto — e il guscio da scrivania
 * no: niente barra laterale di 240 px, niente topbar con il percorso addosso
 * a chi si sta facendo un selfie.
 *
 * Quello che resta è una barra alta 48 px con il marchio, una colonna sola, e
 * sotto i 768 px il corpo a 16 px e i controlli a 40 px che i token già danno.
 *
 * LA BARRA IN FONDO NON C'È PIÙ, e la sua assenza è una decisione:
 * - il percorso è di sola andata e si fa una volta (accesso → selfie → attesa
 *   → galleria). Una barra a schede serve a tornare avanti e indietro tra
 *   luoghi paralleli, e qui di luoghi ce ne sono due;
 * - la scheda centrale era «Cerca» e riapriva il selfie: un invito a rifare
 *   per sbaglio una ricerca biometrica;
 * - costava 56 px di telefono su una schermata che è quasi tutta fotocamera;
 * - e `.tabbar` non esisteva in `components.css`: tenerla voleva dire
 *   inventare un componente, che è la cosa che l'identità vieta prima di
 *   tutte. Al suo posto: un collegamento solo, «I miei dati», nella barra.
 */

/** Il marchio: la cornice di messa a fuoco. Un solo colore, l'inchiostro
 *  corrente. Il punto centrale era blu, e il blu non decora: è link,
 *  selezione, fuoco, interruttore acceso. */
export function Mark() {
  return (
    <svg className="marchio" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
        <path d="M22 36 V28 a6 6 0 0 1 6-6 H36" />
        <path d="M64 22 H72 a6 6 0 0 1 6 6 V36" />
        <path d="M78 64 V72 a6 6 0 0 1-6 6 H64" />
        <path d="M36 78 H28 a6 6 0 0 1-6-6 V64" />
      </g>
      <circle cx="50" cy="50" r="7.5" fill="currentColor" />
    </svg>
  );
}

/**
 * La barra. Senza azione il marchio sta al centro e la barra è un'insegna;
 * con un'azione il marchio va a sinistra e l'azione a destra, perché due cose
 * su una riga si leggono ai due capi.
 */
export function AppBar({ dati }: { dati?: boolean }) {
  return (
    <header className="appbar" data-azione={dati || undefined}>
      <span className="appbar__marca"><Mark /> Frames of Me</span>
      {dati && <Link className="btn btn--link" to="/i-miei-dati">I miei dati</Link>}
    </header>
  );
}

/**
 * La schermata. `center` incolonna al centro verticale (accesso, attese,
 * esiti); `dati` mette il collegamento nella barra sulle pagine in cui la
 * persona è già entrata; `wide` allarga la colonna per la griglia di foto,
 * che è l'unica cosa in tutta l'app che non è una frase.
 */
export function Screen({
  children,
  center,
  wide,
  dati,
}: {
  children: ReactNode;
  center?: boolean;
  wide?: boolean;
  dati?: boolean;
}) {
  return (
    <>
      <AppBar dati={dati} />
      <main className={"screen" + (center ? " screen-center" : "") + (wide ? " screen--wide" : "")}>
        {children}
      </main>
    </>
  );
}

/* --- Glifi -------------------------------------------------------------------
   16 px, tratto 2, `currentColor`: il colore lo dà la variante dell'avviso,
   mai il glifo. Nessuna immagine decorativa dentro l'app. */
const glyph = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  "aria-hidden": true,
} as const;

export const IconInfo = () => (
  <svg className="icon" {...glyph}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
  </svg>
);
export const IconAttention = () => (
  <svg className="icon" {...glyph}>
    <path d="M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
  </svg>
);
export const IconError = () => (
  <svg className="icon" {...glyph}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" />
  </svg>
);
export const IconOk = () => (
  <svg className="icon" {...glyph}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.6 2.6L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * L'avviso in pagina. Una riga, non un cartello, e non galleggia.
 * Esiste come componente per un motivo sorvegliabile: l'anatomia è
 * «glifo primo figlio + `.callout__text`», e un avviso dentro un avviso è
 * vietato. Qui l'anatomia è scritta una volta e non si sbaglia in sei pagine.
 * Nessun avviso è SOLO colore: ogni variante porta il suo glifo.
 */
export function Callout({
  variante = "info",
  ruolo,
  glifo,
  children,
}: {
  variante?: "info" | "attention" | "errore" | "ok";
  ruolo?: "alert" | "status";
  /** Un glifo proprio, quando l'avviso deve distinguersi da un altro avviso
   *  della stessa variante: così due motivi diversi non sono la stessa tinta
   *  con parole diverse. */
  glifo?: ReactNode;
  children: ReactNode;
}) {
  const Glifo =
    variante === "errore" ? IconError
    : variante === "attention" ? IconAttention
    : variante === "ok" ? IconOk
    : IconInfo;
  return (
    <div
      className={`callout callout--${variante}`}
      role={ruolo ?? (variante === "errore" ? "alert" : "status")}
    >
      {glifo ?? <Glifo />}
      <span className="callout__text">{children}</span>
    </div>
  );
}

/* --- Perché un selfie è stato rifiutato --------------------------------------
   `GET /v1/events/:slug/gallery` torna `reason` quando la galleria è vuota, e
   le parole sono prescritte (CONTRACTS.md, «Gallery page»). Stanno qui perché
   le leggono due schermate — l'attesa, dov'è il momento di rimediare, e la
   galleria, dove si può arrivare dal collegamento dell'e-mail.

   Ogni motivo porta un GLIFO diverso, non una tinta diversa: l'esito si legge
   anche senza distinguere i colori. E ogni motivo che si può rimediare dice
   cosa fare di diverso, non «non valido». */
export type MotivoSelfie =
  | "no_face" | "face_too_small" | "low_quality" | "multiple_faces"
  | "no_photos_yet" | "liveness";

export const MOTIVI: Record<MotivoSelfie, { titolo: string; rimedio: string; glifo: "volto" | "vicino" | "sfocato" | "due" | "attesa" }> = {
  no_face:        { titolo: "Nel selfie non si vede un volto", rimedio: "Inquadra il viso dentro la cornice, con la luce davanti e non dietro di te.", glifo: "volto" },
  face_too_small: { titolo: "Avvicinati alla camera",          rimedio: "Il viso deve riempire la cornice: tieni il telefono a circa 40 cm.", glifo: "vicino" },
  low_quality:    { titolo: "Il selfie è sfocato o troppo scuro", rimedio: "Tieni fermo il telefono e mettiti dove c'è più luce.", glifo: "sfocato" },
  multiple_faces: { titolo: "Nel selfie ci sono più persone",   rimedio: "Fallo da solo: con due visi non sappiamo quale cercare.", glifo: "due" },
  liveness:       { titolo: "Il selfie non è stato accettato",  rimedio: "Rifallo con la camera, seguendo le indicazioni sullo schermo.", glifo: "volto" },
  no_photos_yet:  { titolo: "Non ci sono ancora foto",          rimedio: "Ti avviseremo per e-mail appena i fotografi caricano: non serve rifare il selfie.", glifo: "attesa" },
};

export const motivoSelfie = (r: unknown) =>
  typeof r === "string" && r in MOTIVI ? MOTIVI[r as MotivoSelfie] : null;

/** I glifi dei motivi. 28 px dentro `.empty`, 16 px dentro un `.callout`:
 *  sono le due misure che `components.css` prevede per `.icon`. */
export function GlifoMotivo({
  nome,
  piccolo,
}: { nome: "volto" | "vicino" | "sfocato" | "due" | "attesa"; piccolo?: boolean }) {
  const cls = piccolo ? "icon" : "icon icon--lg";
  const p = {
    viewBox: "0 0 24 24", fill: "none" as const, stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (nome === "volto") return (
    <svg className={cls} {...p}><path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" /><path d="M9 14c.9.9 4.2.9 5.1 0" /></svg>
  );
  if (nome === "vicino") return (
    <svg className={cls} {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><path d="M12 7.2 10.5 5.4h3L12 7.2ZM12 16.8l1.5 1.8h-3l1.5-1.8Z" /></svg>
  );
  if (nome === "sfocato") return (
    <svg className={cls} {...p}><circle cx="12" cy="12" r="3.4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" strokeDasharray="1 3" /></svg>
  );
  if (nome === "due") return (
    <svg className={cls} {...p}><circle cx="9" cy="9" r="3.2" /><circle cx="17" cy="11" r="2.4" /><path d="M3 19c0-2.8 2.7-5 6-5 1.4 0 2.7.4 3.7 1.1" /><path d="M14 19c0-1.9 1.6-3.4 3.5-3.4S21 17.1 21 19" /></svg>
  );
  return (
    <svg className={cls} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></svg>
  );
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  if (!d) return e;
  return (u.length <= 2 ? u[0] + "•" : u.slice(0, 2) + "•••") + "@" + d;
};
