import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Ico, Marchio } from "./icone";
import { usaEventi } from "./lib/eventi";

/* ============================================================================
   Il guscio: barra laterale, topbar, pagina.

   Questa è la superficie per cui il manuale è stato scritto — uno strumento
   denso, usato per ore, dove lo strumento deve sparire e il lavoro è il
   soggetto (docs/brand/README.md). Da qui vengono tre decisioni visibili:

   - la barra laterale è un grado più scura della pagina e non porta un
     accento di marca sul fondo;
   - la voce corrente è fondo premuto e inchiostro, non un blu: il blu è
     selezione e fuoco, non navigazione;
   - la topbar tiene l'AMBITO (quale evento) e nient'altro: il titolo della
     schermata sta nella pagina, dove c'è anche la sua azione.
   ============================================================================ */

type Voce = { a: string; nome: string; icona: ReactNode; esatto?: boolean };

const GRUPPI: { nome: string; voci: Voce[] }[] = [
  {
    // Prima le schermate del giorno dell'evento: sono quelle che si guardano
    // mentre succede qualcosa.
    nome: "Giornata",
    voci: [
      { a: "/admin", nome: "Diretta", icona: Ico.diretta, esatto: true },
      { a: "/admin/moderazione", nome: "Moderazione", icona: Ico.moderazione },
      { a: "/admin/codici", nome: "Codici d'ingresso", icona: Ico.codici },
    ],
  },
  {
    nome: "Materiale",
    voci: [
      { a: "/admin/album", nome: "Album", icona: Ico.album },
      { a: "/admin/foto", nome: "Foto", icona: Ico.foto },
      { a: "/admin/gallerie", nome: "Gallerie", icona: Ico.gallerie },
    ],
  },
  {
    nome: "Persone",
    voci: [
      { a: "/admin/partecipanti", nome: "Partecipanti", icona: Ico.partecipanti },
      { a: "/admin/accessi", nome: "Accessi dello staff", icona: Ico.accessi },
    ],
  },
  {
    nome: "Evento",
    voci: [
      { a: "/admin/eventi", nome: "Eventi", icona: Ico.eventi },
      { a: "/admin/contenuti", nome: "Contenuti del sito", icona: Ico.contenuti },
    ],
  },
  {
    nome: "Conformità",
    voci: [{ a: "/admin/privacy", nome: "Privacy e retention", icona: Ico.privacy }],
  },
  {
    nome: "Sistema",
    voci: [{ a: "/admin/operazioni", nome: "Operazioni", icona: Ico.operazioni }],
  },
];

const CHIAVE_COMPRESSA = "rephoto.admin.barraCompressa";

