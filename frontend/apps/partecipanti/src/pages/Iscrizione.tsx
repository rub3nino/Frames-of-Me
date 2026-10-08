import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen, isEmail } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

/**
 * Accesso. Lineare: prima Google, e solo se serve e-mail e password.
 *
 * Tre regole del design system governano questa pagina, e sono il motivo per
 * cui non assomiglia a un modulo di iscrizione qualunque:
 *
 * 1. Un solo primario per schermata, in INCHIOSTRO. Quindi il pulsante
 *    Google non è blu e non è primario: è un secondario con il suo marchio.
 *    Il blu qui compare solo sul fuoco e sui link.
 * 2. Nessuno stato è solo colore. La scelta dell'età è una parola, non una
 *    tinta; l'errore dice cosa correggere, non «campo non valido».
 * 3. Niente componenti inventati. Le due opzioni di età non sono un
 *    `.segmented` (quello è per parole brevi su una riga): sono un gruppo di
 *    radio costruito con `.box`, `.check` e lo spazio, che esistono già.
 *
 * Il magic link resta nell'API come riserva del giorno evento, ma non è in
 * questa pagina: con 6.000 registrazioni in un giorno l'e-mail non sta nel
 * percorso principale.
 */

const CONSENSO_VERSIONE = "2026-10-08";

type Eta = "" | "adulto" | "minore";
type Modo = "scelta" | "credenziali";

