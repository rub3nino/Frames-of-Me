import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen, Callout } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

/**
 * I miei dati: lo stato del consenso e la revoca.
 *
 * La revoca è IRREVERSIBILE per il modello numerico del volto — una volta
 * cancellato non si ricostruisce, perché il selfie da cui veniva è già stato
 * cancellato il giorno del confronto. Quindi:
 *
 * - è un `btn--primary.btn--danger`, l'unico primario della schermata, e il
 *   rosso qui è nel suo caso: azione irreversibile;
 * - sta dietro una conferma che NOMINA quello che viene cancellato, con i
 *   numeri veri letti da `GET /v1/events/:slug/privacy`, e dice anche che
 *   cosa NON viene cancellato — perché «cancella tutto» su una pagina di
 *   privacy è una promessa che non manteniamo: le foto dell'evento restano
 *   del fotografo;
 * - nel piede della conferma il primario sta a SINISTRA e «Annulla» subito
 *   dopo, e Annulla non è rosso: rosso è la cosa che non si torna indietro;
 * - mentre la conferma è aperta il primario della pagina scende a secondario,
 *   così non ci sono due neri in vista.
 *
 * Il `<dialog>` è quello del browser vestito con il riquadro del sistema:
 * `components.css` non ha un dialogo, e inventarne uno è la cosa che
 * l'identità vieta prima di tutte. Il pannello laterale non va bene — quello
 * «non è un dialogo: la pagina dietro resta usabile» — e una conferma
 * irreversibile deve fermare la pagina.
 *
 * ESPORTAZIONE E CANCELLAZIONE DELL'ACCOUNT non hanno una rotta self-service
 * in CONTRACTS.md: oggi passano da chi gestisce l'evento. Prima questa pagina
 * mostrava tre pulsanti che facevano comparire un toast «Richiesta
 * registrata» senza chiamare niente. Su una pagina di diritti GDPR quella è
 * la bugia peggiore possibile, e i pulsanti sono via: al loro posto c'è la
 * strada vera, scritta.
 */

const dataIT = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
const nf = new Intl.NumberFormat("it-IT");

