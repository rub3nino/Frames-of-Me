import { useCallback, useEffect, useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import {
  Callout, EsitoFoto, Finestra, Pannello, Primario, RigheFinte, Vuoto, usaAvvisi,
} from "../parti";
import { Ico } from "../icone";
import { cancella, invia, leggi, messaggio } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { id as corto, numero, peso, quando } from "../lib/formato";
import type { DettaglioFoto, Foto as RigaFoto, StatoFoto } from "../lib/tipi";

/**
 * Foto — l'archivio dell'evento: cercare, ispezionare, rimettere in coda,
 * cancellare.
 *
 * È una tabella densa e non una griglia di quadrotti: qui non si sceglie una
 * foto bella, si cerca UNA foto — per nome di file, per impronta, per stato —
 * e di quella servono i dati, che in una griglia non ci stanno. Le miniature
 * restano come àncora visiva nella prima colonna.
 *
 * Il dettaglio è un pannello laterale: si guarda una foto senza perdere la
 * lista e senza perdere il punto in cui si era. La cancellazione invece è un
 * dialogo, perché è una domanda a cui si deve rispondere: `DELETE
 * /v1/admin/photos/:id` esegue `purgePhoto` e distrugge i byte originali.
 */

const PAGINA = 60;

const FILTRI: { chiave: "all" | StatoFoto; nome: string }[] = [
  { chiave: "all", nome: "Tutte" },
  { chiave: "uploaded", nome: "Caricate" },
  { chiave: "processing", nome: "In elaborazione" },
  { chiave: "indexed", nome: "Indicizzate" },
  { chiave: "error", nome: "In errore" },
];

export default function Foto() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [filtro, setFiltro] = useState<"all" | StatoFoto>("all");
  const [cerca, setCerca] = useState("");
  const [ricerca, setRicerca] = useState("");
  const [righe, setRighe] = useState<RigaFoto[] | null>(null);
  const [cursore, setCursore] = useState<string | null>(null);
  const [errore, setErrore] = useState("");

  const [dettaglio, setDettaglio] = useState<DettaglioFoto | null>(null);
  const [apertoPannello, setApertoPannello] = useState(false);
  const [caricoDettaglio, setCaricoDettaglio] = useState(false);

  const [daCancellare, setDaCancellare] = useState<RigaFoto | null>(null);
  const [presaDatto, setPresaDatto] = useState(false);
  const [cancellando, setCancellando] = useState(false);
  const [rimettendo, setRimettendo] = useState(false);

  const eventoId = evento?.id ?? "";

  const query = useCallback((cur?: string | null) => {
    const q = new URLSearchParams({ eventId: eventoId, limit: String(PAGINA) });
    if (filtro !== "all") q.set("status", filtro);
    const t = ricerca.trim();
    // Un'impronta si riconosce da sé: se sono cifre esadecimali è un sha256,
    // altrimenti è un nome di file. Chiedere all'operatore quale dei due sta
    // scrivendo è una domanda che la stringa risponde da sola.
    if (t) { if (/^[a-f0-9]{4,64}$/i.test(t)) q.set("sha256", t.toLowerCase()); else q.set("filename", t); }
    if (cur) q.set("cursor", cur);
    return q.toString();
  }, [eventoId, filtro, ricerca]);

  useEffect(() => {
    if (!eventoId) return;
    let annullato = false;
    setRighe(null); setErrore(""); setCursore(null);
    leggi<{ photos: RigaFoto[]; nextCursor: string | null }>(`/admin/photos?${query()}`)
      .then((d) => { if (annullato) return; setRighe(d.photos || []); setCursore(d.nextCursor || null); })
      .catch((e: unknown) => {
        if (annullato || guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere le foto."));
      });
    return () => { annullato = true; };
  }, [eventoId, query, guardia]);

  async function altre() {
    if (!cursore) return;
    try {
      const d = await leggi<{ photos: RigaFoto[]; nextCursor: string | null }>(`/admin/photos?${query(cursore)}`);
      setRighe((r) => [...(r || []), ...(d.photos || [])]);
      setCursore(d.nextCursor || null);
    } catch (e) { guardia(e); }
  }

  async function apri(foto: RigaFoto) {
    setApertoPannello(true);
    setDettaglio(null);
    setCaricoDettaglio(true);
    try {
      setDettaglio(await leggi<DettaglioFoto>(`/admin/photos/${foto.id}`));
    } catch (e) {
      if (!guardia(e)) setErrore(messaggio(e, "Non riusciamo a leggere il dettaglio di questa foto."));
    } finally {
      setCaricoDettaglio(false);
    }
  }

  function chiediCancellazione(foto: RigaFoto) {
    setPresaDatto(false);
    setDaCancellare(foto);
  }

  async function cancellaDavvero() {
    if (!daCancellare || !presaDatto || cancellando) return;
    setCancellando(true);
    const bersaglio = daCancellare;
    try {
      await cancella(`/admin/photos/${bersaglio.id}`);
      setRighe((r) => (r || []).filter((x) => x.id !== bersaglio.id));
      if (dettaglio?.photo.id === bersaglio.id) { setApertoPannello(false); setDettaglio(null); }
      setDaCancellare(null);
      avvisa("Foto cancellata.", "warning", "Originale e copie distrutti.");
    } catch (e) {
      if (!guardia(e)) avvisa(messaggio(e, "Cancellazione non riuscita."), "error");
    } finally {
      setCancellando(false);
    }
  }

  async function rimettiInCoda() {
    if (!eventoId || rimettendo) return;
    setRimettendo(true);
    try {
      const d = await invia<{ requeued: number }>("/admin/photos/requeue", { eventId: eventoId, status: "error" });
      avvisa(`${numero(d.requeued)} foto rimesse in coda.`, "success", "Il worker riprende l'elaborazione da capo.");
      // La lista si rilegge subito: le foto appena rimesse in coda non sono
      // più «in errore» e sparire dal filtro è la conferma visibile.
      const fresche = await leggi<{ photos: RigaFoto[]; nextCursor: string | null }>(`/admin/photos?${query()}`);
      setRighe(fresche.photos || []);
      setCursore(fresche.nextCursor || null);
    } catch (e) {
      if (!guardia(e)) avvisa(messaggio(e, "Non riusciamo a rimettere in coda."), "error");
    } finally {
      setRimettendo(false);
    }
  }

  if (!evento) return (<><Testa titolo="Foto" /><ServeUnEvento /></>);

  const inErrore = (righe ?? []).filter((f) => f.status === "error").length;

  return (
    <>
      <Testa
        titolo="Foto"
        dek="Cerca per nome di file o per impronta, guarda il dettaglio, rimetti in coda quelle in errore."
        azioni={
          filtro === "error" ? (
            <Primario
              onClick={() => void rimettiInCoda()}
              attesa={rimettendo}
              disabled={inErrore === 0}
              perche="Non ci sono foto in errore da rimettere in coda."
            >
              Rimetti in coda le foto in errore
            </Primario>
          ) : undefined
        }
      />

      <div className="strumenti">
        <div className="tabs" role="tablist" aria-label="Stato delle foto">
          {FILTRI.map((f) => (
            <button
              key={f.chiave}
              className="tab"
              role="tab"
              type="button"
              aria-selected={filtro === f.chiave}
              onClick={() => setFiltro(f.chiave)}
            >
              {f.nome}
            </button>
          ))}
        </div>
        <form
          className="strumenti__fine"
          onSubmit={(e) => { e.preventDefault(); setRicerca(cerca); }}
        >
          <div className="input-group">
            {Ico.cerca}
            <input
              className="input cerca"
              type="search"
              value={cerca}
              onChange={(e) => setCerca(e.target.value)}
              placeholder="nome del file, o impronta sha256"
              aria-label="Cerca una foto per nome di file o impronta"
            />
          </div>
          <button className="btn" type="submit">Cerca</button>
          {ricerca && (
            <button className="btn btn--ghost" type="button" onClick={() => { setCerca(""); setRicerca(""); }}>
              Pulisci
            </button>
          )}
        </form>
      </div>

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {righe && righe.length === 0 ? (
        <Vuoto
          titolo={ricerca || filtro !== "all" ? "Nessuna foto con questi filtri" : "Nessuna foto in questo evento"}
          azione={
            ricerca ? (
              <button className="btn" type="button" onClick={() => { setCerca(""); setRicerca(""); }}>
                Togli la ricerca «{ricerca}»
              </button>
            ) : filtro !== "all" ? (
              <button className="btn" type="button" onClick={() => setFiltro("all")}>
                Togli il filtro «{FILTRI.find((f) => f.chiave === filtro)?.nome}»
              </button>
            ) : undefined
          }
        >
          {ricerca || filtro !== "all"
            ? "La ricerca e il filtro valgono insieme: uno dei due sta escludendo tutto."
            : "Le foto arrivano dai fotografi e dai partecipanti. Finché nessuno carica, questa lista resta vuota: controlla in «Album» che i caricamenti siano aperti."}
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th><span className="sr-only">Miniatura</span></th>
                <th>File</th>
                <th>Stato</th>
                <th className="num">Dimensione</th>
                <th>Arrivata</th>
                <th className="tbl__azioni"><span className="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              {!righe && <RigheFinte righe={8} colonne={6} />}
              {righe?.map((f) => (
                <tr key={f.id} aria-selected={dettaglio?.photo.id === f.id && apertoPannello ? true : undefined}>
                  <td className="tbl__mini">
                    {f.thumbUrl
                      ? <img className="mini" src={f.thumbUrl} alt="" loading="lazy" decoding="async" />
                      : <span className="mini" aria-hidden="true" />}
                  </td>
                  <td data-et="File">
                    <button className="btn btn--link" type="button" onClick={() => void apri(f)}>
                      {f.filename ?? `Senza nome · ${corto(f.id)}`}
                    </button>
                    <span className="cell-sub mono">{f.sha256.slice(0, 16)}…</span>
                  </td>
                  <td data-et="Stato">
                    <EsitoFoto stato={f.status} />
                    {f.status === "error" && f.error && <span className="cell-sub">{f.error}</span>}
                  </td>
                  <td className="num" data-et="Dimensione">{peso(f.bytes)}</td>
                  <td data-et="Arrivata">{quando(f.createdAt)}</td>
                  <td className="tbl__azioni" data-et="Azioni">
                    <button
                      className="btn btn--sm"
                      type="button"
                      onClick={() => chiediCancellazione(f)}
                      title="Chiede conferma: cancellare distrugge il file originale"
                    >
                      Cancella…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursore && (
            <div className="tbl__fine">
              <button className="btn" type="button" onClick={() => void altre()}>Carica altre {numero(PAGINA)}</button>
            </div>
          )}
        </div>
      )}

      <Pannello
        aperto={apertoPannello}
        titolo={dettaglio?.photo.filename ?? (dettaglio ? `Foto ${corto(dettaglio.photo.id)}` : "Foto")}
        dek={dettaglio ? corto(dettaglio.photo.id) : undefined}
        onChiudi={() => { setApertoPannello(false); }}
        primario={
          dettaglio ? (
            <button
              className="btn btn--danger"
              type="button"
              onClick={() => chiediCancellazione(dettaglio.photo)}
              title="Chiede conferma: cancellare distrugge il file originale"
            >
              Cancella la foto…
            </button>
          ) : undefined
        }
      >
        {caricoDettaglio && !dettaglio ? (
          <>
            <span className="skel" style={{ display: "block", height: 180, marginBottom: "var(--space-4)" }} />
            <span className="skel" style={{ display: "block", width: "60%" }} />
          </>
        ) : dettaglio ? (
          <>
            {(dettaglio.webUrl || dettaglio.thumbUrl) && (
              <img
                src={(dettaglio.webUrl || dettaglio.thumbUrl) as string}
                alt={dettaglio.photo.filename ?? ""}
                style={{ width: "100%", borderRadius: "var(--radius-sm)", marginBottom: "var(--space-4)" }}
              />
            )}
            <dl className="dati">
              <dt>Stato</dt><dd><EsitoFoto stato={dettaglio.photo.status} /></dd>
              <dt>Impronta</dt><dd className="mono--id">{dettaglio.photo.sha256}</dd>
              <dt>Dimensione</dt><dd>{peso(dettaglio.photo.bytes)}</dd>
              <dt>Originale</dt><dd>{dettaglio.photo.originalStatus}</dd>
              <dt>Volti trovati</dt><dd>{numero(dettaglio.faces.length)}</dd>
              <dt>Arrivata</dt><dd>{quando(dettaglio.photo.createdAt)}</dd>
              <dt>Indicizzata</dt><dd>{quando(dettaglio.photo.indexedAt)}</dd>
              {dettaglio.photo.error && (<><dt>Errore</dt><dd style={{ color: "var(--danger-text)" }}>{dettaglio.photo.error}</dd></>)}
            </dl>

            {/* Dentro un pannello si separa con una linea, non con un secondo
                riquadro (REGOLE §1.6). */}
            <hr />
            <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", marginBottom: "var(--space-2)" }}>
              Nelle gallerie di {numero(dettaglio.galleries.length)} persone
            </h3>
            {dettaglio.galleries.length === 0 ? (
              <p className="motivo">
                Non compare nella galleria di nessuno. Se è indicizzata ed è una foto di gruppo,
                vuol dire che nessuno dei volti corrisponde a un selfie già arrivato.
              </p>
            ) : (
              <table className="tbl">
                <thead><tr><th>Persona</th><th className="num">Punteggio</th><th>Come</th></tr></thead>
                <tbody>
                  {dettaglio.galleries.map((g) => (
                    <tr key={g.userId}>
                      <td>{g.email}</td>
                      <td className="num">{g.score.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td>{g.source === "match" ? "Riconoscimento" : "Aggiunta a mano"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </Pannello>

      <Finestra
        aperta={daCancellare !== null}
        titolo="Cancellare questa foto per sempre?"
        onChiudi={() => { setDaCancellare(null); setPresaDatto(false); }}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!presaDatto || cancellando}
            data-loading={cancellando || undefined}
            title={presaDatto ? undefined : "Spunta prima la presa d'atto: questa azione distrugge il file"}
            onClick={() => void cancellaDavvero()}
          >
            {cancellando ? <span className="btn-spin" aria-hidden="true" /> : Ico.cestino}
            Cancella la foto definitivamente
          </button>
        }
      >
        <p>
          Vengono eliminati il file originale, le copie (anteprima e versione web), i volti
          rilevati e le voci nelle gallerie delle persone. <strong>L'operazione non si annulla</strong>:
          non resta nessuna copia da cui recuperare la foto.
        </p>
        <ul className="finestra__cosa">
          <li><span>File</span><span>{daCancellare?.filename ?? "senza nome"}</span></li>
          <li><span>Impronta</span><span className="mono--id">{daCancellare ? daCancellare.sha256.slice(0, 24) : ""}…</span></li>
          <li><span>Dimensione</span><span>{peso(daCancellare?.bytes)}</span></li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={presaDatto} onChange={(e) => setPresaDatto(e.target.checked)} />
          <span>Ho capito: il file originale viene cancellato e non si può recuperare.</span>
        </label>
      </Finestra>
    </>
  );
}
