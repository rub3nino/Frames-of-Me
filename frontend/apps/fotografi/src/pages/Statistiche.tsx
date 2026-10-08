import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import { Shell, Esito, Quota, Spin, nf, num, IconInfo, IconAvviso, type EsitoTipo } from "../ui";
import { useActiveEvent } from "../lib/event";

/** Forma di GET /v1/uploads/summary (CONTRACTS.md). */
type Summary = {
  sessions: { open: number; completed: number; aborted: number };
  photos: { uploaded: number; processing: number; indexed: number; error: number; originalsPending: number };
};

/**
 * Le mie statistiche.
 *
 * Le regole che le danno questa forma, e non la forma che avrebbe preso da sé:
 *
 * 1. NIENTE griglia di numeri grandi. I conteggi stanno su una riga di
 *    riepilogo; la distribuzione è una tabella, con il numero a destra e la
 *    proporzione come numero più dei segni. Una barra divisa in quattro colori
 *    sarebbe stato colore e nient'altro: chi non distingue le tinte non
 *    leggerebbe niente.
 * 2. Un dato assente è «—», mai 0: finché il riepilogo non è arrivato — o
 *    finché l'endpoint non esiste — non si scrive zero, che è un conteggio
 *    vero e sarebbe una bugia.
 * 3. L'attesa di un clic già fatto gira dentro il pulsante che l'ha iniziata.
 *    Il ricaricamento automatico ogni 10 secondi non ha nessuna rotella: non
 *    l'ha chiesto nessuno e non deve distrarre.
 * 4. Il riepilogo che non arriva non è un lavoro bloccato: è ambra, e dice che
 *    riprova da solo. Il rosso è per l'evento che non si collega, perché
 *    allora la pagina non può dire niente di vero.
 */