/** Un dato assente è un trattino, mai uno zero. */
const quando = (s: unknown) => {
  if (typeof s !== "string" || !s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : dataIT.format(d);
};
const quanti = (n: unknown) => (typeof n === "number" ? nf.format(n) : "—");

type Privacy = {
  event?: { slug: string; name: string };
  consent?: { grantedAt: string; textVersion: string } | null;
  withdrawnAt?: string | null;
  gallery?: { photos: number; selfieVector: boolean; anchors: number; matchedAt: string | null } | null;
  uploads?: number;
};
type Cancellati = Record<string, number | boolean>;

export default function IMieiDati() {
  const nav = useNavigate();
  const [dati, setDati] = useState<Privacy | null>(null);
  const [errore, setErrore] = useState("");
  const [conferma, setConferma] = useState(false);
  const [inRevoca, setInRevoca] = useState(false);
  const [revocato, setRevocato] = useState<Cancellati | null>(null);
  const [inUscita, setInUscita] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const revocaRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const d = (await api.raw(`/events/${EVENT_SLUG}/privacy`)) as Privacy;
        if (vivo) setDati(d);
      } catch (err: any) {
        if (!vivo) return;
        if (err?.status === 401) setErrore("La sessione è scaduta. Torna all'accesso ed entra di nuovo per vedere i tuoi dati.");
        else setErrore("Non riusciamo a leggere lo stato dei tuoi dati. Controlla la rete e ricarica la pagina.");
      }
    })();
    return () => { vivo = false; };
  }, []);

  /* Il dialogo del browser va aperto e chiuso con i suoi metodi, altrimenti
     non è modale e Esc non funziona. */
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (conferma && !el.open) el.showModal();
    if (!conferma && el.open) el.close();
  }, [conferma]);

  async function revoca() {
    if (inRevoca) return;
    setInRevoca(true);
    setErrore("");
    try {
      const r: any = await api.raw(`/events/${EVENT_SLUG}/consent/withdraw`, {
        method: "POST",
        json: { confirm: true },
      });
      setRevocato((r?.deleted ?? {}) as Cancellati);
      setDati((d) => ({ ...(d || {}), withdrawnAt: r?.withdrawnAt || new Date().toISOString(), gallery: null }));
      setConferma(false);
    } catch (err: any) {
      setErrore(
        err?.status === 401
          ? "La sessione è scaduta. Torna all'accesso ed entra di nuovo: la revoca non è stata registrata."
          : "La revoca non è andata a buon fine e nulla è stato cancellato. Riprova; se continua, chiedi al banco dell'evento.",
      );
      setConferma(false);
    } finally {
      setInRevoca(false);
    }
  }

  async function esci() {
    if (inUscita) return;
    setInUscita(true);
    try { await api.logout(); } catch { /* la sessione si chiude comunque qui */ }
    finally { nav("/", { replace: true }); }
  }

  const attivo = !!dati?.consent && !dati?.withdrawnAt && !revocato;
  const foto = dati?.gallery?.photos;
  const modello = dati?.gallery?.selfieVector;

  return (
    <Screen>
      <div className="colonna">
        <header className="gruppo">
          <h1 className="titolo">I miei dati</h1>
          <p className="dek">
            {dati?.event?.name ? `${dati.event.name}. ` : ""}
            Qui vedi cosa teniamo del tuo volto, e lo togli quando vuoi.
          </p>
        </header>

        {errore && <Callout variante="errore">{errore}</Callout>}

        {/* --- Lo stato del consenso ---------------------------------------- */}
        <section className="sezione-dati">
          <h2>Consenso al riconoscimento</h2>

          {!dati && !errore ? (
            /* La riga che arriva, nella forma che avrà. */
            <>
              <div className="skel skel--corto" />
              <div className="skel" />
            </>
          ) : (
            <>
              {/* L'esito ha una FORMA e una PAROLA: cerchio pieno = attivo,
                  trattino = non attivo. Non è una tinta da indovinare.
                  I nomi delle classi (`--chiarita`, `--non-pertinente`)
                  vengono dal vocabolario di `components.css` e dicono la
                  forma, non il dominio: sono il cerchio pieno e il trattino
                  dei cinque segni nominati in REGOLE.md §1.3. */}
              <div className="riga">
                <span className={attivo ? "esito esito--chiarita" : "esito esito--non-pertinente"}>
                  {attivo ? "Consenso attivo" : dati?.withdrawnAt || revocato ? "Consenso revocato" : "Nessun consenso registrato"}
                </span>
                <span className="num tenue">
                  {attivo ? `dal ${quando(dati?.consent?.grantedAt)}` : `il ${quando(dati?.withdrawnAt)}`}
                </span>
              </div>

              <p>
                {attivo
                  ? "Hai acconsentito al confronto del tuo volto con le foto di questo evento. Puoi revocarlo in qualsiasi momento: dalla revoca non ti cerchiamo più nelle foto nuove."
                  : "Non stiamo cercando il tuo volto in nessuna foto. Le foto che avevi già trovato non sono più collegate a te."}
              </p>

              {/* Una riga di riepilogo, non una griglia di numeri grandi.
                  Assente è `—`. */}
              <div className="summary">
                <span>Foto nella tua galleria <b>{quanti(foto)}</b></span>
                <span>Modello numerico del volto <b>{typeof modello === "boolean" ? (modello ? "sì" : "no") : "—"}</b></span>
                <span>Ultimo confronto <b className="num">{quando(dati?.gallery?.matchedAt)}</b></span>
              </div>
            </>
          )}
        </section>

        {/* --- La revoca ---------------------------------------------------- */}
        {attivo && (
          <section className="sezione-dati">
            <h2>Revoca il consenso</h2>
            <p>
              Cancelliamo il modello numerico del tuo volto e la tua galleria personale.{" "}
              <b>Il modello non si può ricostruire</b>: il selfie da cui veniva è già stato
              cancellato il giorno del confronto, quindi per tornare indietro servirebbe un
              selfie nuovo e un consenso nuovo.
            </p>
            {/* L'unico primario della schermata, e in rosso perché la cosa non
                si torna indietro. Mentre la conferma è aperta scende a
                secondario: non ci sono due neri in vista. */}
            <button
              ref={revocaRef}
              className={conferma ? "btn btn--danger" : "btn btn--primary btn--danger"}
              type="button"
              onClick={() => setConferma(true)}
            >
              Revoca il consenso
            </button>
          </section>
        )}

        {revocato && (
          <Callout variante="ok">
            <b>Consenso revocato.</b> Cancellati: il modello numerico del volto, le{" "}
            {quanti(revocato.galleryItems)} voci della tua galleria, {quanti(revocato.anchors)}{" "}
            ancore, {quanti(revocato.selfieObjects)} selfie conservati e{" "}
            {quanti(revocato.feedback)} tuoi verdetti. Non ti cerchiamo più in nessuna foto.
          </Callout>
        )}

        {/* --- I diritti che oggi non sono automatici ----------------------- */}
        <section className="sezione-dati">
          <h2>Copia dei tuoi dati e cancellazione dell'account</h2>
          <p>
            Hai diritto a ricevere una copia dei dati che ti riguardano e a chiederne la
            cancellazione.
          </p>
          <Callout variante="info">
            Queste due richieste non sono ancora automatiche. Chiedile al banco dell'evento o a
            chi organizza l'evento: le evadono entro un mese, come prevede il GDPR. La revoca
            del consenso qui sopra, invece, è immediata.
          </Callout>
        </section>

        {/* --- Uscire ------------------------------------------------------- */}
        <section className="sezione-dati">
          <h2>Esci</h2>
          <p>Chiude la sessione su questo telefono. I tuoi dati non vengono toccati.</p>
          <button
            className="btn"
            type="button"
            onClick={esci}
            disabled={inUscita}
            data-loading={inUscita || undefined}
          >
            {inUscita && <span className="btn-spin" aria-hidden="true" />}
            Esci da questo telefono
          </button>
        </section>
      </div>

      {/* --- La conferma --------------------------------------------------- */}
      <dialog
        className="conferma"
        ref={dialogRef}
        aria-labelledby="conferma-titolo"
        onCancel={(e) => { e.preventDefault(); setConferma(false); }}
        onClose={() => setConferma(false)}
      >
        <h2 id="conferma-titolo">Revocare il consenso?</h2>
        <p className="prosa">Cancelliamo subito e per sempre:</p>
        <ul className="elenco-dati">
          <li><span className="k">Il modello numerico del tuo volto</span><span className="v">{modello ? "sì" : "—"}</span></li>
          <li><span className="k">Le foto collegate a te</span><span className="v">{quanti(foto)}</span></li>
          <li><span className="k">Le ancore del confronto</span><span className="v">{quanti(dati?.gallery?.anchors)}</span></li>
          <li><span className="k">I tuoi «non sono io» e «sono io»</span><span className="v">tutti</span></li>
        </ul>
        <p className="prosa">
          <b>Non</b> cancelliamo le foto dell'evento: restano del fotografo che le ha scattate.
          Smettono solo di essere collegate al tuo volto, e tu non le vedi più nella tua
          galleria.
        </p>
        <p className="prosa">
          Il modello non si ricostruisce: per rivedere le tue foto dovresti fare un selfie nuovo
          e dare un consenso nuovo.
        </p>
        {/* Primario a sinistra, Annulla subito dopo. Annulla non è rosso. */}
        <div className="conferma__piede">
          <button
            className="btn btn--primary btn--danger"
            type="button"
            onClick={revoca}
            disabled={inRevoca}
            data-loading={inRevoca || undefined}
          >
            {inRevoca && <span className="btn-spin" aria-hidden="true" />}
            Revoca e cancella
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => setConferma(false)}>
            Annulla
          </button>
        </div>
      </dialog>
    </Screen>
  );
}
