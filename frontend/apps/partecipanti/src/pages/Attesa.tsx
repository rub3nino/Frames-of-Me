import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Screen, Callout, GlifoMotivo, motivoSelfie } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

/**
 * L'attesa, mentre il confronto gira.
 *
 * Qui la regola è esplicita, e sono due righe della tabella di REGOLE.md §4
 * usate per i loro due mestieri diversi:
 *
 * - «Attendere un clic già fatto → `.btn-spin` nel bottone». Il clic è
 *   «Trova le mie foto», e quel bottone resta in pagina, disabilitato, con lo
 *   spinner dentro: così si vede CHE COSA sta girando. Disabilitato non tace:
 *   dice perché non si può premere di nuovo.
 * - «Attendere una lista → `.skel` nelle righe». La lista che arriva è la
 *   griglia delle foto, quindi lo scheletro ha la forma delle celle che
 *   arriveranno, non una barra qualunque.
 * - «Mai uno spinner a tutto schermo». Non c'è, da nessuna parte.
 *
 * Quando la galleria è pronta si va alla galleria, sostituendo questa voce
 * nella cronologia: con due minuti a testa, fermare la persona davanti a un
 * bottone «Apri» per farle fare un clic in più è un clic in più. Il «indietro»
 * dalla galleria torna al selfie, non in un'attesa che è già finita.
 *
 * Quando la galleria è pronta ed è VUOTA, l'esito non è un vuoto: è un motivo.
 * Le parole sono quelle prescritte da CONTRACTS.md, ognuna con il suo glifo, e
 * ognuna che si può rimediare dice cosa fare di diverso.
 */

const PASSO_MS = 2500;
/* 45 s: oltre questo non è più «pochi secondi», e dirlo è meglio che tacere. */
const LUNGA_MS = 45_000;

export default function Attesa() {
  const nav = useNavigate();
  const [stato, setStato] = useState<"attesa" | "vuota">("attesa");
  const [motivo, setMotivo] = useState<ReturnType<typeof motivoSelfie>>(null);
  const [lunga, setLunga] = useState(false);
  const [rete, setRete] = useState(false);
  const falliti = useRef(0);

  useEffect(() => {
    const avvio = Date.now();
    let fermo = false;

    const giro = async () => {
      try {
        const g: any = await api.getGallery(EVENT_SLUG, { limit: 1 });
        falliti.current = 0;
        setRete(false);
        if (fermo || g?.status === "queued") return;
        if (g?.status === "ready" && (g?.total ?? 0) > 0) {
          fermo = true;
          nav(`/e/${EVENT_SLUG}`, { replace: true });
          return;
        }
        /* `ready` o `empty` con zero foto: la galleria dice perché. */
        fermo = true;
        setMotivo(motivoSelfie(g?.reason));
        setStato("vuota");
      } catch {
        falliti.current += 1;
        if (falliti.current >= 3) setRete(true);
      }
      if (!fermo && Date.now() - avvio > LUNGA_MS) setLunga(true);
    };

    giro();
    const id = window.setInterval(() => { if (!fermo) giro(); }, PASSO_MS);
    return () => { fermo = true; window.clearInterval(id); };
  }, [nav]);

  /* --- Nessuna foto: il motivo, non un vuoto ------------------------------ */
  if (stato === "vuota") {
    const rimediabile = motivo !== null && motivo.glifo !== "attesa";
    return (
      <Screen center dati>
        <div className="empty">
          {motivo ? <GlifoMotivo nome={motivo.glifo} /> : <GlifoMotivo nome="volto" />}
          <h2>{motivo ? motivo.titolo : "Non ti abbiamo trovato in queste foto"}</h2>
          <p>
            {motivo
              ? motivo.rimedio
              : "Può essere il selfie, oppure che nelle foto caricate finora non ci sei. Puoi riprovare con un primo piano più chiaro."}
          </p>
          {rimediabile || !motivo ? (
            <Link className="btn btn--primary" to="/selfie">Fai un altro selfie</Link>
          ) : (
            <Link className="btn" to={`/e/${EVENT_SLUG}`}>Apri la galleria</Link>
          )}
        </div>
      </Screen>
    );
  }

  /* --- L'attesa ------------------------------------------------------------ */
  return (
    <Screen dati>
      <div className="colonna">
        <header className="gruppo">
          <h1 className="titolo">Cerco le tue foto</h1>
          <p className="dek">
            Ci vogliono pochi secondi. Puoi chiudere la pagina: ti avvisiamo per e-mail quando
            sono pronte.
          </p>
        </header>

        {/* Il bottone che ha iniziato l'attesa, con lo spinner dentro.
            Disabilitato dice perché. */}
        <button
          className="btn btn--primary btn--block"
          type="button"
          disabled
          data-loading="true"
          title="La ricerca è già in corso: non serve premere di nuovo"
        >
          <span className="btn-spin" aria-hidden="true" />
          Cerco nelle foto dell'evento
        </button>

        {lunga && (
          <Callout variante="info">
            Sta andando per le lunghe: in sala ci sono molte ricerche in coda. Puoi chiudere la
            pagina, ti avvisiamo per e-mail.
          </Callout>
        )}
        {rete && (
          <Callout variante="attention">
            Non riusciamo a parlare con il server. La ricerca va avanti comunque: controlla la
            rete, oppure riapri questa pagina più tardi.
          </Callout>
        )}

        {/* La lista che arriva, nella forma che avrà. Respira, non gira. */}
        <div className="griglia" aria-hidden="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="skel cella--attesa" />
          ))}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          Ricerca in corso. Ti portiamo alla galleria appena è pronta.
        </p>
      </div>
    </Screen>
  );
}