export function Guscio({ children }: { children: ReactNode }) {
  const posizione = useLocation();
  const { eventi, eventoId, evento, scegli } = usaEventi();
  const [compressa, setCompressa] = useState<boolean>(() => {
    try { return localStorage.getItem(CHIAVE_COMPRESSA) === "true"; } catch { return false; }
  });
  const [cassetto, setCassetto] = useState(false);

  // Il cassetto si chiude quando si cambia schermata: è servito, ha finito.
  useEffect(() => { setCassetto(false); }, [posizione.pathname]);

  // Esc chiude il cassetto, e anche un clic fuori. È navigazione, non un
  // pannello: non trattiene il fuoco, non ha velo, e soprattutto non resta
  // aperto sopra il lavoro quando si è capito che non serviva. (Il clic fuori
  // da un PANNELLO è un'altra cosa: lì è un clic sulla pagina, e il pannello
  // resta — vedi REGOLE §4.)
  useEffect(() => {
    if (!cassetto) return;
    const allaTastiera = (e: KeyboardEvent) => { if (e.key === "Escape") setCassetto(false); };
    const alClic = (e: PointerEvent) => {
      const bersaglio = e.target;
      if (!(bersaglio instanceof Element)) return;
      if (bersaglio.closest(".barra") || bersaglio.closest(".topbar__cassetto")) return;
      setCassetto(false);
    };
    document.addEventListener("keydown", allaTastiera);
    document.addEventListener("pointerdown", alClic);
    return () => {
      document.removeEventListener("keydown", allaTastiera);
      document.removeEventListener("pointerdown", alClic);
    };
  }, [cassetto]);

  function comprimi() {
    setCompressa((c) => {
      const dopo = !c;
      try { localStorage.setItem(CHIAVE_COMPRESSA, String(dopo)); } catch { /* storage non scrivibile */ }
      return dopo;
    });
  }

  const chi = (() => {
    try { return sessionStorage.getItem("rephoto.email") || "staff"; } catch { return "staff"; }
  })();

  return (
    <div className="guscio" data-compressa={compressa ? "true" : "false"} data-cassetto={cassetto ? "true" : "false"}>
      <aside className="barra" aria-label="Sezioni della console">
        <div className="barra__testa">
          <NavLink className="barra__marchio" to="/admin" title="Frames of Me — console">
            <Marchio />
            <span className="barra__nome">Frames of Me</span>
          </NavLink>
        </div>
        <nav className="barra__nav">
          {GRUPPI.map((g) => (
            <div className="barra__gruppo" key={g.nome}>
              <div className="barra__etichetta">{g.nome}</div>
              {/* NavLink mette da sé `aria-current="page"` sulla voce attiva,
                  ed è su quell'attributo che il CSS disegna «dove sei»: è lo
                  sguardo, non uno stato da colorare di blu. */}
              {g.voci.map((v) => (
                <NavLink key={v.a} to={v.a} end={v.esatto} title={v.nome} className="voce">
                  {v.icona}
                  <span className="voce__testo">{v.nome}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="barra__pie">
          <span className="barra__chi">{chi}</span>
          <span>Amministratore</span>
        </div>
      </aside>

      <div className="area">
        <header className="topbar">
          <button
            className="btn btn--ghost btn--icon btn--sm topbar__cassetto"
            type="button"
            onClick={() => setCassetto((c) => !c)}
            aria-label={cassetto ? "Chiudi le sezioni" : "Apri le sezioni"}
            aria-expanded={cassetto}
          >
            {Ico.cassetto}
          </button>
          <button
            className="btn btn--ghost btn--icon btn--sm topbar__comprimi"
            type="button"
            onClick={comprimi}
            aria-label={compressa ? "Allarga la barra laterale" : "Comprimi la barra laterale"}
            title={compressa ? "Allarga la barra laterale" : "Comprimi la barra laterale"}
          >
            {Ico.comprimi}
          </button>

          <div className="topbar__ambito">
            <label htmlFor="ambito-evento">Evento</label>
            {eventi === null ? (
              <span className="skel" style={{ width: 180, height: 20 }} aria-hidden="true" />
            ) : eventi.length === 0 ? (
              <span className="chip">Nessun evento</span>
            ) : (
              <select
                id="ambito-evento"
                className="select"
                value={eventoId}
                onChange={(e) => scegli(e.target.value)}
              >
                {eventi.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="topbar__fine">
            {evento && <span className="topbar__chi mono">{evento.slug}</span>}
          </div>
        </header>

        {/* tabIndex -1: è qui che torna il fuoco quando il pannello si chiude
            e chi l'aveva aperto non c'è più (la riga appena cancellata). */}
        <main className="pagina" id="principale" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * L'intestazione di una schermata: titolo, una riga di spiegazione quando
 * serve, e l'azione del momento a destra. L'azione è UNA (REGOLE §3).
 */
export function Testa({ titolo, dek, azioni }: { titolo: string; dek?: ReactNode; azioni?: ReactNode }) {
  return (
    <div className="testa">
      <div className="testa__testo">
        <h1>{titolo}</h1>
        {dek && <p className="testa__dek">{dek}</p>}
      </div>
      {azioni && <div className="testa__azioni">{azioni}</div>}
    </div>
  );
}

/** «Scegli un evento»: lo dice una volta, al posto della tabella vuota. */
export function ServeUnEvento() {
  const { eventi } = usaEventi();
  if (eventi === null) return null;
  return (
    <div className="empty">
      <h2>Scegli un evento</h2>
      <p>
        {eventi.length === 0
          ? "Non c'è ancora nessun evento: creane uno in «Eventi» e poi torna qui."
          : "Questa schermata lavora su un evento alla volta: scegline uno dalla barra in alto."}
      </p>
    </div>
  );
}
