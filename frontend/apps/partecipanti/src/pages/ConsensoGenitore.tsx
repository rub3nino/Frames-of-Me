import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Screen, Callout, isEmail } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

/**
 * Consenso di chi ha la responsabilità genitoriale, per un partecipante di
 * 14–17 anni. È l'unica schermata del flusso dove sbagliare ha un peso
 * legale, e per questo è costruita al contrario delle altre: non si tratta di
 * far passare una persona in fretta, ma di dire con precisione che cosa si
 * autorizza, che si può ritirare, e che senza questa conferma non cerchiamo
 * quel volto da nessuna parte.
 *
 * Tre decisioni che si vedono, e perché:
 *
 * 1. L'ACCESSO DEL MINORE SI CREA QUI, dopo la conferma, non prima. La
 *    pagina di accesso manda qui chiunque dichiari 14–17 anni senza
 *    registrarlo, e l'ordine è quello giusto: prima l'autorizzazione, poi
 *    l'account che può chiedere una ricerca biometrica.
 * 2. Un solo primario, in inchiostro, e disabilitato DICE PERCHÉ (`title`).
 *    Il consenso è un atto: non si dà premendo un pulsante che non si sa
 *    cosa gli manca.
 * 3. Il rapporto con il minore è un `.select`, non un `.segmented`: quattro
 *    voci di cui una è «Tutore legale», e su un telefono non stanno su una
 *    riga. Le due dichiarazioni sono `.check`, non interruttori: restano
 *    nella frase e non accendono una modalità.
 *
 * GAP DI BACKEND, dichiarato e non nascosto: in CONTRACTS.md non esiste una
 * rotta per il consenso del genitore (es. `POST /v1/consents/guardian`), e il
 * corpo di `POST /v1/events/:slug/consent` accetta solo `{ textVersion,
 * accepted }`. Quindi i nomi e il rapporto NON raggiungono il server: restano
 * in questa sessione del browser. Quello che il server registra è una riga di
 * consenso con una `textVersion` sua — `2026-10-08-genitore` — che distingue
 * per sempre un consenso dato da un genitore da uno dato da un adulto per sé.
 * Finché la rotta non esiste, il cancello è lato client e la pagina del selfie
 * lo fa rispettare: senza il segno in sessione non si cerca quel volto.
 */

const CONSENSO_VERSIONE = "2026-10-08-genitore";

type Rapporto = "" | "madre" | "padre" | "tutore" | "altro";
type Campo = "email" | "password" | "codice" | "";

