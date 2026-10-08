import { useCallback, useEffect, useState } from "react";
import { Testa } from "../guscio";
import { Callout, Esito, Finestra, Primario, RigheFinte, usaAvvisi } from "../parti";
import { Ico } from "../icone";
import { invia, leggi, messaggio } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { id as corto, numero, quando } from "../lib/formato";
import type { PianoRetention } from "../lib/tipi";

/**
 * Privacy e retention.
 *
 * La conservazione non è una preferenza: è la promessa fatta ai partecipanti
 * nell'informativa, e qui si vede se il sistema la sta mantenendo. Tre cose
 * che questa schermata deve dire e che prima nessuna schermata diceva:
 *
 *  - la pianificazione è accesa o spenta (`RETENTION_SCHEDULER`). Se è spenta
 *    nessuno cancella niente, e nessun numero in questa pagina lo
 *    suggerirebbe da solo;
 *  - quando ha girato l'ultima volta e quando girerà la prossima;
 *  - se c'è un allarme — mai girata, saltata per due finestre, lavoro finito
 *    in errore — con la frase che dice cosa vuol dire.
 *
 * Gli allarmi sono ambra e non rossi: il lavoro non è bloccato, è in ritardo.
 * Rosso è solo il lavoro fallito, che è un errore vero.
 */

const REFRESH_MS = 30_000;

const ALLARME: Record<string, string> = {
  failed: "La pianificazione non è riuscita a mettere in coda il lavoro: guarda l'errore.",
  job_error: "L'ultimo lavoro di pulizia è finito in errore e i tentativi sono esauriti: le foto oltre la soglia sono ancora lì.",
  skipped: "Nessuna esecuzione da più di due finestre: il worker è stato giù o è spento.",
  never: "Mai eseguita per questo evento.",
};

const LAVORO: Record<string, [string, string]> = {
  queued: ["attesa", "In coda"],
  running: ["in-esame", "In corso"],
  done: ["chiarita", "Completato"],
  error: ["eccezione", "In errore"],
};

