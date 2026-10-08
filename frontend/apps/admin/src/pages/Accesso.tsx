import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Marchio } from "../icone";
import { Callout, Primario } from "../parti";
import { api, messaggio, stato } from "../lib/api";
import { emailValida } from "../lib/formato";

/**
 * Accesso alla console.
 *
 * È l'unica schermata senza guscio: non c'è ancora un lavoro da mostrare, e
 * una barra laterale con sei sezioni che non si possono aprire sarebbe
 * arredamento.
 *
 * Un solo primario, in inchiostro: «Entra». Il link via e-mail è la riserva
 * del giorno dell'evento e sta sotto, come una frase, non come un secondo
 * pulsante che si fa concorrenza col primo.
 *
 * L'errore dice cosa correggere: «indirizzo o password non corretti» quando
 * sono le credenziali, e un'altra frase quando è la rete — sono due rimedi
 * diversi e dirli con la stessa parola fa riprovare la password a chi invece
 * ha un problema di connessione.
 */

type Modo = "credenziali" | "link";

export default function Accesso() {
  const nav = useNavigate();
  const [modo, setModo] = useState<Modo>("credenziali");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");
  const [campo, setCampo] = useState<"email" | "password" | "">("");
  const [spedito, setSpedito] = useState(false);

  async function entra(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValida(email) || !password || inCorso) return;
    setInCorso(true);
    setErrore("");
    setCampo("");
    try {
      try { sessionStorage.setItem("rephoto.email", email.trim()); } catch { /* sessione non scrivibile */ }
      await api.login(email.trim(), password, "admin");
      nav("/admin");
    } catch (err: unknown) {
      const s = stato(err);
      if (s === 401) {
        setCampo("password");
        setErrore("Indirizzo o password non corretti. Se non ricordi la password, chiedi a un altro amministratore di rigenerarla da «Accessi dello staff».");
      } else if (s === 403) {
        setCampo("email");
        setErrore("Questo indirizzo non è abilitato come staff: serve un account amministratore.");
      } else if (s === 429) {
        setErrore("Troppi tentativi da questa rete. Aspetta qualche minuto: il blocco si sblocca da sé.");
      } else {
        setErrore(messaggio(err, "L'accesso non è riuscito e non è colpa della password: la console non ha raggiunto l'api."));
      }
    } finally { setInCorso(false); }
  }

  async function chiediLink(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValida(email) || inCorso) return;
    setInCorso(true);
    setErrore("");
    try {
      try { sessionStorage.setItem("rephoto.email", email.trim()); } catch { /* sessione non scrivibile */ }
      await api.requestLink(email.trim(), "admin");
      setSpedito(true);
    } catch (err: unknown) {
      setErrore(
        stato(err) === 400
          ? "Questo indirizzo non è abilitato come staff."
          : messaggio(err, "Non riusciamo a inviare il link."),
      );
    } finally { setInCorso(false); }
  }

  return (
    <div className="accesso-pagina">
      <div className="accesso-modulo">
        <div className="accesso-modulo__testa">
          <Marchio />
          Frames of Me
        </div>

        {spedito ? (
          <>
            <div>
              <h1>Guarda la posta</h1>
              <p className="accesso-modulo__dek">
                Abbiamo mandato un link a <strong>{email.trim()}</strong>. Vale una volta e scade.
              </p>
            </div>
            <button className="btn" type="button" onClick={() => { setSpedito(false); setModo("credenziali"); }}>
              Torna alla password
            </button>
          </>
        ) : modo === "credenziali" ? (
          <form className="pila" onSubmit={(e) => void entra(e)} noValidate>
            <div>
              <h1>Console di servizio</h1>
              <p className="accesso-modulo__dek">Da qui si governa l'evento: album, codici, moderazione, dati delle persone.</p>
            </div>

            {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

            <div className="field">
              <label className="field__label" htmlFor="accesso-email">Indirizzo</label>
              <input
                id="accesso-email"
                className="input"
                type="email"
                autoComplete="username"
                value={email}
                aria-invalid={campo === "email" || undefined}
                onChange={(e) => { setEmail(e.target.value); setCampo(""); }}
                placeholder="nome@bakertilly.it"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="accesso-password">Password</label>
              <input
                id="accesso-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={campo === "password" || undefined}
                onChange={(e) => { setPassword(e.target.value); setCampo(""); }}
              />
            </div>

            <Primario
              type="submit"
              blocco
              attesa={inCorso}
              disabled={!emailValida(email) || password.length === 0}
              perche={!emailValida(email) ? "Scrivi il tuo indirizzo di lavoro." : "Scrivi la password."}
            >
              Entra nella console
            </Primario>

            <p className="accesso-modulo__nota">
              Non hai la password?{" "}
              <button className="btn btn--link" type="button" onClick={() => { setModo("link"); setErrore(""); }}>
                Fatti mandare un link via e-mail
              </button>
            </p>
          </form>
        ) : (
          <form className="pila" onSubmit={(e) => void chiediLink(e)} noValidate>
            <div>
              <h1>Link via e-mail</h1>
              <p className="accesso-modulo__dek">Ti mandiamo un link che vale una volta. Serve solo se la password non c'è o non funziona.</p>
            </div>

            {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

            <div className="field">
              <label className="field__label" htmlFor="accesso-email-link">Indirizzo</label>
              <input
                id="accesso-email-link"
                className="input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@bakertilly.it"
              />
            </div>

            <Primario
              type="submit"
              blocco
              attesa={inCorso}
              disabled={!emailValida(email)}
              perche="Scrivi il tuo indirizzo di lavoro."
            >
              Mandami il link
            </Primario>

            <p className="accesso-modulo__nota">
              <button className="btn btn--link" type="button" onClick={() => { setModo("credenziali"); setErrore(""); }}>
                Torna alla password
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
