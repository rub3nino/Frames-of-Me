import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import { Shell, Esito, Quota, Spin, nf, num, quando as fQuando, IconInfo, IconAvviso, IconOk } from "../ui";
import { useActiveEvent } from "../lib/event";

/** Riga di GET /v1/uploads (CONTRACTS.md): lo stato di sessione è open|completed|aborted. */
type UploadRow = { id: string; objectKey: string; sha256: string; contentType: string; status: "open" | "completed" | "aborted"; createdAt: string };
type UploadsResponse = { uploads: UploadRow[]; nextCursor: string | null };
type Summary = {
  sessions: { open: number; completed: number; aborted: number };
  photos: { uploaded: number; processing: number; indexed: number; error: number; originalsPending: number };
};

const nomeFile = (objectKey: string) => objectKey.split("/").pop() || objectKey;

/**
 * Qualità: la coda operativa. Che cosa non è andato a buon fine, e come si
 * rimedia.
 *
 * Le regole che le danno questa forma:
 *
 * 1. Niente griglia di numeri grandi: una riga di riepilogo, e la salute del
 *    caricamento è una proporzione — numero più segni, non una tinta.
 * 2. Il rosso è raro. Una sessione interrotta è ambra: il file si rimanda, il
 *    lavoro non è bloccato. Il rosso compare solo se l'evento non si collega,
 *    perché allora da qui non si rimedia niente.
 * 3. Ogni riga dice COSA è andato storto, PERCHÉ e COME si rimedia. Un elenco
 *    di nomi di file con un triangolo rosso accanto non è un messaggio
 *    d'errore.
 * 4. L'elenco che sta arrivando è uno scheletro nelle righe; l'attesa di un
 *    clic già fatto è la rotella dentro il pulsante «Aggiorna». Mai una
 *    rotella a tutto schermo.
 * 5. Nessun dato è una frase con un verbo, non una tabella di zeri.
 */