export default function ConsensoGenitore() {
  const nav = useNavigate();
  const [genitore, setGenitore] = useState("");
  const [rapporto, setRapporto] = useState<Rapporto>("");
  const [minore, setMinore] = useState("");
  const [d1, setD1] = useState(false);
  const [d2, setD2] = useState(false);
  const [email, setEmail] = useState(() => sessionStorage.getItem("fom.email") || "");
  const [password, setPassword] = useState("");
  const [codice, setCodice] = useState("");
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");
  const [erroreCampo, setErroreCampo] = useState<Campo>("");

  const dichiarato = genitore.trim().length > 1 && rapporto !== "" && minore.trim().length > 1 && d1 && d2;
  const accesso = isEmail(email) && password.length >= 10 && codice.trim().length > 0;
  const pronto = dichiarato && accesso;

  /* Il motivo per cui il primario non si può premere, in parole. Un primario
     disabilitato che tace è un vicolo cieco. */
  const perche =
    !genitore.trim() ? "Scrivi il tuo nome e cognome"
    : rapporto === "" ? "Dicci il tuo rapporto con il minore"
    : !minore.trim() ? "Scrivi il nome del minore"
    : !d1 || !d2 ? "Spunta le due dichiarazioni"
    : !isEmail(email) ? "Controlla l'e-mail del minore"
    : password.length < 10 ? "La password deve avere almeno 10 caratteri"
    : !codice.trim() ? "Serve il codice dell'evento, sul badge"
    : undefined;

  async function conferma(e: React.FormEvent) {
    e.preventDefault();
    if (!pronto || inCorso) return;
    setErrore("");
    setErroreCampo("");
    setInCorso(true);
    try {
      await api.register(email.trim(), password, codice.trim());
      await api.giveConsent(EVENT_SLUG, CONSENSO_VERSIONE, true);
      /* Il cancello che la pagina del selfie fa rispettare. Resta in questa
         sessione perché il server non ha ancora dove metterlo. */
      sessionStorage.setItem("fom.email", email.trim());
      sessionStorage.setItem("fom.minore", "1");
      sessionStorage.setItem(
        "fom.consenso-genitore",
        JSON.stringify({
          versione: CONSENSO_VERSIONE,
          genitore: genitore.trim(),
          rapporto,
          minore: minore.trim(),
          quando: new Date().toISOString(),
        }),
      );
      nav("/selfie");
    } catch (err: any) {
      const stato = err?.status;
      if (stato === 409) {
        setErroreCampo("email");
        setErrore("Questa e-mail ha già un accesso. Entra dalla pagina di accesso con la password scelta allora.");
      } else if (stato === 403) {
        setErroreCampo("codice");
        setErrore("Il codice non è valido o è già stato usato. Controllalo sul badge del minore, sotto il QR.");
      } else if (stato === 429) {
        setErrore("Troppi tentativi da questa rete. Riprova tra qualche minuto.");
      } else {
        setErrore("Non è stato possibile registrare il consenso. Riprova; se continua, chiedi al banco dell'evento.");
      }
    } finally {
      setInCorso(false);
    }
  }

  return (
    <Screen>
      <form className="colonna" onSubmit={conferma} noValidate>
        <header className="gruppo">
          <h1 className="titolo">Consenso di un genitore</h1>
          <p className="dek">Per un partecipante di 14–17 anni. Conferenza 2026 · 12–14 marzo.</p>
        </header>

        {/* Che cosa si autorizza, in italiano e per intero. Non è un rimando a
            un'informativa: è la frase. */}
        <p className="prosa">
          Stai autorizzando, come <b>genitore o tutore</b>, che il selfie del minore venga
          confrontato con le foto di questo evento per trovare gli scatti in cui compare e
          mostrare solo quelli a lui. Il volto è un <b>dato biometrico</b> (art. 9 GDPR) e per
          un minore di 18 anni serve il consenso di chi ne ha la responsabilità (art. 8 GDPR).
        </p>
        <p className="prosa">
          Il file del selfie si cancella subito dopo la ricerca. Resta un <b>modello numerico</b> del
          volto per la durata dell'evento, solo per agganciare le foto caricate più tardi, e viene
          cancellato con le foto.
        </p>

        <Callout variante="info">
          Senza questa conferma non cerchiamo il volto del minore in nessuna foto.{" "}
          <b>Puoi revocare il consenso in qualsiasi momento</b> da «I miei dati»: dalla revoca il
          modello del volto viene cancellato e non lo cerchiamo più.
        </Callout>

        {/* --- Chi sta confermando ------------------------------------------ */}
        <div className="field">
          <label className="field__label" htmlFor="genitore">Il tuo nome e cognome</label>
          <input
            id="genitore"
            className="input"
            autoComplete="name"
            value={genitore}
            onChange={(e) => setGenitore(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="rapporto">Il tuo rapporto con il minore</label>
          <select
            id="rapporto"
            className="select"
            value={rapporto}
            onChange={(e) => setRapporto(e.target.value as Rapporto)}
          >
            <option value="">Scegli…</option>
            <option value="madre">Madre</option>
            <option value="padre">Padre</option>
            <option value="tutore">Tutore legale</option>
            <option value="altro">Altro titolare della responsabilità</option>
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="minore">Nome e cognome del minore</label>
          <input
            id="minore"
            className="input"
            value={minore}
            onChange={(e) => setMinore(e.target.value)}
          />
        </div>

        {/* Due frasi, due caselle. Il segno è blu perché il significato sta
            nelle parole: non è uno stato e non accende una modalità. */}
        <fieldset className="dichiara box">
          <legend className="legenda">Dichiarazioni</legend>
          <label className="dichiara__voce">
            <input type="checkbox" checked={d1} onChange={(e) => setD1(e.target.checked)} />
            <span>Confermo di essere il genitore o il tutore del minore indicato qui sopra.</span>
          </label>
          <label className="dichiara__voce">
            <input type="checkbox" checked={d2} onChange={(e) => setD2(e.target.checked)} />
            <span>
              Acconsento al riconoscimento del volto del minore nelle foto di questo evento, alle
              condizioni scritte sopra.
            </span>
          </label>
        </fieldset>

        <div className="filo" role="presentation" />

        {/* --- L'accesso del minore ----------------------------------------
            Si crea dopo la conferma, non prima: l'account che può chiedere una
            ricerca biometrica non nasce senza l'autorizzazione. */}
        <header className="gruppo">
          <h2 className="sottotitolo">L'accesso del minore</h2>
          <p className="dek">
            Le credenziali con cui entrerà. L'accesso viene creato solo quando confermi.
          </p>
        </header>

        <div className="field">
          <label className="field__label" htmlFor="email">E-mail del minore</label>
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
          <label className="field__label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            aria-describedby="password-aiuto"
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field__hint" id="password-aiuto">Almeno 10 caratteri.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="codice">Codice dell'evento</label>
          <input
            id="codice"
            className="input"
            autoCapitalize="characters"
            placeholder="ABCD-EFGH"
            value={codice}
            aria-invalid={erroreCampo === "codice" || undefined}
            aria-describedby="codice-aiuto"
            onChange={(e) => { setCodice(e.target.value.toUpperCase()); setErroreCampo(""); }}
          />
          <span className="field__hint" id="codice-aiuto">È sul badge del minore, sotto il QR.</span>
        </div>

        {errore && <Callout variante="errore">{errore}</Callout>}

        {/* L'unico primario della schermata. */}
        <button
          className="btn btn--primary btn--block"
          type="submit"
          disabled={!pronto || inCorso}
          data-loading={inCorso || undefined}
          title={perche}
        >
          {inCorso && <span className="btn-spin" aria-hidden="true" />}
          Confermo il consenso
        </button>
        {perche && <span className="field__hint">{perche}.</span>}

        <p className="nota">
          Dopo la conferma il minore fa il selfie. Se preferisci non dare il consenso, non fare
          nulla: senza di esso il volto non viene cercato.{" "}
          <Link to="/">Torna all'accesso</Link>
        </p>
      </form>
    </Screen>
  );
}
