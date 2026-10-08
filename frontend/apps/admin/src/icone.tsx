/**
 * Un set di icone: una famiglia, un peso (1.8), `currentColor`, 24×24 di
 * viewBox e la misura la dà la classe (`.icon`, 16 px). Niente emoji al posto
 * di un'icona, e il marchio non è un'icona del set (REGOLE §1).
 *
 * Sono elementi, non componenti: lo stesso elemento si può usare in più punti
 * e non costa un secondo albero.
 */

const s = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

/** Il marchio: la cornice di messa a fuoco. Il punto è l'unico blu del guscio. */
export function Marchio() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
        <path d="M22 36V28a6 6 0 0 1 6-6h8" />
        <path d="M64 22h8a6 6 0 0 1 6 6v8" />
        <path d="M78 64v8a6 6 0 0 1-6 6h-8" />
        <path d="M36 78h-8a6 6 0 0 1-6-6v-8" />
      </g>
      <circle cx="50" cy="50" r="7.5" fill="var(--accent)" />
    </svg>
  );
}

export const Ico = {
  diretta: (
    <svg {...s} className="icon"><path d="M3 12h4l2.5-6 4 12 2.5-6h5" /></svg>
  ),
  moderazione: (
    <svg {...s} className="icon"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
  ),
  codici: (
    <svg {...s} className="icon"><circle cx="8" cy="8" r="4.5" /><path d="M11.5 11.5 21 21M17 17l2-2M15 19l2-2" /></svg>
  ),
  album: (
    <svg {...s} className="icon"><rect x="3" y="7" width="14" height="12" rx="2" /><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4H19a2 2 0 0 1 2 2v9" /></svg>
  ),
  foto: (
    <svg {...s} className="icon"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M4 17l4.5-4c.8-.7 1.9-.7 2.7 0L20 20" /></svg>
  ),
  gallerie: (
    <svg {...s} className="icon"><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M9 10h.01M15 10h.01" /><path d="M9.5 14a3.4 3.4 0 0 0 5 0" /></svg>
  ),
  partecipanti: (
    <svg {...s} className="icon"><circle cx="9" cy="8" r="3.4" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 11a3 3 0 1 0 0-6M17.5 20a5.5 5.5 0 0 0-2.3-4.5" /></svg>
  ),
  eventi: (
    <svg {...s} className="icon"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
  ),
  privacy: (
    <svg {...s} className="icon"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg>
  ),
  contenuti: (
    <svg {...s} className="icon"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18M9 20V9" /></svg>
  ),
  operazioni: (
    <svg {...s} className="icon"><path d="M10 13a4 4 0 0 0 5.7.4l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" /><path d="M14 11a4 4 0 0 0-5.7-.4l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" /></svg>
  ),
  accessi: (
    <svg {...s} className="icon"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H3" /></svg>
  ),
  cassetto: (
    <svg {...s} className="icon"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
  ),
  comprimi: (
    <svg {...s} className="icon"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></svg>
  ),
  chiudi: (
    <svg {...s} className="icon"><path d="M6 6l12 12M18 6L6 18" /></svg>
  ),
  cerca: (
    <svg {...s} className="icon"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
  ),
  ok: (
    <svg {...s} className="icon"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></svg>
  ),
  guarda: (
    <svg {...s} className="icon"><path d="M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
  ),
  errore: (
    <svg {...s} className="icon"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>
  ),
  info: (
    <svg {...s} className="icon"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
  ),
  cestino: (
    <svg {...s} className="icon"><path d="M4 7h16" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /><path d="M10 11v7M14 11v7" /></svg>
  ),
  ricarica: (
    <svg {...s} className="icon"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></svg>
  ),
  esterno: (
    <svg {...s} className="icon"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
  ),
  copia: (
    <svg {...s} className="icon"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg>
  ),
  giu: (
    <svg {...s} className="icon"><path d="m6 9 6 6 6-6" /></svg>
  ),
};
