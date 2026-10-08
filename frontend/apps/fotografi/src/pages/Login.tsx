import { useState } from "react";
import { useNavigate } from "react-router-dom";
// @ts-ignore plain module
import { createClient } from "@api";
import { Accesso, Mark, Spin, IconAvviso, IconOk, isEmail } from "../ui";

const api = createClient();

/**
 * Accesso del fotografo. Stessa costruzione della pagina dei partecipanti, con
 * la differenza che qui non si registra nessuno: le credenziali arrivano dallo
 * staff, e l'invito è un link via e-mail.
 *
 * Le regole che danno forma alla pagina:
 *
 * 1. Un solo primario per schermata, in INCHIOSTRO. «Accedi» è quello. Il
 *    link via e-mail è un secondario, non un secondo nero e non un blu: il
 *    blu qui compare solo sul fuoco e sui link. Google NON è offerto ai
 *    fotografi — l'endpoint OAuth accede come partecipante — e un pulsante
 *    che porta al ruolo sbagliato è peggio di un pulsante assente. Se un
 *    giorno ci sarà, sarà un secondario con il suo marchio, come nella
 *    pagina dei partecipanti.
 * 2. Nessuno stato è solo colore: l'errore dice cosa correggere, e il
 *    «controlla la posta» è una parola con la sua forma, non una tinta.
 * 3. Un primario disabilitato dice perché: la riga sotto il pulsante nomina
 *    quello che manca, e non è solo un `title` che il dito non vede.
 * 4. L'attesa sta DENTRO il pulsante che l'ha iniziata. Nessuna rotella a
 *    tutto schermo, nessun velo.
 */
