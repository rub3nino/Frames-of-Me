import { useState } from "react";
import { Testa } from "../guscio";
import { Callout, Primario, usaAvvisi } from "../parti";
import { Ico } from "../icone";
import { invia, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { emailValida } from "../lib/formato";

/**
 * Accessi dello staff.
 *
 * Due strade, e non sono equivalenti:
 *
 *  - le CREDENZIALI (indirizzo e password) sono la strada normale per un
 *    fotografo o un amministratore che lavorerà per giorni;
 *  - il LINK UNA TANTUM serve quando qualcuno è davanti a te e deve entrare
 *    adesso. Non viene spedito da nessuna parte: lo consegni tu, e per questo
 *    la console lo mostra una volta sola.
 *
 * Non c'è l'elenco degli account dello staff perché non c'è una rotta che lo
 * legga, e una tabella di nomi inventati in una console che si usa per
 * lavorare è peggio di una tabella che non c'è: insegna un fatto falso. Lo
 * dice l'avviso in fondo, con il nome della rotta che manca.
 */

const RUOLI: { valore: string; nome: string }[] = [
  { valore: "photographer", nome: "Fotografo" },
  { valore: "admin", nome: "Amministratore" },
  { valore: "participant", nome: "Partecipante" },
];

export default function Accessi() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  // Credenziali
  const [email, setEmail] = useState("");
  const [ruolo, setRuolo] = useState("photographer");
  const [password, setPassword] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erroreCred, setErroreCred] = useState("");
  const [fatto, setFatto] = useState("");

  // Link una tantum
  const [emailLink, setEmailLink] = useState("");
  const [ruoloLink, setRuoloLink] = useState("photographer");
  const [generando, setGenerando] = useState(false);
  const [erroreLink, setErroreLink] = useState("");
  const [url, setUrl] = useState("");
  const [copiato, setCopiato] = useState(false);

  function generaPassword() {
    // Alfabeto senza lettere e cifre che si confondono: questa password viene
    // letta a voce o copiata a mano da un foglio.
    const alfabeto = "abcdefghjkmnpqrstuvwxyz23456789";
    const buffer = new Uint32Array(14);
    crypto.getRandomValues(buffer);
    let s = "";
    for (const n of buffer) s += alfabeto[n % alfabeto.length];
    setPassword(s);
  }

  async function creaCredenziali(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValida(email) || password.length < 8 || salvando) return;
    setSalvando(true);
    setErroreCred("");
    setFatto("");
    try {
      await invia("/admin/staff", {
        email: email.trim().toLowerCase(),
        role: ruolo,
        password,
        ...(ruolo === "photographer" && evento ? { eventId: evento.id } : {}),
      });
      setFatto(`${email.trim().toLowerCase()} entra con questa password come ${RUOLI.find((r) => r.valore === ruolo)?.nome.toLowerCase()}.`);
      avvisa("Credenziali salvate.", "success", "Consegna indirizzo e password alla persona.");
    } catch (err: unknown) {
      if (guardia(err)) return;
      setErroreCred(
        stato(err) === 400
          ? "Dati rifiutati: la password deve avere almeno otto caratteri."
          : messaggio(err, "Non riusciamo a salvare le credenziali."),
      );
    } finally { setSalvando(false); }
  }

  async function generaLink(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValida(emailLink) || generando) return;
    setGenerando(true);
    setErroreLink("");
    setUrl("");
    setCopiato(false);
    try {
      const d = await invia<{ url: string }>("/admin/magic-links", {
        email: emailLink.trim().toLowerCase(),
        role: ruoloLink,
      });
      setUrl(d.url);
    } catch (err: unknown) {
      if (guardia(err)) return;
      setErroreLink(messaggio(err, "Non riusciamo a generare il link."));
    } finally { setGenerando(false); }
  }

  async function copia() {
    try {
      await navigator.clipboard?.writeText(url);
      setCopiato(true);
      avvisa("Link copiato.", "success");
    } catch {
      avvisa("Il browser non ci lascia copiare: selezionalo a mano.", "error");
    }
  }

  return (
    <>
      <Testa
        titolo="Accessi dello staff"
        dek="Credenziali per chi lavora per giorni, link una tantum per chi è davanti a te adesso."
      />

      <div className="grid-2">
        <div className="box">
          <div className="box__head">Credenziali con password</div>
          <div className="box__body">
            <form onSubmit={(e) => void creaCredenziali(e)}>
              <p className="motivo" style={{ marginBottom: "var(--space-4)" }}>
                La persona entra dalla sua area con indirizzo e password. Se l'indirizzo esiste già,
                la password viene sostituita.
              </p>

              <div className="field">
                <label className="field__label" htmlFor="cred-email">Indirizzo</label>
                <input id="cred-email" className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@studio.it" />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="cred-ruolo">Ruolo</label>
                <select id="cred-ruolo" className="select" value={ruolo} onChange={(e) => setRuolo(e.target.value)}>
                  {RUOLI.filter((r) => r.valore !== "participant").map((r) => (
                    <option key={r.valore} value={r.valore}>{r.nome}</option>
                  ))}
                </select>
                <span className="field__hint">
                  {ruolo === "photographer"
                    ? evento
                      ? `Viene abilitato sull'evento scelto in alto: ${evento.name}.`
                      : "Senza un evento scelto in alto il fotografo non viene abilitato su nessun evento."
                    : "Un amministratore vede e cambia tutto, su tutti gli eventi."}
                </span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="cred-password">Password</label>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <input
                    id="cred-password"
                    className="input mono"
                    type="text"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="almeno otto caratteri"
                    aria-describedby="cred-password-aiuto"
                  />
                  <button className="btn" type="button" onClick={generaPassword}>Genera</button>
                </div>
                <span className="field__hint" id="cred-password-aiuto">
                  Si vede in chiaro perché va consegnata a voce o copiata: nasconderla a chi la sta
                  creando non protegge nessuno.
                </span>
              </div>

              {erroreCred && <div style={{ marginBottom: "var(--space-4)" }}><Callout genere="errore" ruolo="alert">{erroreCred}</Callout></div>}
              {fatto && <div style={{ marginBottom: "var(--space-4)" }}><Callout genere="ok" ruolo="status">{fatto}</Callout></div>}

              <Primario
                type="submit"
                attesa={salvando}
                disabled={!emailValida(email) || password.length < 8}
                perche={!emailValida(email) ? "Serve un indirizzo valido." : "La password deve avere almeno otto caratteri."}
              >
                Crea le credenziali
              </Primario>
            </form>
          </div>
        </div>

        <div className="box">
          <div className="box__head">Link una tantum</div>
          <div className="box__body">
            <form onSubmit={(e) => void generaLink(e)}>
              <p className="motivo" style={{ marginBottom: "var(--space-4)" }}>
                Vale una volta e non viene spedito: lo consegni tu. È la riserva del giorno
                dell'evento, quando l'e-mail non arriva o la password è stata dimenticata.
              </p>

              <div className="field">
                <label className="field__label" htmlFor="link-email">Indirizzo</label>
                <input id="link-email" className="input" type="email" autoComplete="off" value={emailLink} onChange={(e) => setEmailLink(e.target.value)} placeholder="nome@email.it" />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="link-ruolo">Ruolo</label>
                <select id="link-ruolo" className="select" value={ruoloLink} onChange={(e) => setRuoloLink(e.target.value)}>
                  {RUOLI.map((r) => <option key={r.valore} value={r.valore}>{r.nome}</option>)}
                </select>
              </div>

              {erroreLink && <div style={{ marginBottom: "var(--space-4)" }}><Callout genere="errore" ruolo="alert">{erroreLink}</Callout></div>}

              <button className="btn" type="submit" disabled={!emailValida(emailLink) || generando} title={emailValida(emailLink) ? undefined : "Serve un indirizzo valido"}>
                {generando && <span className="btn-spin" aria-hidden="true" />}
                Genera il link
              </button>

              {url && (
                <>
                  <hr />
                  <div className="field">
                    <label className="field__label" htmlFor="link-url">Link generato</label>
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <input id="link-url" className="input mono" style={{ fontSize: "var(--text-xs)" }} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                      <button className="btn" type="button" onClick={() => void copia()} aria-label="Copia il link di accesso">
                        {Ico.copia}
                        {copiato ? "Copiato" : "Copia"}
                      </button>
                    </div>
                    <span className="field__hint">
                      Vale una volta sola. Dopo averlo consegnato, chiudi questa schermata: resta
                      scritto qui finché non ricarichi.
                    </span>
                  </div>
                </>
              )}
            </form>
          </div>
        </div>
      </div>

      <div className="sezione">
        <Callout genere="info">
          <strong>Non c'è l'elenco dello staff.</strong> Nessuna rotta lo legge
          (<span className="mono">GET /v1/admin/staff</span> non esiste), e una tabella di nomi
          inventati in una console di lavoro insegnerebbe un fatto falso. Per sapere chi carica su
          un album, guarda «Album»: lì l'elenco è vero.
        </Callout>
      </div>
    </>
  );
}