export default function Statistiche() {
  const api = useMemo(() => createClient(), []);
  const { event, loading: evCaricamento, error: evErrore } = useActiveEvent();
  const [sum, setSum] = useState<Summary | null>(null);
  const [aAmano, setAMano] = useState(false);
  const [errore, setErrore] = useState(false);
  const [quando, setQuando] = useState<Date | null>(null);
  const timer = useRef<number | null>(null);
  const vivo = useRef(true);

  useEffect(() => () => { vivo.current = false; if (timer.current) window.clearInterval(timer.current); }, []);

  const carica = useCallback(async () => {
    if (!event) return;
    try {
      const s: Summary = await api.uploadsSummary(event.id);
      if (!vivo.current) return;
      setSum(s); setErrore(false); setQuando(new Date());
    } catch {
      if (vivo.current) setErrore(true);
    }
  }, [api, event]);

  useEffect(() => {
    if (!event) return;
    void carica();
    timer.current = window.setInterval(() => { void carica(); }, 10_000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [carica, event]);

  async function aggiorna() {
    if (aAmano) return;
    setAMano(true);
    try { await carica(); } finally { if (vivo.current) setAMano(false); }
  }

  const f = sum?.photos;
  const totale = f ? f.uploaded + f.processing + f.indexed + f.error : null;

  const stati: { key: string; parola: string; forma: EsitoTipo; n: number | null; spiega: string }[] = [
    { key: "indexed", parola: "Indicizzate", forma: "fatto", n: f?.indexed ?? null, spiega: "Il volto è cercabile: chi compare dentro le trova." },
    { key: "uploaded", parola: "Caricate", forma: "corso", n: f?.uploaded ?? null, spiega: "Arrivate sul server, in attesa del riconoscimento." },
    { key: "processing", parola: "In elaborazione", forma: "corso", n: f?.processing ?? null, spiega: "Il riconoscimento dei volti è in corso adesso." },
    { key: "error", parola: "In errore", forma: "attesa", n: f?.error ?? null, spiega: "Il server non è riuscito a elaborarle: le trovi in Qualità." },
  ];

  return (
    <Shell
      titolo="Le mie statistiche"
      dove={quando ? `aggiornate alle ${quando.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}` : undefined}
      evento={event ? event.name : null}
      azioni={
        <button
          className="btn btn--sm" type="button" onClick={() => void aggiorna()}
          disabled={!event || aAmano} data-loading={aAmano || undefined}
          title={!event ? "L'evento non è ancora collegato" : undefined}
        >
          {aAmano && <Spin />}
          Aggiorna i conteggi
        </button>
      }
    >
      <p className="nota">
        Solo il tuo lavoro, e solo conteggi: di chi compare nelle foto qui non c'è niente.
      </p>

      {evErrore && (
        <div className="callout callout--errore" role="alert">
          <IconAvviso />
          <span className="callout__text">
            <strong>L'evento non si collega.</strong> Senza l'evento questa pagina non può dire
            niente di vero, e per questo i conteggi restano «—». Riprova a ricaricare la pagina;
            se continua, avvisa lo staff.
          </span>
        </div>
      )}
      {errore && !evErrore && (
        <div className="callout callout--attention" role="status">
          <IconAvviso />
          <span className="callout__text">
            <strong>Il riepilogo non è arrivato.</strong> I numeri qui sotto sono gli ultimi
            buoni. Riprovo da solo ogni 10 secondi, oppure premi «Aggiorna i conteggi».
          </span>
        </div>
      )}

      {/* Una riga, non una griglia di numeri grandi. */}
      <div className="summary">
        <span><b className="dato">{num(totale)}</b> foto in totale</span>
        <span><b className="dato">{num(f?.indexed ?? null)}</b> indicizzate</span>
        <span><b className="dato">{num(f?.originalsPending ?? null)}</b> originali da inviare</span>
        <span><b className="dato">{num(f?.error ?? null)}</b> in errore</span>
        <Quota n={f?.indexed ?? null} su={totale} suffisso="delle tue foto è cercabile" />
      </div>

      <div className="sez">
        <h2>Dove sono le mie foto</h2>
        <span className="sez__n">{totale == null ? "in attesa del riepilogo" : `${nf(totale)} foto`}</span>
      </div>

      {sum == null && !evErrore ? (
        // Una lista che sta arrivando: scheletro nelle righe, non uno spinner.
        <div className="tbl-wrap">
          <div className="skel-righe" aria-hidden="true">
            <div className="skel" /><div className="skel" /><div className="skel" /><div className="skel" />
          </div>
          <span className="sr-only" role="status">Sto chiedendo il riepilogo.</span>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th scope="col">Stato</th>
                <th scope="col" className="num">Foto</th>
                <th scope="col">Quota</th>
              </tr>
            </thead>
            <tbody>
              {stati.map((s) => (
                <tr key={s.key}>
                  <td>
                    <Esito tipo={s.n ? s.forma : "spento"}>{s.parola}</Esito>
                    <span className="cell-sub">{s.spiega}</span>
                  </td>
                  <td className="num" data-etichetta="Foto">{num(s.n)}</td>
                  <td data-etichetta="Quota">
                    <Quota n={s.n} su={totale} attenzione={s.key === "error" && !!s.n} suffisso={`delle tue foto: ${s.parola.toLowerCase()}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="coppia">
        <div className="box">
          <div className="box__head">Le mie sessioni di caricamento</div>
          <div className="box__body">
            <dl className="dl">
              <dt>Completate</dt><dd>{num(sum?.sessions.completed ?? null)}</dd>
              <dt>Ancora aperte</dt><dd>{num(sum?.sessions.open ?? null)}</dd>
              <dt>Interrotte</dt><dd>{num(sum?.sessions.aborted ?? null)}</dd>
            </dl>
            {!!sum?.sessions.aborted && (
              <p className="nota-min sp-sopra">
                Una sessione interrotta è un file che non è arrivato intero. L'elenco, con il
                motivo, sta in Qualità.
              </p>
            )}
          </div>
        </div>

        <div className="box">
          <div className="box__head">Quello che l'API non dice ancora</div>
          <div className="box__body">
            {/* Non si scrive zero dove il dato non esiste: si scrive «—». */}
            <dl className="dl">
              <dt>Match generati</dt><dd>—</dd>
              <dt>Volti indicizzati</dt><dd>—</dd>
              <dt>Download delle mie foto</dt><dd>—</dd>
              <dt>Duplicati saltati</dt><dd>—</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="callout callout--info" role="note">
        <IconInfo />
        <span className="callout__text">
          <strong>Funzione in arrivo.</strong> I quattro conteggi lasciati a «—» richiedono{" "}
          <code>GET /v1/photographer/stats?eventId=</code> (G3). Oggi{" "}
          <code>GET /v1/uploads/summary</code> espone solo i conteggi di stato, ed è tutto quello
          che questa pagina mostra.
        </span>
      </div>
    </Shell>
  );
}