export default function Qualita() {
  const api = useMemo(() => createClient(), []);
  const { event, loading: evCaricamento, error: evErrore } = useActiveEvent();
  const [righe, setRighe] = useState<UploadRow[] | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [errore, setErrore] = useState(false);
  const [aggiornando, setAggiornando] = useState(false);
  const vivo = useRef(true);

  useEffect(() => () => { vivo.current = false; }, []);

  const carica = useCallback(async () => {
    if (!event) return;
    try {
      const [lista, riepilogo] = await Promise.all([
        // GET /v1/uploads esiste; api.raw mette il prefisso /v1.
        api.raw(`/uploads?eventId=${encodeURIComponent(event.id)}&limit=200`) as Promise<UploadsResponse>,
        api.uploadsSummary(event.id) as Promise<Summary>,
      ]);
      if (!vivo.current) return;
      // Le sessioni interrotte sono il segnale di «caricamento non riuscito»
      // che il contratto espone oggi: byte che non combaciano, HEAD diverso,
      // pulizia di una sessione mai chiusa.
      setRighe((lista.uploads || []).filter((u) => u.status === "aborted"));
      setSum(riepilogo);
      setErrore(false);
    } catch {
      if (vivo.current) { setErrore(true); setRighe([]); }
    }
  }, [api, event]);

  useEffect(() => { void carica(); }, [carica]);

  async function aggiorna() {
    if (aggiornando) return;
    setAggiornando(true);
    try { await carica(); } finally { if (vivo.current) setAggiornando(false); }
  }

  const f = sum?.photos;
  const inErrore = f?.error ?? null;
  const dovuti = f?.originalsPending ?? null;
  const arrivate = f ? f.uploaded + f.processing + f.indexed : null;
  const esaminate = arrivate != null && inErrore != null ? arrivate + inErrore : null;

  const caricamento = righe == null && !errore;

  return (
    <Shell
      titolo="Qualità"
      dove={righe == null ? undefined : righe.length === 0 ? "nessun guasto aperto" : `${nf(righe.length)} da guardare`}
      evento={event ? event.name : null}
      conteggi={{ "/qualita": righe?.length ?? 0 }}
      azioni={
        <button
          className="btn btn--sm" type="button" onClick={() => void aggiorna()}
          disabled={!event || aggiornando} data-loading={aggiornando || undefined}
          title={!event ? (evCaricamento ? "Sto collegando l'evento" : "L'evento non è collegato") : undefined}
        >
          {aggiornando && <Spin />}
          Aggiorna l'elenco
        </button>
      }
    >
      {evErrore && (
        <div className="callout callout--errore" role="alert">
          <IconAvviso />
          <span className="callout__text">
            <strong>L'evento non si collega.</strong> Senza l'evento non possiamo sapere cosa non
            è andato a buon fine: i conteggi restano «—». Ricarica la pagina; se continua, avvisa
            lo staff.
          </span>
        </div>
      )}
      {errore && !evErrore && (
        <div className="callout callout--attention" role="status">
          <IconAvviso />
          <span className="callout__text">
            <strong>L'elenco non è arrivato.</strong> Il server non ha risposto. Premi «Aggiorna
            l'elenco»: nel frattempo nessun caricamento si è perso, la coda è sul tuo computer.
          </span>
        </div>
      )}

      <div className="summary">
        <span><b className="dato">{num(arrivate)}</b> foto arrivate</span>
        <span><b className="dato">{num(inErrore)}</b> in errore sul server</span>
        <span><b className="dato">{num(dovuti)}</b> originali da inviare</span>
        <span><b className="dato">{num(sum?.sessions.aborted ?? null)}</b> sessioni interrotte</span>
        <Quota n={arrivate} su={esaminate} attenzione={!!inErrore} suffisso="dei caricamenti è andato a buon fine" />
      </div>

      {!!dovuti && (
        <div className="callout callout--attention" role="status">
          <IconAvviso />
          <span className="callout__text">
            <strong>
              {dovuti === 1
                ? "Un originale non è ancora arrivato."
                : `${nf(dovuti)} originali non sono ancora arrivati.`}
            </strong>{" "}
            La versione web è sul server e la foto è già cercabile: manca il file grande, che
            serve per la stampa. Tieni aperta la pagina Caricamento fino alla fine della coda,
            oppure rimetti quei file nella cartella sorvegliata.
          </span>
        </div>
      )}

      <div className="callout callout--info" role="note">
        <IconInfo />
        <span className="callout__text">
          <strong>Funzione in arrivo.</strong> Il <b>motivo</b> per singola foto (impronta che
          non combacia, formato non supportato, byte che non tornano) e il pulsante{" "}
          <b>Riprova</b> lato server richiedono{" "}
          <code>GET /v1/photographer/photos?status=error</code> (G2). Oggi, dal contratto, si
          vedono le <b>sessioni interrotte</b> di <code>GET /v1/uploads</code>: un file che non è
          arrivato intero si rimanda dal Caricamento, dove la ripresa riparte dalla parte
          interrotta.
        </span>
      </div>

      <div className="sez">
        <h2>Sessioni interrotte</h2>
        <span className="sez__n">
          {caricamento ? "sto chiedendo l'elenco" : righe && righe.length > 0 ? `${nf(righe.length)} ${righe.length === 1 ? "sessione" : "sessioni"}` : "nessuna"}
        </span>
      </div>

      {caricamento ? (
        <div className="tbl-wrap">
          <div className="skel-righe" aria-hidden="true">
            <div className="skel" /><div className="skel" /><div className="skel" /><div className="skel" /><div className="skel" />
          </div>
          <span className="sr-only" role="status">Sto chiedendo l'elenco delle sessioni interrotte.</span>
        </div>
      ) : righe && righe.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Che cosa è andato storto</th>
                <th scope="col">Quando</th>
                <th scope="col">Come si rimedia</th>
              </tr>
            </thead>
            <tbody>
              {righe.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="nomefile" title={r.objectKey}>{nomeFile(r.objectKey)}</span>
                    <span className="cell-sub codice">{r.contentType} · sha {r.sha256.slice(0, 12)}…</span>
                  </td>
                  <td data-etichetta="Che cosa">
                    {/* Ambra: il file si rimanda, il lavoro non è bloccato. */}
                    <Esito tipo="attesa">Sessione interrotta</Esito>
                    <span className="cell-sub">
                      Il caricamento si è chiuso senza che il file arrivasse intero: rete caduta,
                      pagina chiusa a metà, o byte che non combaciano con l'impronta.
                    </span>
                  </td>
                  <td data-etichetta="Quando" className="dato">{fQuando(r.createdAt)}</td>
                  <td data-etichetta="Come si rimedia">
                    Rimetti il file nella cartella sorvegliata, o trascinalo nel Caricamento:
                    riparte da zero una sola volta e i duplicati si saltano da soli.
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <IconOk />
          <h2>Non c'è niente da sistemare</h2>
          <p>
            Tutte le tue sessioni di caricamento si sono chiuse intere. Torna al Caricamento e
            continua: se qualcosa non parte, comparirà qui.
          </p>
        </div>
      )}
    </Shell>
  );
}
