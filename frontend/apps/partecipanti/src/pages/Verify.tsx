import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Screen, Callout } from "../ui";
import { api } from "../lib/api";

/**
 * L'atterraggio del link via e-mail. Resta come RISERVA DEL GIORNO EVENTO
 * anche se nessuna pagina ci porta più: la pagina di accesso ha tolto
 * l'e-mail dal percorso principale, perché con 6.000 registrazioni in un
 * giorno la posta non sta in un percorso di due minuti. Ma la rotta
 * `POST /v1/auth/verify` esiste, l'e-mail con il link si manda ancora, e al
 * banco dell'evento è la cosa che risolve una persona bloccata. Cancellarla
 * perché nessuno la linka sarebbe toglierla il giorno in cui serve.
 *
 * Due cose non sono cosmetiche:
 *
 * 1. IL LINK NON SI CONSUMA AL CARICAMENTO. Un token di accesso si brucia al
 *    primo uso, e le anteprime dei client di posta e gli scanner aziendali
 *    aprono i link da soli: se lo consumassimo qui, la persona troverebbe il
 *    suo link già usato senza aver toccato niente. Si consuma sul clic.
 * 2. Riusa il blocco `.accesso` della pagina di accesso. È la stessa cosa —
 *    una finestra con un titolo, una frase e un'azione — e dare a due
 *    schermate di accesso due vestiti diversi è il modo più rapido di far
 *    sembrare un prodotto due prodotti.
 */

export default function Verify() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const token = sp.get("token") || "";
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState(token ? "" : "manca");

  async function entra() {
    if (inCorso) return;
    if (!token) { setErrore("manca"); return; }
    setInCorso(true);
    setErrore("");
    try {
      await api.verify(token);
      nav("/selfie", { replace: true });
    } catch (err: any) {
      setErrore(err?.status === 429 ? "troppi" : "scaduto");
      setInCorso(false);
    }
  }

  return (
    <Screen center>
      <div className="accesso">
        <header className="accesso__testa">
          <h1 className="accesso__titolo">
            {errore ? "Questo link non funziona più" : "Bentornato"}
          </h1>
          <p className="accesso__dek">
            {errore
              ? "I link di accesso valgono una volta sola e scadono dopo poco: è così che tengono fuori chi non sei tu."
              : "Tocca il pulsante per entrare e vedere le foto in cui compari."}
          </p>
        </header>

        {errore === "manca" && (
          <Callout variante="errore">
            In questo indirizzo manca il codice del link. Succede quando l'indirizzo viene
            copiato a mano o tagliato dal client di posta: riapri il link dall'e-mail intera.
          </Callout>
        )}
        {errore === "scaduto" && (
          <Callout variante="errore">
            Questo link è già stato usato o è scaduto. Torna all'accesso: entrare con e-mail e
            password o con Google ci mette lo stesso tempo e non scade.
          </Callout>
        )}
        {errore === "troppi" && (
          <Callout variante="errore">
            Troppi tentativi da questa rete. Aspetta qualche minuto e riprova, oppure torna
            all'accesso.
          </Callout>
        )}

        {/* L'unico primario della schermata: entrare, o tornare dove si entra. */}
        {errore ? (
          <Link className="btn btn--primary btn--block" to="/">Torna all'accesso</Link>
        ) : (
          <button
            className="btn btn--primary btn--block"
            type="button"
            onClick={entra}
            disabled={inCorso}
            data-loading={inCorso || undefined}
          >
            {inCorso && <span className="btn-spin" aria-hidden="true" />}
            Entra e vedi le mie foto
          </button>
        )}

        <p className="accesso__nota">
          Se sei al banco dell'evento, mostra questa schermata a chi ti assiste: con l'e-mail
          con cui ti sei registrato possono farti entrare subito.
        </p>
      </div>
    </Screen>
  );
}
