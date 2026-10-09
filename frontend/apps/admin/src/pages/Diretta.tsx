import { useCallback, useEffect, useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import { Callout, Esito, EsitoFoto, Vuoto } from "../parti";
import { leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { eta, numero, quando } from "../lib/formato";
import type { StatoEvento, StatoFoto } from "../lib/tipi";

/**
 * Diretta — la schermata del giorno dell'evento.
 *
 * Si rilegge da sé ogni 5 secondi (`ADMIN_STATUS_REFRESH_MS` nei contratti) e
 * non ha un'azione primaria: serve a guardare. Le azioni stanno dove si
 * esercitano — rimettere in coda in «Foto», riaprire i caricamenti in
 * «Album» — e metterle anche qui vorrebbe dire due posti da cui fare la
 * stessa cosa, con due idee diverse di cosa è successo.
 *
 * Non è una griglia di numeri grandi: è una riga di riepilogo e poi tre
 * tabelle dense (REGOLE §1, divieti). Un numero che chiede attenzione è
 * ambra, non rosso: la coda lunga non blocca il lavoro, lo rallenta.
 */

const REFRESH_MS = 5000;

const STATI: StatoFoto[] = ["indexed", "processing", "uploaded", "error"];

export default function Diretta() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const [dati, setDati] = useState<StatoEvento | null>(null);
  const [errore, setErrore] = useState("");
  const [assente, setAssente] = useState(false);
  const eventoId = evento?.id ?? "";

  const carica = useCallback(async (silenzioso: boolean) => {
    if (!eventoId) return;
    if (!silenzioso) { setDati(null); setErrore(""); }
    try {
      const d = await leggi<StatoEvento>(`/admin/events/${eventoId}/status`);
      setDati(d);
      setAssente(false);
      setErrore("");
    } catch (e: unknown) {
      if (guardia(e)) return;
      // 404 qui vuol dire che la rotta non è in questo ambiente, non che
      // l'evento non esiste: l'evento l'abbiamo appena letto dall'elenco.
      if (stato(e) === 404) { setAssente(true); return; }
      setErrore(messaggio(e, "Non riusciamo a leggere lo stato dell'evento."));
    }
  }, [eventoId, guardia]);

  useEffect(() => {
    if (!eventoId) return;
    void carica(false);
    const id = window.setInterval(() => void carica(true), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [eventoId, carica]);

  if (!evento) return (<><Testa titolo="Diretta" /><ServeUnEvento /></>);

  const foto = dati?.photosByStatus;
  const inErrore = foto?.error ?? 0;
  const codaVecchia = dati?.oldestQueuedSeconds ?? null;

  return (
    <>
      <Testa
        titolo="Diretta"
        dek={
          dati
            ? <>Si rilegge da sé ogni cinque secondi. Ultima lettura: {quando(dati.at)}.</>
            : "Si rilegge da sé ogni cinque secondi."
        }
      />

      {errore && !dati && (
        <Callout genere="errore" ruolo="alert">{errore}</Callout>
      )}
      {assente && <Callout genere="attention">Lo stato in diretta non è in questo ambiente.</Callout>}

      {!dati ? (
        <div className="numeri" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <span className="numero" key={i}><span className="skel" style={{ width: 56, height: 20 }} /><span className="skel" style={{ width: 72 }} /></span>
          ))}
        </div>
      ) : (
        <>
          <div className="numeri">
            <span className="numero"><b>{numero(dati.photos)}</b><span>Foto arrivate</span></span>
            <span className="numero"><b>{numero(foto?.indexed)}</b><span>Indicizzate</span></span>
            <span className="numero" data-guarda={inErrore > 0 ? "true" : undefined}><b>{numero(inErrore)}</b><span>In errore</span></span>
            <span className="numero"><b>{numero(dati.faces)}</b><span>Volti</span></span>
            <span className="numero"><b>{numero(dati.galleriesMatched)}</b><span>Gallerie fatte</span></span>
            <span className="numero" data-guarda={dati.selfiesWaiting > 0 ? "true" : undefined}><b>{numero(dati.selfiesWaiting)}</b><span>Selfie in attesa</span></span>
            <span className="numero"><b>{numero(dati.originalsPending)}</b><span>Originali da caricare</span></span>
            <span className="numero" data-guarda={codaVecchia !== null && codaVecchia > 120 ? "true" : undefined}><b>{eta(codaVecchia)}</b><span>Attesa in coda</span></span>
          </div>

          {dati.faceService.ok === false && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <Callout genere="errore" ruolo="alert">
                <strong>Il servizio di riconoscimento non risponde.</strong> Finché è giù le foto
                arrivano e si accumulano in coda, ma nessuna galleria si forma: i selfie restano in
                attesa. Si riparte da «Operazioni», dove c'è il pannello del servizio.
              </Callout>
            </div>
          )}

          <div className="sezione">
            <div className="sezione__testa">
              <h2>Foto per stato</h2>
              <p className="sezione__nota">
                Lo stato è la pipeline di elaborazione, non il verdetto di moderazione: sono due
                colonne diverse e non si sommano.
              </p>
            </div>
            <div className="tbl-wrap">
              <table className="tbl tbl--schede">
                <thead><tr><th>Stato</th><th className="num">Foto</th></tr></thead>
                <tbody>
                  {STATI.map((s) => (
                    <tr key={s}>
                      <td data-et="Stato"><EsitoFoto stato={s} /></td>
                      <td className="num" data-et="Foto">{numero(foto?.[s])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sezione">
            <div className="sezione__testa">
              <h2>Code di lavoro</h2>
              <p className="sezione__nota">
                «Più vecchio» è da quanto aspetta il lavoro più vecchio ancora in coda: è quello il
                numero che dice se il worker sta dietro.
              </p>
            </div>
            <div className="tbl-wrap">
              <table className="tbl tbl--schede">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th className="num">In coda</th>
                    <th className="num">In corso</th>
                    <th className="num">In errore</th>
                    <th className="num">Più vecchio</th>
                  </tr>
                </thead>
                <tbody>
                  {dati.jobsByType.length === 0 && (
                    <tr><td colSpan={5} style={{ color: "var(--text-tertiary)" }}>Nessun lavoro in coda: il worker ha finito tutto.</td></tr>
                  )}
                  {dati.jobsByType.map((j) => (
                    <tr key={j.type}>
                      <td data-et="Tipo" className="mono">{j.type}</td>
                      <td className="num" data-et="In coda">{numero(j.queued)}</td>
                      <td className="num" data-et="In corso">{numero(j.running)}</td>
                      <td className="num" data-et="In errore">{numero(j.error)}</td>
                      <td className="num" data-et="Più vecchio">{eta(j.oldestQueuedSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sezione">
            <div className="sezione__testa">
              <h2>Album</h2>
              <p className="sezione__nota">
                «Caricamenti» è l'interruttore del giorno dell'evento: da chiuso nessuno carica più
                in quell'album, e si riapre da «Album».
              </p>
            </div>
            <div className="tbl-wrap">
              <table className="tbl tbl--schede">
                <thead>
                  <tr>
                    <th>Album</th><th>Genere</th><th>Riconoscimento</th><th>Moderazione</th>
                    <th>Caricamenti</th><th className="num">Foto</th>
                  </tr>
                </thead>
                <tbody>
                  {dati.albums.length === 0 && (
                    <tr><td colSpan={6} style={{ color: "var(--text-tertiary)" }}>Nessun album: le foto non hanno dove arrivare. Creane uno in «Album».</td></tr>
                  )}
                  {dati.albums.map((a) => (
                    <tr key={a.id}>
                      <td data-et="Album">{a.name}<span className="cell-sub mono">{a.slug}</span></td>
                      <td data-et="Genere">{a.kind === "crowd" ? "Dei partecipanti" : "Ufficiale"}</td>
                      <td data-et="Riconoscimento">
                        <Esito forma={a.recognition ? "chiarita" : "non-pertinente"}>
                          {a.recognition ? "Acceso" : "Spento"}
                        </Esito>
                      </td>
                      <td data-et="Moderazione">{a.moderation === "pre" ? "Prima della pubblicazione" : a.moderation === "post" ? "Dopo, su segnalazione" : "Nessuna"}</td>
                      <td data-et="Caricamenti">
                        <Esito forma={a.uploadsOpen ? "chiarita" : "non-pertinente"}>
                          {a.uploadsOpen ? "Aperti" : "Chiusi"}
                        </Esito>
                      </td>
                      <td className="num" data-et="Foto">{numero(a.photos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sezione">
            <div className="sezione__testa">
              <h2>Ultimi errori</h2>
              <p className="sezione__nota">Gli ultimi venti, dal più recente. Le foto in errore si rimettono in coda da «Foto».</p>
            </div>
            {dati.lastErrors.length === 0 ? (
              <Vuoto titolo="Nessun errore registrato">
                Niente è andato storto da quando il worker è partito. Questa lista si riempie da sé
                quando un lavoro fallisce tutti i suoi tentativi.
              </Vuoto>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl tbl--schede">
                  <thead><tr><th>Quando</th><th>Tipo</th><th>Errore</th></tr></thead>
                  <tbody>
                    {dati.lastErrors.map((e) => (
                      <tr key={e.id}>
                        <td data-et="Quando">{quando(e.at)}</td>
                        <td data-et="Tipo" className="mono">{e.type}</td>
                        <td data-et="Errore" style={{ color: "var(--danger-text)" }}>{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
