import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Marchio } from "../icone";
import { Callout, Primario } from "../parti";
import { api, messaggio } from "../lib/api";

/**
 * L'atterraggio del link via e-mail.
 *
 * Il link non entra da solo: serve un clic. Non è una formalità — i client di
 * posta e gli antivirus aprono i link per controllarli, e un link che entra
 * da sé verrebbe consumato prima che la persona lo veda, lasciandola fuori
 * con un link «già usato» che non ha mai usato.
 */
export default function Verifica() {
  const nav = useNavigate();
  const [parametri] = useSearchParams();
  const gettone = parametri.get("token") || "";
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");

  async function entra() {
    if (!gettone) {
      setErrore("Questo indirizzo non contiene nessun link: apri di nuovo il messaggio e tocca il collegamento per intero.");
      return;
    }
    setInCorso(true);
    setErrore("");
    try {
      await api.verify(gettone);
      nav("/admin");
    } catch (e: unknown) {
      setErrore(messaggio(e, "Questo link non vale più: vale una volta sola e scade. Chiedine un altro dalla pagina di accesso."));
    } finally { setInCorso(false); }
  }

  return (
    <div className="accesso-pagina">
      <div className="accesso-modulo">
        <div className="accesso-modulo__testa">
          <Marchio />
          Frames of Me
        </div>
        <div>
          <h1>Entra nella console</h1>
          <p className="accesso-modulo__dek">Il link è valido una volta sola. Tocca per usarlo adesso.</p>
        </div>

        {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

        {errore ? (
          <Primario blocco onClick={() => nav("/")}>Torna all'accesso</Primario>
        ) : (
          <Primario blocco onClick={() => void entra()} attesa={inCorso}>Entra nella console</Primario>
        )}
      </div>
    </div>
  );
}