export default function Iscrizione() {
  const nav = useNavigate();
  const [eta, setEta] = useState<Eta>("");
  const [modo, setModo] = useState<Modo>("scelta");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [codice, setCodice] = useState("");
  const [consenso, setConsenso] = useState(false);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");
  const [erroreCampo, setErroreCampo] = useState<"email" | "password" | "codice" | "">("");

  const etaScelta = eta !== "";
  const prontoCredenziali =
    etaScelta && isEmail(email) && password.length >= 10 && codice.trim().length > 0 && consenso;

  function minorenne() {
    sessionStorage.setItem("fom.email", email.trim());
    nav("/consenso-genitore");
  }

  function conGoogle() {
    if (!etaScelta) {
      setErrore("Dicci prima la tua età: se hai meno di 18 anni serve il consenso di un genitore.");
      return;
    }
    if (eta === "minore") return minorenne();
    // Navigazione di pagina intera: l'endpoint risponde 302 e il cookie di
    // stato va posato su una richiesta di documento vera, non su una fetch.
    window.location.assign(api.googleStartUrl());
  }

  async function conCredenziali(e: React.FormEvent) {
    e.preventDefault();
    if (!prontoCredenziali || inCorso) return;
    if (eta === "minore") return minorenne();
    setErrore("");
    setErroreCampo("");
    setInCorso(true);
    try {
      await api.register(email.trim(), password, codice.trim());
      await api.giveConsent(EVENT_SLUG, CONSENSO_VERSIONE, true);
      nav("/selfie");
    } catch (err: any) {
      const stato = err?.status;
      if (stato === 409) {
        setErroreCampo("email");
        setErrore("Questa e-mail è già registrata. Entra con la password che hai scelto.");
        setModo("credenziali");
      } else if (stato === 403) {
        setErroreCampo("codice");
        setErrore("Il codice non è valido o è già stato usato. Controllalo sul badge.");
      } else if (stato === 429) {
        setErrore("Troppi tentativi da questa rete. Riprova tra qualche minuto.");
      } else {
        setErrore("Non è stato possibile completare l'accesso. Riprova.");
      }
    } finally {
      setInCorso(false);
    }
  }

  async function entra(e: React.FormEvent) {
    e.preventDefault();
    if (inCorso || !isEmail(email) || !password) return;
    setErrore("");
    setInCorso(true);
    try {
      await api.login(email.trim(), password, "participant");
      nav("/selfie");
    } catch {
      setErroreCampo("password");
      setErrore("E-mail o password non corrette.");
    } finally {
      setInCorso(false);
    }
  }

  return (
    <Screen center>
      <div className="accesso">
        <header className="accesso__testa">
          <h1 className="accesso__titolo">Trova le tue foto</h1>
          <p className="accesso__dek">
            Fai un selfie e ricevi solo le foto in cui compari. Il file del selfie si cancella
            subito dopo la ricerca.
          </p>
        </header>

        {/* L'età è un cancello legale, non una preferenza: sotto i 18 serve il
            consenso di un genitore, e il percorso cambia. Per questo è la
            prima cosa e non un dettaglio in fondo. */}
        <fieldset className="accesso__eta box">
          <legend className="accesso__eta-legenda">La tua età</legend>
          <label className="accesso__opzione">
            <span className="check">
              <input
                type="radio"
                name="eta"
                checked={eta === "adulto"}
                onChange={() => { setEta("adulto"); setErrore(""); }}
              />
            </span>
            <span className="accesso__opzione-testo">Ho 18 anni o più</span>
          </label>
          <label className="accesso__opzione">
            <span className="check">
              <input
                type="radio"
                name="eta"
                checked={eta === "minore"}
                onChange={() => { setEta("minore"); setErrore(""); }}
              />
            </span>
            <span className="accesso__opzione-testo">
              Ho tra 14 e 17 anni
              <span className="cell-sub">Serve il consenso di un genitore o di chi ti tutela</span>
            </span>
          </label>
        </fieldset>

        {eta === "minore" && (
          <div className="callout callout--info" role="status">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
            </svg>
            <span className="callout__text">
              Al passo successivo chiediamo a un genitore di confermare. Senza quella conferma
              non cerchiamo il tuo volto.
            </span>
          </div>
        )}

        {errore && (
          <div className="callout callout--errore" role="alert">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
              <path d="M10.3 3.9 2.4 17.1A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <span className="callout__text">{errore}</span>
          </div>
        )}

        {/* Google è un secondario: il blu non colora un'azione, e l'unico
            primario di questa schermata è «Continua». */}
        <button className="btn btn--block accesso__google" type="button" onClick={conGoogle}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M23 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h6.2a5.4 5.4 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.5Z" />
            <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.8-2.9l-3.7-2.9c-1 .7-2.4 1.1-4.1 1.1-3.1 0-5.8-2.1-6.8-5H1.4v3C3.4 21.3 7.4 24 12 24Z" />
            <path fill="#FBBC05" d="M5.2 14.3a7.2 7.2 0 0 1 0-4.6V6.8H1.4a12 12 0 0 0 0 10.4l3.8-2.9Z" />
            <path fill="#EA4335" d="M12 4.7c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.8l3.8 2.9c1-2.9 3.7-5 6.8-5Z" />
          </svg>
          Accedi con Google
        </button>

        {modo === "scelta" ? (
          <p className="accesso__alt">
            Non hai un account Google?{" "}
            <button className="btn btn--link" type="button" onClick={() => setModo("credenziali")}>
              Usa e-mail e password
            </button>
          </p>
        ) : (
          <form className="accesso__modulo" onSubmit={conCredenziali} noValidate>
            <div className="accesso__sep" role="presentation" />

            <div className="field">
              <label className="field__label" htmlFor="email">La tua e-mail</label>
              <input
                id="email"
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="nome@esempio.it"
                value={email}
                aria-invalid={erroreCampo === "email" || undefined}
                onChange={(e) => { setEmail(e.target.value); setErroreCampo(""); }}
              />
              {erroreCampo === "email" && (
                <span className="field__error">Controlla l'indirizzo: manca la @ o il dominio.</span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="password">Scegli una password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                aria-invalid={erroreCampo === "password" || undefined}
                aria-describedby="password-aiuto"
                onChange={(e) => { setPassword(e.target.value); setErroreCampo(""); }}
              />
              <span className="field__hint" id="password-aiuto">Almeno 10 caratteri.</span>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="codice">Codice dell'evento</label>
              <input
                id="codice"
                className="input"
                inputMode="text"
                autoCapitalize="characters"
                placeholder="ABCD-EFGH"
                value={codice}
                aria-invalid={erroreCampo === "codice" || undefined}
                aria-describedby="codice-aiuto"
                onChange={(e) => { setCodice(e.target.value.toUpperCase()); setErroreCampo(""); }}
              />
              <span className="field__hint" id="codice-aiuto">
                È sul tuo badge, sotto il QR.
              </span>
            </div>

            <label className="check accesso__consenso">
              <input
                type="checkbox"
                checked={consenso}
                onChange={(e) => setConsenso(e.target.checked)}
              />
              <span>
                Acconsento al riconoscimento del mio volto nelle foto dell'evento, per ricevere
                le mie foto. Posso revocarlo in qualsiasi momento da «I miei dati».
              </span>
            </label>

            {/* L'unico primario della schermata, e dice verbo + oggetto. */}
            <button
              className="btn btn--primary btn--block"
              type="submit"
              disabled={!prontoCredenziali || inCorso}
              data-loading={inCorso || undefined}
              title={
                !etaScelta ? "Dicci prima la tua età"
                : !consenso ? "Serve il consenso per cercare il tuo volto"
                : undefined
              }
            >
              {inCorso && <span className="btn-spin" aria-hidden="true" />}
              {eta === "minore" ? "Continua: consenso del genitore" : "Continua: fai il selfie"}
            </button>

            <p className="accesso__alt">
              Hai già un account?{" "}
              <button className="btn btn--link" type="button" onClick={entra}>
                Entra
              </button>
            </p>
          </form>
        )}

        <p className="accesso__nota">
          Conferenza 2026 · 12–14 marzo. Le foto in cui compari restano tue: puoi togliere una
          foto sbagliata e revocare il consenso quando vuoi.
        </p>
      </div>
    </Screen>
  );
}
