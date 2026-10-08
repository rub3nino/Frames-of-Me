import { useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import { Callout, Esito, Finestra, Primario, Vuoto, usaAvvisi } from "../parti";
import { Ico } from "../icone";
import { cancella, invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { emailValida, numero, quando } from "../lib/formato";
import type { Partecipante, RevocaFatta } from "../lib/tipi";

/**
 * Partecipanti — si cerca per indirizzo e si vede cosa l'evento sa di quella
 * persona: se ha dato il consenso biometrico, se è nell'elenco, se ha una
 * galleria, se il suo selfie è ancora conservato.
 *
 * Non c'è un elenco di tutti i partecipanti, e non è una mancanza da coprire
 * con una tabella finta: con seimila iscritti un elenco sfogliabile di volti
 * e indirizzi è esattamente la cosa che non si vuole avere aperta su uno
 * schermo in sala. Si arriva qui con un indirizzo in mano, da una richiesta.
 *
 * Due azioni, e sono diverse:
 *  - la REVOCA del consenso cancella il materiale biometrico (vettore del
 *    selfie, ancore, voci di galleria che venivano da quelle ancore) e lascia
 *    l'account. È quello che chiede l'art. 7 GDPR, e la risposta dell'api
 *    dice esattamente cosa ha toccato: lo mostriamo, perché è la prova da
 *    allegare alla richiesta;
 *  - la CANCELLAZIONE toglie la persona. Le foto di gruppo scattate da altri
 *    restano, e la conferma lo dice per non lasciar credere il contrario.
 */

export default function Partecipanti() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [cerca, setCerca] = useState("");
  const [trovato, setTrovato] = useState<Partecipante | null>(null);
  const [cercando, setCercando] = useState(false);
  const [errore, setErrore] = useState("");
  const [cercato, setCercato] = useState(false);

  const [revocaAperta, setRevocaAperta] = useState(false);
  const [nota, setNota] = useState("");
  const [revocando, setRevocando] = useState(false);
  const [revocato, setRevocato] = useState<RevocaFatta | null>(null);

  const [cancellaAperta, setCancellaAperta] = useState(false);
  const [presaDatto, setPresaDatto] = useState(false);
  const [cancellando, setCancellando] = useState(false);

  const eventoId = evento?.id ?? "";

  async function trova(e: React.FormEvent) {
    e.preventDefault();
    if (!eventoId || !emailValida(cerca) || cercando) return;
    setCercando(true);
    setErrore("");
    setTrovato(null);
    setRevocato(null);
    setCercato(true);
    try {
      setTrovato(await leggi<Partecipante>(
        `/admin/participants/lookup?eventId=${eventoId}&email=${encodeURIComponent(cerca.trim().toLowerCase())}`,
      ));
    } catch (err: unknown) {
      if (guardia(err)) return;
      setErrore(
        stato(err) === 404
          ? "Nessun partecipante con questo indirizzo in questo evento. Controlla l'indirizzo, o l'evento scelto in alto."
          : messaggio(err, "Ricerca non riuscita."),
      );
    } finally { setCercando(false); }
  }

  async function revoca() {
    if (!trovato || !eventoId || revocando) return;
    setRevocando(true);
    try {
      const d = await invia<RevocaFatta>(`/admin/participants/${trovato.user.id}/consent/withdraw`, {
        eventId: eventoId,
        ...(nota.trim() === "" ? {} : { note: nota.trim() }),
      });
      setRevocato(d);
      setRevocaAperta(false);
      setNota("");
      avvisa("Consenso revocato.", "warning", "Il materiale biometrico è stato cancellato.");
      // Si rilegge: il consenso adesso è assente e la galleria non c'è più.
      try {
        setTrovato(await leggi<Partecipante>(
          `/admin/participants/lookup?eventId=${eventoId}&email=${encodeURIComponent(trovato.user.email)}`,
        ));
      } catch { /* la revoca è andata: il riepilogo sotto resta quello */ }
    } catch (e: unknown) {
      if (!guardia(e)) avvisa(messaggio(e, "Revoca non riuscita."), "error");
    } finally { setRevocando(false); }
  }

  async function cancellaPersona() {
    if (!trovato || !presaDatto || cancellando) return;
    setCancellando(true);
    try {
      await cancella(`/admin/participants/${trovato.user.id}`);
      avvisa("Partecipante cancellato.", "warning", "Account, galleria, selfie e consensi.");
      setCancellaAperta(false);
      setTrovato(null);
      setCerca("");
    } catch (e: unknown) {
      if (!guardia(e)) avvisa(messaggio(e, "Cancellazione non riuscita."), "error");
    } finally { setCancellando(false); }
  }

  if (!evento) return (<><Testa titolo="Partecipanti" /><ServeUnEvento /></>);

  return (
    <>
      <Testa
        titolo="Partecipanti"
        dek="Si cerca per indirizzo: è così che arriva una richiesta di accesso o di cancellazione."
        azioni={
          <form className="strumenti__fine" onSubmit={(e) => void trova(e)}>
            <div className="input-group">
              {Ico.cerca}
              <input
                className="input"
                style={{ minWidth: 260 }}
                type="email"
                value={cerca}
                onChange={(e) => setCerca(e.target.value)}
                placeholder="persona@email.it"
                aria-label="Indirizzo del partecipante"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Primario
              type="submit"
              attesa={cercando}
              disabled={!emailValida(cerca)}
              perche="Scrivi l'indirizzo completo: la ricerca è esatta, non per pezzi di nome."
            >
              Cerca il partecipante
            </Primario>
          </form>
        }
      />

      {errore && <Callout genere="attention" ruolo="status">{errore}</Callout>}

      {revocato && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Callout genere="ok" ruolo="status">
            <strong>Consenso revocato il {quando(revocato.withdrawnAt)}.</strong> Cancellati:{" "}
            {numero(revocato.deleted.consents)} consensi, {numero(revocato.deleted.galleryItems)} voci
            di galleria, {numero(revocato.deleted.anchors)} volti di riferimento,{" "}
            {numero(revocato.deleted.faceVectors)} vettori, {numero(revocato.deleted.selfieObjects)} file
            di selfie, {numero(revocato.deleted.feedback)} riscontri,{" "}
            {numero(revocato.deleted.matchRuns)} ricerche registrate
            {revocato.deleted.selfieVector ? ", e il vettore del selfie" : ""}
            {revocato.deleted.gallery ? ", e la galleria" : ""}. Questo elenco è la prova da allegare
            alla richiesta.
          </Callout>
        </div>
      )}

      {!trovato && !cercato && (
        <Vuoto titolo="Cerca una persona">
          Non c'è un elenco di tutti i partecipanti, ed è voluto: con seimila iscritti una lista
          sfogliabile di indirizzi e volti è la cosa che non si vuole avere aperta su uno schermo in
          sala. Si parte dall'indirizzo che la persona ha scritto nella sua richiesta.
        </Vuoto>
      )}

      {trovato && (
        <div className="box">
          <div className="box__head">{trovato.user.email}</div>
          <div className="box__body">
            <dl className="dati">
              <dt>Identificativo</dt><dd className="mono--id">{trovato.user.id}</dd>
              <dt>Iscritto</dt><dd>{quando(trovato.user.createdAt)}</dd>
              <dt>Indirizzo verificato</dt>
              <dd>
                {trovato.emailVerifiedAt
                  ? quando(trovato.emailVerifiedAt)
                  : <Esito forma="non-pertinente">No, la verifica è differita</Esito>}
              </dd>
              <dt>Consenso biometrico</dt>
              <dd>
                {trovato.consent.active
                  ? <Esito forma="chiarita">Attivo</Esito>
                  : <Esito forma="non-pertinente">Assente</Esito>}
              </dd>
              <dt>Nell'elenco partecipanti</dt>
              <dd>{trovato.onParticipantList ? "Sì" : "No"}</dd>
              <dt>Galleria personale</dt>
              <dd>
                {trovato.gallery
                  ? <>Match {quando(trovato.gallery.matchedAt)} · {numero(trovato.gallery.anchors)} volti di riferimento</>
                  : "Nessuna"}
              </dd>
              <dt>Selfie conservato</dt>
              <dd>
                {trovato.gallery?.hasQueryVector
                  ? <Esito forma="chiarita">Sì, si può rifare il match</Esito>
                  : <Esito forma="non-pertinente">No</Esito>}
              </dd>
            </dl>

            <hr />

            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
              <button
                className="btn"
                type="button"
                onClick={() => { setNota(""); setRevocaAperta(true); }}
                disabled={!trovato.consent.active}
                title={trovato.consent.active ? undefined : "Non c'è un consenso attivo da revocare: è già assente."}
              >
                Revoca il consenso…
              </button>
              <button
                className="btn btn--danger"
                type="button"
                onClick={() => { setPresaDatto(false); setCancellaAperta(true); }}
              >
                Cancella il partecipante…
              </button>
              <span className="motivo">
                La revoca lascia l'account e cancella il materiale biometrico. La cancellazione
                toglie la persona.
              </span>
            </div>
          </div>
        </div>
      )}

      <Finestra
        aperta={revocaAperta}
        titolo="Revocare il consenso biometrico?"
        onChiudi={() => setRevocaAperta(false)}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={revocando}
            data-loading={revocando || undefined}
            onClick={() => void revoca()}
          >
            {revocando && <span className="btn-spin" aria-hidden="true" />}
            Revoca il consenso
          </button>
        }
      >
        <p>
          Vengono cancellati il vettore del selfie, i volti di riferimento, le voci di galleria
          arrivate grazie a quei volti, i riscontri e le ricerche registrate.{" "}
          <strong>Non si annulla</strong>: per tornare nelle foto la persona dovrà dare di nuovo il
          consenso e rifare il selfie.
        </p>
        <p className="motivo">
          Le foto scattate dai fotografi restano dove sono: non è una cancellazione di foto, è la
          fine del trattamento biometrico di questa persona.
        </p>
        <div className="field">
          <label className="field__label" htmlFor="revoca-nota">
            Come è arrivata la richiesta <span className="opt">facoltativo</span>
          </label>
          <input
            id="revoca-nota"
            className="input"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="e-mail del 3 marzo, banco informazioni…"
            maxLength={500}
          />
          <span className="field__hint">Finisce nel registro delle operazioni, accanto al tuo nome.</span>
        </div>
      </Finestra>

      <Finestra
        aperta={cancellaAperta}
        titolo="Cancellare questo partecipante?"
        onChiudi={() => { setCancellaAperta(false); setPresaDatto(false); }}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!presaDatto || cancellando}
            data-loading={cancellando || undefined}
            title={presaDatto ? undefined : "Spunta prima la presa d'atto"}
            onClick={() => void cancellaPersona()}
          >
            {cancellando ? <span className="btn-spin" aria-hidden="true" /> : Ico.cestino}
            Cancella il partecipante
          </button>
        }
      >
        <p>
          Vengono cancellati l'account, la galleria personale, il selfie conservato, i consensi e le
          sessioni aperte. <strong>Le foto di gruppo scattate da altri non vengono cancellate</strong>:
          se la richiesta è di sparire dalle foto, serve la revoca del consenso, oppure la
          cancellazione delle singole foto da «Foto».
        </p>
        <ul className="finestra__cosa">
          <li><span>Persona</span><span>{trovato?.user.email}</span></li>
          <li><span>Identificativo</span><span className="mono--id">{trovato?.user.id}</span></li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={presaDatto} onChange={(e) => setPresaDatto(e.target.checked)} />
          <span>Ho capito: l'account e il selfie conservato vengono cancellati e non si recuperano.</span>
        </label>
      </Finestra>
    </>
  );
}