export default function Privacy() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [piano, setPiano] = useState<PianoRetention | null>(null);
  const [errore, setErrore] = useState("");
  const [battito, setBattito] = useState(0);
  const [aperta, setAperta] = useState(false);
  const [presaDatto, setPresaDatto] = useState(false);
  const [avviando, setAvviando] = useState(false);

  const carica = useCallback(() => {
    leggi<PianoRetention>("/admin/retention/schedule")
      .then((d) => { setPiano(d); setErrore(""); })
      .catch((e: unknown) => {
        if (guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere la pianificazione della retention."));
      });
  }, [guardia]);

  useEffect(() => {
    carica();
    const id = window.setInterval(() => setBattito((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [carica, battito]);

  async function eseguiAdesso() {
    if (!evento || !presaDatto || avviando) return;
    setAvviando(true);
    try {
      const d = await invia<{ jobId: string }>("/admin/retention/run", { eventId: evento.id });
      avvisa("Pulizia messa in coda.", "warning", `Lavoro ${corto(d.jobId)}`);
      setAperta(false);
      setPresaDatto(false);
      carica();
    } catch (e: unknown) {
      if (!guardia(e)) avvisa(messaggio(e, "Non riusciamo ad avviare la pulizia."), "error");
    } finally { setAvviando(false); }
  }

  const csv = (nome: string) => (evento ? `/v1/admin/export/${nome}.csv?eventId=${evento.id}` : "#");

  return (
    <>
      <Testa
        titolo="Privacy e retention"
        dek="Quanto si conserva, quando si cancella, e la prova che è stato cancellato."
        azioni={
          <Primario
            onClick={() => { setPresaDatto(false); setAperta(true); }}
            disabled={!evento}
            perche="Scegli prima un evento nella barra in alto: la pulizia si esegue su un evento."
          >
            Esegui la pulizia adesso…
          </Primario>
        }
      />

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {piano && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          {piano.enabled ? (
            <Callout genere="info">
              La pulizia gira nel worker, una finestra ogni{" "}
              {numero(Math.round(piano.windowSeconds / 3600))} ore. Cancella le foto oltre la
              conservazione dell'evento e di quegli album che ne hanno una propria.
            </Callout>
          ) : (
            <Callout genere="attention" ruolo="status">
              <strong>La pianificazione è spenta</strong> (<span className="mono">RETENTION_SCHEDULER=false</span>).
              Nessuno sta cancellando le foto scadute: va lanciata a mano da qui, oppure da un cron
              esterno. Se l'informativa promette una conservazione, in questo momento la promessa
              non è mantenuta.
            </Callout>
          )}
        </div>
      )}

      <div className="sezione">
        <div className="sezione__testa">
          <h2>Pianificazione per evento</h2>
          <p className="sezione__nota">Si rilegge da sé ogni mezzo minuto.</p>
        </div>
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th>Evento</th><th className="num">Conservazione</th><th>Ultima</th>
                <th>Prossima finestra</th><th className="num">Esecuzioni</th><th>Ultimo lavoro</th>
              </tr>
            </thead>
            <tbody>
              {!piano && <RigheFinte righe={2} colonne={6} />}
              {piano?.events.length === 0 && (
                <tr><td colSpan={6} style={{ color: "var(--text-tertiary)" }}>Nessun evento da pulire.</td></tr>
              )}
              {piano?.events.map((e) => {
                const [forma, parola] = LAVORO[e.jobStatus ?? ""] ?? ["non-pertinente", "—"];
                return (
                  <tr key={e.eventId} aria-selected={evento?.id === e.eventId ? true : undefined}>
                    <td data-et="Evento">
                      <span className="mono">{e.slug}</span>
                      {e.alarm && <span className="cell-sub">{ALLARME[e.alarm] ?? e.alarm}{e.jobError ? ` — ${e.jobError}` : ""}</span>}
                    </td>
                    <td className="num" data-et="Conservazione">{numero(e.retentionDays)} gg</td>
                    <td data-et="Ultima">{quando(e.lastRunAt)}</td>
                    <td data-et="Prossima finestra">{quando(e.nextRunAt)}</td>
                    <td className="num" data-et="Esecuzioni">{numero(e.runs)}</td>
                    <td data-et="Ultimo lavoro">
                      {e.jobId ? <Esito forma={forma}>{parola}</Esito> : <Esito forma="non-pertinente">Nessuno</Esito>}
                      {e.jobFinishedAt && <span className="cell-sub">{quando(e.jobFinishedAt)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sezione">
        <div className="sezione__testa">
          <h2>Esportazioni</h2>
          <p className="sezione__nota">
            Tre file CSV dell'evento scelto in alto. Contengono indirizzi e-mail e identificativi:
            sono dati personali e il file scaricato non è più protetto da questa console.
          </p>
        </div>
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead><tr><th>File</th><th>Cosa contiene</th><th className="tbl__azioni"><span className="sr-only">Scarica</span></th></tr></thead>
            <tbody>
              <tr>
                <td data-et="File" className="mono">gallerie.csv</td>
                <td data-et="Cosa contiene">Chi ha quali foto, con punteggio, origine e riscontro</td>
                <td className="tbl__azioni" data-et="Scarica">
                  <a className="btn btn--sm" href={csv("galleries")} download aria-disabled={!evento}>Scarica</a>
                </td>
              </tr>
              <tr>
                <td data-et="File" className="mono">match-hits.csv</td>
                <td data-et="Cosa contiene">Ogni corrispondenza con il coseno grezzo. Serve a tarare la soglia e richiede <span className="mono">MATCH_LOG=true</span></td>
                <td className="tbl__azioni" data-et="Scarica">
                  <a className="btn btn--sm" href={csv("match-hits")} download aria-disabled={!evento}>Scarica</a>
                </td>
              </tr>
              <tr>
                <td data-et="File" className="mono">feedback.csv</td>
                <td data-et="Cosa contiene">I «non sono io» dei partecipanti: è il modo di sapere quanto sbaglia il riconoscimento</td>
                <td className="tbl__azioni" data-et="Scarica">
                  <a className="btn btn--sm" href={csv("feedback")} download aria-disabled={!evento}>Scarica</a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="sezione">
        <div className="sezione__testa">
          <h2>Documenti</h2>
        </div>
        <p className="sezione__nota">
          La valutazione d'impatto e il registro dei trattamenti stanno nel repository, non in
          questa console: sono documenti firmati, non una schermata.{" "}
          <a href="/docs/DPIA.md" target="_blank" rel="noreferrer">DPIA {Ico.esterno}</a>
        </p>
      </div>

      <Finestra
        aperta={aperta}
        titolo={evento ? `Eseguire la pulizia di «${evento.name}»?` : ""}
        onChiudi={() => { setAperta(false); setPresaDatto(false); }}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!presaDatto || avviando}
            data-loading={avviando || undefined}
            title={presaDatto ? undefined : "Spunta prima la presa d'atto"}
            onClick={() => void eseguiAdesso()}
          >
            {avviando ? <span className="btn-spin" aria-hidden="true" /> : Ico.cestino}
            Esegui la pulizia
          </button>
        }
      >
        <p>
          Le foto più vecchie della conservazione dell'evento ({numero(evento?.retentionDays)} giorni)
          vengono cancellate in modo <strong>irreversibile</strong>: originali, copie e volti. Il
          lavoro gira in sottofondo e viene registrato nel registro delle operazioni.
        </p>
        <p className="motivo">
          Non consuma la finestra della pianificazione: la prossima automatica resta dov'è. Se hai
          appena abbassato la conservazione, questa è l'operazione che la applica subito.
        </p>
        <label className="check">
          <input type="checkbox" checked={presaDatto} onChange={(e) => setPresaDatto(e.target.checked)} />
          <span>Ho capito: le foto oltre la soglia vengono cancellate e non si recuperano.</span>
        </label>
      </Finestra>
    </>
  );
}
