import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
// @ts-ignore plain module
import { createClient } from "@api";
import { Accesso, Mark, Spin, IconAvviso } from "../ui";

const api = createClient();

/**
 * Il link di accesso aperto dalla posta: invito dello staff o riserva del
 * giorno evento.
 *
 * Perché c'è un pulsante e non un ingresso automatico: aprire un link non è
 * un consenso, e i client di posta pre-caricano gli URL. L'ingresso è un
 * gesto deliberato, e l'attesa gira dentro quel pulsante.
 *
 * Il link scaduto non è un rosso qualunque: è bloccante (da qui non si entra
 * più), quindi il callout è d'errore e porta con sé la via d'uscita.
 */
export default function Verify() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const token = sp.get("token") || "";
  const [inCorso, setInCorso] = useState(false);
  const [scaduto, setScaduto] = useState(!token);

  async function entra() {
    if (!token) { setScaduto(true); return; }
    setInCorso(true);
    try {
      await api.verify(token);
      nav("/upload");
    } catch {
      setScaduto(true);
    } finally {
      setInCorso(false);
    }
  }

  return (
    <Accesso>
      <div className="accesso__marchio"><Mark /> Frames of Me</div>

      {scaduto ? (
        <>
          <h1 className="accesso__titolo">Questo link non vale più</h1>
          <p className="accesso__dek">
            Un link di accesso dura 15 minuti e si usa una volta sola. Chiedine un altro: ci
            vogliono pochi secondi.
          </p>
          <div className="callout callout--errore" role="alert">
            <IconAvviso />
            <span className="callout__text">
              {token
                ? "Il link è scaduto o è già stato usato. Non è possibile entrare da qui."
                : "Questo indirizzo non contiene nessun link di accesso: apri il link dalla posta, per intero."}
            </span>
          </div>
          <button className="btn btn--primary btn--block" type="button" onClick={() => nav("/")}>
            Richiedi un nuovo link
          </button>
        </>
      ) : (
        <>
          <h1 className="accesso__titolo">Bentornato</h1>
          <p className="accesso__dek">
            Entra per riprendere il caricamento. La sessione resta aperta su questo computer.
          </p>
          {/* Unico primario della schermata, con la sua attesa dentro. */}
          <button
            className="btn btn--primary btn--lg btn--block"
            type="button"
            onClick={entra}
            disabled={inCorso}
            data-loading={inCorso || undefined}
          >
            {inCorso && <Spin />}
            Entra e carica le foto
          </button>
          <p className="accesso__nota">
            Se l'indirizzo non è più abilitato sull'evento, l'ingresso non riesce: in quel caso
            chiedi allo staff di invitarti di nuovo.
          </p>
        </>
      )}
    </Accesso>
  );
}