export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");
  const [erroreCampo, setErroreCampo] = useState<"email" | "password" | "">("");
  // Riserva: l'invito dello staff arriva come link via e-mail.
  const [modo, setModo] = useState<"credenziali" | "link">("credenziali");
  const [inviato, setInviato] = useState(false);

  const emailOk = isEmail(email);
  const pronto = emailOk && password.length > 0;
  const motivoDisabilitato = !emailOk
    ? "Scrivi l'indirizzo con cui lo staff ti ha abilitato."
    : !password
      ? "Serve anche la password che ti ha dato lo staff."
      : "";

  async function entra(e: React.FormEvent) {
    e.preventDefault();
    if (!pronto || inCorso) return;
    setErrore(""); setErroreCampo(""); setInCorso(true);
    try {
      sessionStorage.setItem("rephoto.email", email.trim());
      await api.login(email.trim(), password, "photographer");
      nav("/upload");
    } catch (err: any) {
      const stato = err?.status;
      if (stato === 401) {
        setErroreCampo("password");
        setErrore("E-mail o password non corrette. Se non hai mai impostato una password, chiedi un link di accesso.");
      } else if (stato === 403) {
        setErroreCampo("email");
        setErrore("Questo indirizzo non è abilitato come fotografo. Chiedi un invito allo staff dell'evento.");
      } else if (stato === 429) {
        setErrore("Troppi tentativi da questa rete. Riprova tra qualche minuto.");
      } else {
        setErrore("Non è stato possibile completare l'accesso. Riprova.");
      }
    } finally {
      setInCorso(false);
    }
  }

  async function inviaLink(e: React.FormEvent) {
    e.preventDefault();
    if (!emailOk || inCorso) return;
    setErrore(""); setErroreCampo(""); setInCorso(true);
    try {
      sessionStorage.setItem("rephoto.email", email.trim());
      await api.requestLink(email.trim(), "photographer");
      setInviato(true);
    } catch (err: any) {
      if (err?.status === 400 || err?.status === 403) {
        setErroreCampo("email");
        setErrore("Questo indirizzo non è abilitato come fotografo. Chiedi un invito allo staff dell'evento.");
      } else {
        setErrore("Non riusciamo a inviare il link. Riprova tra poco.");
      }
    } finally {
      setInCorso(false);
    }
  }

  if (inviato) {
    return (
      <Accesso>
        <div className="accesso__marchio"><Mark /> Frames of Me</div>
        <h1 className="accesso__titolo">Controlla la posta</h1>
        <p className="accesso__dek">
          Abbiamo inviato un link di accesso a <b>{email.trim()}</b>. Vale 15 minuti e si usa una
          volta sola.
        </p>
        <div className="callout callout--ok" role="status">
          <IconOk />
          <span className="callout__text">
            Apri il link su questo computer: è da qui che carichi le foto.
          </span>
        </div>
        <p className="accesso__alt">
          Non è arrivato?{" "}
          <button className="btn btn--link" type="button" onClick={() => { setInviato(false); setModo("link"); }}>
            Richiedi un altro link
          </button>
        </p>
      </Accesso>
    );
  }

  const linkMode = modo === "link";

  return (
    <Accesso>
      <div className="accesso__marchio"><Mark /> Frames of Me</div>

      <header>
        <h1 className="accesso__titolo">{linkMode ? "Link di accesso" : "Accedi come fotografo"}</h1>
        <p className="accesso__dek">
          {linkMode
            ? "Ti inviamo un link via e-mail, senza password. Serve che il tuo indirizzo sia già abilitato sull'evento."
            : "Usa l'e-mail e la password che ti ha dato lo staff dell'evento."}
        </p>
      </header>

      {errore && (
        <div className="callout callout--errore" role="alert">
          <IconAvviso />
          <span className="callout__text">{errore}</span>
        </div>
      )}

      <form className="accesso__modulo" onSubmit={linkMode ? inviaLink : entra} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="email">La tua e-mail</label>
          <input
            id="email"
            className="input"
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="nome@studio.it"
            value={email}
            aria-invalid={erroreCampo === "email" || undefined}
            onChange={(e) => { setEmail(e.target.value); setErroreCampo(""); }}
          />
          {erroreCampo === "email" && (
            <span className="field__error">Controlla l'indirizzo: manca la @ o il dominio.</span>
          )}
        </div>

        {!linkMode && (
          <div className="field">
            <label className="field__label" htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={erroreCampo === "password" || undefined}
              onChange={(e) => { setPassword(e.target.value); setErroreCampo(""); }}
            />
          </div>
        )}

        {/* L'unico primario della schermata. L'etichetta è verbo + oggetto, e
            l'attesa gira dentro questo pulsante. */}
        <div className="field">
          <button
            className="btn btn--primary btn--block"
            type="submit"
            disabled={linkMode ? !emailOk || inCorso : !pronto || inCorso}
            data-loading={inCorso || undefined}
            aria-describedby="perche-disabilitato"
            title={linkMode ? (emailOk ? undefined : "Scrivi prima la tua e-mail") : motivoDisabilitato || undefined}
          >
            {inCorso && <Spin />}
            {linkMode ? "Inviami il link di accesso" : "Accedi e carica le foto"}
          </button>
          {/* Un primario disabilitato dice perché, scritto, non solo nel title. */}
          <span className="field__hint" id="perche-disabilitato">
            {linkMode
              ? (emailOk ? "Il link arriva in pochi secondi." : "Scrivi l'indirizzo abilitato dallo staff.")
              : (motivoDisabilitato || "Dopo l'accesso si apre il Caricamento.")}
          </span>
        </div>

        <div className="accesso__sep" role="presentation" />

        {linkMode ? (
          <p className="accesso__alt">
            Hai una password?{" "}
            <button className="btn btn--link" type="button" onClick={() => { setModo("credenziali"); setErrore(""); setErroreCampo(""); }}>
              Accedi con le credenziali
            </button>
          </p>
        ) : (
          <>
            {/* Secondario: ha il suo peso, non un secondo nero. */}
            <button
              className="btn btn--block"
              type="button"
              onClick={() => { setModo("link"); setErrore(""); setErroreCampo(""); }}
            >
              Accedi con un link via e-mail
            </button>
            <p className="accesso__alt">
              Non hai ancora le credenziali? Chiedi allo staff di invitarti: l'invito arriva come
              link via e-mail.
            </p>
          </>
        )}
      </form>

      <p className="accesso__nota">
        Le foto che carichi restano dell'evento. Ogni caricamento resta tracciato con il tuo nome:
        è così che si capisce chi ha coperto cosa.
      </p>
    </Accesso>
  );
}
