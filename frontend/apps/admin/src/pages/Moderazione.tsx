import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Testa, ServeUnEvento } from "../guscio";
import {
  Callout, Esito, EsitoModerazione, Finestra, Primario, Tasto, Vuoto, usaAvvisi, usaInchiostro,
} from "../parti";
import { Ico } from "../icone";
import { invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { giorno, id as corto, numero, quando } from "../lib/formato";
import type { Album, CodaModerazione, VoceModerazione } from "../lib/tipi";

/**
 * La coda di moderazione.
 *
 * Due persone stanno su questa schermata per ore, quindi è costruita intorno
 * alla tastiera e alla latenza, non intorno all'aspetto:
 *
 *  - una foto grande alla volta, e le prossime già decodificate, così un
 *    verdetto non aspetta la rete;
 *  - ogni verdetto parte subito e la richiesta viaggia dietro; se non arriva
 *    diventa una riga in «Da rifare», non un blocco della coda;
 *  - A approva, → avanti, ← indietro, X include nella selezione, shift+A
 *    approva la selezione: un tasto ciascuno, perché approvare è il verdetto
 *    normale ed è innocuo.
 *
 * RIFIUTARE NON È L'OPPOSTO DI APPROVARE, e questa schermata non deve
 * lasciarlo credere a nessuno. `rejected` sull'api esegue `purgePhoto`: i
 * volti, le copie E i byte originali vengono distrutti, senza annullamento e
 * senza una copia da nessuna parte. La parola è una trappola per chi arriva
 * dalla console precedente, dove il verdetto negativo era `blocked`, cioè
 * nascondere. Per questo R (e shift+R) solo CHIEDONO: aprono una conferma che
 * nomina quello che viene distrutto, e mentre è aperta ogni scorciatoia della
 * coda è inerte — nessun tasto da solo può confermare. Distruggere richiede
 * due gesti deliberati su quella finestra: spuntare la presa d'atto e premere
 * l'unico pulsante rosso della console.
 *
 * Rotte: `GET /v1/admin/moderation?albumId=&state=&includeNotMe=&cursor=` e
 * `POST /v1/admin/photos/:id/moderate { state }` (sezione C della specifica
 * v6). Ogni campo tranne l'id si legge in modo difensivo, così un nome
 * diverso perde un dettaglio invece della schermata.
 */

const PAGINA = 24;
/** Quante foto avanti vengono decodificate prima di servire. */
const AVANTI = 4;

type Verdetto = "approved" | "rejected";
type Fallita = { id: string; verdetto: Verdetto; messaggio: string };
type DaRifiutare = { ids: string[]; origine: "corrente" | "selezione" | "ritenta" };
type Filtro = "pending" | "reported" | "auto_rejected" | "rejected";

const FILTRI: { chiave: Filtro; nome: string }[] = [
  { chiave: "pending", nome: "In attesa" },
  { chiave: "reported", nome: "Segnalate" },
  { chiave: "auto_rejected", nome: "Scartate dallo screening" },
  { chiave: "rejected", nome: "Rifiutate" },
];

const MOTIVO: Record<string, string> = {
  inappropriate: "Contenuto inappropriato",
  copyright: "Diritto d'autore",
  other: "Altro motivo",
  not_me: "«Non sono io»",
};

/**
 * La richiesta di una pagina.
 *
 * «reported» NON si manda come `state`: l'enum dell'api è
 * pending/approved/rejected/auto_rejected e qualunque altra cosa risponde
 * 400, che questa schermata legge come «le rotte non ci sono». Senza `state`
 * la coda è già «tutto quello che un moderatore deve ancora guardare», foto
 * approvate con segnalazioni aperte incluse: Segnalate chiede esattamente
 * quello più `includeNotMe`, cioè le segnalazioni «non sono io» che l'api
 * lascia fuori per difetto.
 */
function richiesta(filtro: Filtro, albumId: string, cursore?: string | null): string {
  const q = new URLSearchParams({ limit: String(PAGINA) });
  if (filtro === "reported") q.set("includeNotMe", "true");
  else q.set("state", filtro);
  if (albumId) q.set("albumId", albumId);
  if (cursore) q.set("cursor", cursore);
  return q.toString();
}

/**
 * Le righe di una pagina, con l'id scritto come lo scrive l'api: la rotta
 * spedita manda `photoId`, la specifica diceva `id`, e leggerne uno solo
 * significava buttare ogni riga e vedere una coda vuota per sempre.
 */
function vociDi(dati: CodaModerazione): VoceModerazione[] {
  const elenco = dati.items ?? dati.photos ?? [];
  const righe: VoceModerazione[] = [];
  for (const riga of elenco) {
    const chiave = typeof riga?.id === "string" ? riga.id : typeof riga?.photoId === "string" ? riga.photoId : null;
    if (chiave) righe.push({ ...riga, id: chiave });
  }
  return righe;
}

const immagine = (v: VoceModerazione) => v.webUrl ?? v.thumbUrl ?? null;

export default function Moderazione() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();
  const { occupato } = usaInchiostro();

  const [album, setAlbum] = useState<Album[]>([]);
  const [albumId, setAlbumId] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("pending");
  const [coda, setCoda] = useState<VoceModerazione[]>([]);
  const [cursore, setCursore] = useState<string | null>(null);
  const [indice, setIndice] = useState(0);
  const [scelte, setScelte] = useState<Set<string>>(new Set());
  const [decise, setDecise] = useState(0);
  const [fallite, setFallite] = useState<Fallita[]>([]);
  const [daRifiutare, setDaRifiutare] = useState<DaRifiutare | null>(null);
  const [presaDatto, setPresaDatto] = useState(false);
  const [carico, setCarico] = useState(false);
  const [assente, setAssente] = useState(false);
  const [errore, setErrore] = useState("");

  const eventoId = evento?.id ?? "";

  useEffect(() => {
    if (!eventoId) return;
    let annullato = false;
    leggi<{ albums: Album[] }>(`/admin/events/${eventoId}/albums`)
      .then((d) => { if (!annullato) setAlbum(d.albums || []); })
      .catch(() => { if (!annullato) setAlbum([]); });
    return () => { annullato = true; };
  }, [eventoId]);

  // Ricarica da zero quando cambia un filtro. `carica` non è una dipendenza:
  // cambia con il cursore, e rimetterebbe la coda a capo a ogni pagina.
  useEffect(() => {
    if (!eventoId) return;
    let annullato = false;
    setCarico(true);
    setErrore("");
    setCursore(null);
    leggi<CodaModerazione>(`/admin/moderation?${richiesta(filtro, albumId)}`)
      .then((d) => {
        if (annullato) return;
        setAssente(false);
        setCoda(vociDi(d));
        setCursore(d.nextCursor ?? null);
        setIndice(0);
        setScelte(new Set());
      })
      .catch((e: unknown) => {
        if (annullato || guardia(e)) return;
        const s = stato(e);
        if (s === 404 || s === 400) { setAssente(true); setCoda([]); }
        else setErrore(messaggio(e, "Non riusciamo a leggere la coda."));
      })
      .finally(() => { if (!annullato) setCarico(false); });
    return () => { annullato = true; };
  }, [eventoId, filtro, albumId, guardia]);

  const altraPagina = useCallback(async () => {
    if (!cursore || !eventoId) return;
    try {
      const d = await leggi<CodaModerazione>(`/admin/moderation?${richiesta(filtro, albumId, cursore)}`);
      setCoda((righe) => [...righe, ...vociDi(d)]);
      setCursore(d.nextCursor ?? null);
    } catch (e) { guardia(e); }
  }, [cursore, eventoId, filtro, albumId, guardia]);

  const corrente = coda[indice] ?? null;

  // Le prossime si decodificano mentre si guarda questa.
  useEffect(() => {
    for (let avanti = 1; avanti <= AVANTI; avanti += 1) {
      const url = coda[indice + avanti] ? immagine(coda[indice + avanti]!) : null;
      if (!url) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = url;
    }
  }, [coda, indice]);

  /** Parte e non si aspetta: la coda avanza adesso. */
  const spedisci = useCallback((id: string, verdetto: Verdetto) => {
    void invia(`/admin/photos/${id}/moderate`, { state: verdetto }).catch((e: unknown) => {
      setFallite((righe) => [
        { id, verdetto, messaggio: messaggio(e, "Invio non riuscito.") },
        ...righe.slice(0, 19),
      ]);
    });
  }, []);

  /** Apre la conferma. Non manda niente e non toglie niente dalla coda. */
  const chiediRifiuto = useCallback((ids: string[], origine: DaRifiutare["origine"]) => {
    if (ids.length === 0) return;
    // La presa d'atto riparte sempre da spenta: è per questo rifiuto, non
    // per la sessione.
    setPresaDatto(false);
    setDaRifiutare({ ids, origine });
  }, []);

  const annullaRifiuto = useCallback(() => { setDaRifiutare(null); setPresaDatto(false); }, []);

  const applicaAllaCorrente = useCallback((verdetto: Verdetto, id: string) => {
    spedisci(id, verdetto);
    setCoda((righe) => righe.filter((r) => r.id !== id));
    setDecise((n) => n + 1);
    setIndice((v) => Math.min(v, Math.max(0, coda.length - 2)));
  }, [coda.length, spedisci]);

  const applicaAllaSelezione = useCallback((verdetto: Verdetto, ids: string[]) => {
    const giudicate = new Set(ids);
    for (const id of ids) spedisci(id, verdetto);
    setCoda((righe) => righe.filter((r) => !giudicate.has(r.id)));
    setDecise((n) => n + ids.length);
    setScelte((correnti) => {
      const dopo = new Set(correnti);
      for (const id of ids) dopo.delete(id);
      return dopo;
    });
    setIndice(0);
  }, [spedisci]);

  const giudica = useCallback((verdetto: Verdetto) => {
    if (!corrente) return;
    // Approvare è immediato; rifiutare è irreversibile, quindi chiede.
    if (verdetto === "rejected") { chiediRifiuto([corrente.id], "corrente"); return; }
    applicaAllaCorrente("approved", corrente.id);
  }, [applicaAllaCorrente, chiediRifiuto, corrente]);

  const giudicaSelezione = useCallback((verdetto: Verdetto) => {
    if (scelte.size === 0) return;
    const ids = [...scelte];
    if (verdetto === "rejected") { chiediRifiuto(ids, "selezione"); return; }
    applicaAllaSelezione("approved", ids);
  }, [applicaAllaSelezione, chiediRifiuto, scelte]);

  /**
   * L'unico percorso che manda `rejected`. Servono entrambi i cancelli: una
   * conferma aperta e la presa d'atto spuntata.
   */
  const confermaRifiuto = useCallback(() => {
    if (!daRifiutare || !presaDatto) return;
    const { ids, origine } = daRifiutare;
    setDaRifiutare(null);
    setPresaDatto(false);
    avvisa(
      ids.length === 1 ? "Rifiuto inviato." : `${numero(ids.length)} rifiuti inviati.`,
      "warning",
      "Originale e copie distrutti. Se l'invio non arriva, lo trovi in «Da rifare».",
    );
    if (origine === "ritenta") { for (const id of ids) spedisci(id, "rejected"); return; }
    if (origine === "corrente") { const primo = ids[0]; if (primo) applicaAllaCorrente("rejected", primo); return; }
    applicaAllaSelezione("rejected", ids);
  }, [applicaAllaCorrente, applicaAllaSelezione, avvisa, daRifiutare, presaDatto, spedisci]);

  const includi = useCallback((id?: string) => {
    const chiave = id ?? corrente?.id;
    if (!chiave) return;
    setScelte((correnti) => {
      const dopo = new Set(correnti);
      if (dopo.has(chiave)) dopo.delete(chiave); else dopo.add(chiave);
      return dopo;
    });
    if (!id) setIndice((v) => Math.min(v + 1, Math.max(0, coda.length - 1)));
  }, [corrente, coda.length]);

  /**
   * La tastiera: l'ascoltatore si attacca una volta e legge sempre l'ultima
   * versione del gestore da un riferimento. Se dipendesse dai verdetti si
   * staccherebbe e riattaccherebbe a ogni foto, e nel mezzo di quel cambio
   * una pressione di A andrebbe persa.
   */
  const tastiera = useRef<(e: KeyboardEvent) => void>(() => {});
  const gestore = (e: KeyboardEvent) => {
    if (daRifiutare) {
      // Una conferma è aperta: Esc la ritira, ogni altro tasto è inerte. Così
      // nessun tasto conferma una cancellazione e nessuna A o R scappata
      // passa sopra una domanda a cui il moderatore non ha risposto. Il
      // controllo sta PRIMA della guardia sui campi, così Esc funziona anche
      // mentre il fuoco è sulla casella di presa d'atto.
      if (e.key === "Escape") { e.preventDefault(); annullaRifiuto(); }
      return;
    }
    // Un pannello aperto è l'altra cosa che spegne la coda: se c'è una
    // facciata davanti, i tasti sono suoi.
    if (occupato) return;
    const bersaglio = e.target as HTMLElement | null;
    if (bersaglio && /^(INPUT|TEXTAREA|SELECT)$/.test(bersaglio.tagName)) return;
    const tasto = e.key.toLowerCase();
    if (tasto === "a" && e.shiftKey) { e.preventDefault(); giudicaSelezione("approved"); return; }
    if (tasto === "r" && e.shiftKey) { e.preventDefault(); giudicaSelezione("rejected"); return; }
    if (tasto === "a") { e.preventDefault(); giudica("approved"); return; }
    if (tasto === "r") { e.preventDefault(); giudica("rejected"); return; }
    if (tasto === "x") { e.preventDefault(); includi(); return; }
    if (e.key === "ArrowRight" || tasto === "j") {
      e.preventDefault();
      setIndice((v) => Math.min(v + 1, Math.max(0, coda.length - 1)));
      return;
    }
    if (e.key === "ArrowLeft" || tasto === "k") { e.preventDefault(); setIndice((v) => Math.max(0, v - 1)); }
  };

  useEffect(() => { tastiera.current = gestore; });

  useEffect(() => {
    const ascolta = (e: KeyboardEvent) => tastiera.current(e);
    window.addEventListener("keydown", ascolta);
    return () => window.removeEventListener("keydown", ascolta);
  }, []);

  // Una pagina di vantaggio: a quattro foto dalla fine chiede la prossima.
  useEffect(() => {
    if (cursore && !carico && coda.length - indice <= 4) void altraPagina();
  }, [indice, coda.length, cursore, carico, altraPagina]);

  const nomeAlbum = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of album) m.set(a.id, a.name);
    return m;
  }, [album]);

  if (!evento) return (<><Testa titolo="Moderazione" /><ServeUnEvento /></>);

  const segnalazioni = (v: VoceModerazione) => v.openReports ?? 0;

  return (
    <>
      <Testa
        titolo="Moderazione"
        dek={
          <>
            Approvare è un tasto e non fa danni. <strong>Rifiutare cancella la foto per sempre</strong>:
            originale, copie e volti, senza recupero. Non è «nascondi», e per questo nessun tasto da
            solo rifiuta.
          </>
        }
      />

      <div className="strumenti">
        <div className="tabs" role="tablist" aria-label="Stato della coda">
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
        <div className="strumenti__fine">
          <label className="campo-riga" htmlFor="album-coda">
            Album
            <select
              id="album-coda"
              className="select"
              style={{ width: "auto", minWidth: 160, height: "var(--control-h)" }}
              value={albumId}
              onChange={(e) => setAlbumId(e.target.value)}
            >
              <option value="">Tutti</option>
              {album.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      <p className="tasti" style={{ marginBottom: "var(--space-4)" }}>
        <b><Tasto>A</Tasto> approva</b>
        <b><Tasto>R</Tasto> chiede conferma</b>
        <b><Tasto>→</Tasto> avanti</b>
        <b><Tasto>←</Tasto> indietro</b>
        <b><Tasto>X</Tasto> includi</b>
        <b><Tasto>⇧</Tasto>+<Tasto>A</Tasto> approva le incluse</b>
      </p>

      {assente && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Callout genere="attention" ruolo="status">
            La coda risponderà quando le rotte della moderazione saranno in questo ambiente:
            questa schermata interroga <span className="mono">GET /v1/admin/moderation</span> e{" "}
            <span className="mono">POST /v1/admin/photos/:id/moderate</span>. Nessun altro percorso
            scrive al posto loro.
          </Callout>
        </div>
      )}
      {errore && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Callout genere="errore" ruolo="alert">{errore}</Callout>
        </div>
      )}

      <div className="moderazione">
        <div>
          {corrente ? (
            <div className="palco">
              {immagine(corrente) ? (
                <img className="palco__foto" src={immagine(corrente) as string} alt={corrente.filename ?? `Foto ${corto(corrente.id)}`} decoding="async" />
              ) : (
                <div className="palco__vuoto">Nessuna anteprima: il file non ha ancora una copia web.</div>
              )}
              <div className="palco__sotto">
                <span className="mono--id">{corto(corrente.id)}</span>
                <EsitoModerazione stato={corrente.moderationState} />
                <span>{quando(corrente.createdAt)}</span>
                {corrente.albumId && <span>{nomeAlbum.get(corrente.albumId) ?? corto(corrente.albumId)}</span>}
                {segnalazioni(corrente) > 0 && (
                  <span className="chip chip--attention">
                    {numero(segnalazioni(corrente))} segnalazioni
                  </span>
                )}
              </div>
              {(corrente.reasons?.length || corrente.notMeReports) && (
                <div className="palco__sotto">
                  {corrente.reasons?.map((m) => (
                    <Esito key={m} forma={m === "not_me" ? "non-pertinente" : "da-esaminare"}>
                      {MOTIVO[m] ?? m}
                    </Esito>
                  ))}
                  {corrente.notMeReports ? (
                    <span>
                      {numero(corrente.notMeReports)} «non sono io»: non contano verso la soglia, sono
                      il normale errore del riconoscimento.
                    </span>
                  ) : null}
                </div>
              )}
              <div className="palco__azioni">
                <Primario onClick={() => giudica("approved")}>Approva la foto (A)</Primario>
                <button
                  className="btn btn--danger"
                  type="button"
                  onClick={() => giudica("rejected")}
                  title="Chiede conferma: rifiutare cancella la foto per sempre"
                >
                  Rifiuta la foto… (R)
                </button>
                <button className="btn" type="button" onClick={() => includi()}>
                  {scelte.has(corrente.id) ? "Togli dalle incluse (X)" : "Includi nella selezione (X)"}
                </button>
                {scelte.size > 0 && (
                  <>
                    <span style={{ flex: 1 }} />
                    <button className="btn" type="button" onClick={() => giudicaSelezione("approved")}>
                      Approva le {numero(scelte.size)} incluse (⇧A)
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => giudicaSelezione("rejected")}
                      title="Chiede conferma: rifiutare cancella le foto per sempre"
                    >
                      Rifiuta le {numero(scelte.size)} incluse… (⇧R)
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : carico ? (
            <div className="palco"><div className="palco__vuoto"><span className="skel" style={{ width: 200 }} /></div></div>
          ) : !assente ? (
            <Vuoto titolo={filtro === "pending" ? "Niente da moderare" : "Nessuna foto con questo filtro"}>
              {filtro === "pending"
                ? "La coda è vuota: tutto quello che è arrivato ha già un verdetto. Resta aperta e si riempie da sé quando qualcuno segnala una foto."
                : <>Il filtro «{FILTRI.find((f) => f.chiave === filtro)?.nome}» non ha foto{albumId ? " in questo album" : ""}. Torna su «In attesa» per vedere cosa aspetta un verdetto.</>}
            </Vuoto>
          ) : null}
        </div>

        <div className="coda">
          <div className="coda__testa">
            <span>{numero(coda.length)} in coda</span>
            <span>·</span>
            <span>{numero(decise)} decise</span>
            {scelte.size > 0 && <span className="chip chip--accent">{numero(scelte.size)} incluse</span>}
          </div>
          <div className="coda__elenco">
            <div className="tbl-wrap">
              <table className="tbl">
                <caption className="sr-only">Le foto in coda: la riga corrente è quella sul palco, la spunta include la foto in un'azione di gruppo.</caption>
                <thead>
                  <tr>
                    <th className="tbl__check"><span className="sr-only">Includi</span></th>
                    <th>Foto</th>
                    <th>Arrivata</th>
                  </tr>
                </thead>
                <tbody>
                  {coda.map((v, i) => (
                    <tr
                      key={v.id}
                      className="riga--click"
                      /* «questa è la riga corrente» è un altro gesto da
                         «questa riga è inclusa»: la prima è lo sguardo, la
                         seconda è la spunta, e non si fondono. */
                      aria-selected={i === indice}
                      onClick={() => setIndice(i)}
                    >
                      <td className="tbl__check">
                        <span className="check">
                          <input
                            type="checkbox"
                            checked={scelte.has(v.id)}
                            onChange={() => includi(v.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Includi la foto ${corto(v.id)} nella selezione`}
                          />
                        </span>
                      </td>
                      <td>
                        <span className="mono--id">{corto(v.id)}</span>
                        {segnalazioni(v) > 0 && <span className="cell-sub">{numero(segnalazioni(v))} segnalazioni</span>}
                      </td>
                      <td>{giorno(v.createdAt)}</td>
                    </tr>
                  ))}
                  {coda.length === 0 && (
                    <tr><td colSpan={3} style={{ color: "var(--text-tertiary)" }}>{carico ? "Carico…" : "Vuota"}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {cursore && (
            <div className="tbl__fine">
              <button className="btn btn--sm" type="button" onClick={() => void altraPagina()}>Carica altre</button>
            </div>
          )}
        </div>
      </div>

      {fallite.length > 0 && (
        <div className="sezione">
          <div className="sezione__testa">
            <h2>Da rifare</h2>
            <p className="sezione__nota">
              Questi verdetti non sono arrivati all'api. Un rifiuto che non è arrivato non ha
              distrutto niente: ritentarlo è un nuovo atto irreversibile e passa dalla stessa
              conferma.
            </p>
          </div>
          <div className="tbl-wrap">
            <table className="tbl tbl--schede">
              <thead><tr><th>Foto</th><th>Verdetto</th><th>Motivo</th><th className="tbl__azioni">Azione</th></tr></thead>
              <tbody>
                {fallite.map((f) => (
                  <tr key={`${f.id}-${f.verdetto}`}>
                    <td data-et="Foto"><span className="mono--id">{corto(f.id)}</span></td>
                    <td data-et="Verdetto">{f.verdetto === "approved" ? "Approva" : "Rifiuta"}</td>
                    <td data-et="Motivo">{f.messaggio}</td>
                    <td className="tbl__azioni" data-et="Azione">
                      <button
                        className="btn btn--sm"
                        type="button"
                        onClick={() => f.verdetto === "rejected" ? chiediRifiuto([f.id], "ritenta") : spedisci(f.id, f.verdetto)}
                      >
                        {f.verdetto === "rejected" ? "Ritenta il rifiuto…" : "Ritenta"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* La conferma. È un dialogo e non un pannello: una domanda a cui si
          deve rispondere prima di continuare, e il browser tiene il fuoco
          dentro e la pagina inerte. */}
      <Finestra
        aperta={daRifiutare !== null}
        titolo={
          !daRifiutare ? ""
            : daRifiutare.ids.length === 1 ? "Cancellare questa foto per sempre?"
              : `Cancellare ${numero(daRifiutare.ids.length)} foto per sempre?`
        }
        onChiudi={annullaRifiuto}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!presaDatto}
            title={presaDatto ? undefined : "Spunta prima la presa d'atto: questa è l'unica azione della console che distrugge un file"}
            onClick={confermaRifiuto}
          >
            {Ico.cestino}
            {daRifiutare && daRifiutare.ids.length > 1
              ? `Cancella ${numero(daRifiutare.ids.length)} foto definitivamente`
              : "Cancella la foto definitivamente"}
          </button>
        }
      >
        <p>
          Rifiutare non nasconde: <strong>cancella</strong>. Vengono eliminati il file originale, le
          copie (anteprima e versione web) e i volti rilevati.{" "}
          <strong>L'operazione non si annulla</strong> e non resta nessuna copia da cui recuperare la
          foto.
        </p>
        <p className="motivo">
          Annulla non cambia niente: la foto resta nello stato in cui è adesso. Una foto «in attesa»
          è già fuori dall'album mentre aspetta un verdetto — rifiutare non serve a nasconderla,
          serve a cancellarla.
        </p>
        <ul className="finestra__cosa">
          {daRifiutare?.ids.map((x) => (
            <li key={x}>
              <span className="mono--id">{corto(x)}</span>
              <span>{coda.find((v) => v.id === x)?.filename ?? ""}</span>
            </li>
          ))}
        </ul>
        <label className="check">
          <input type="checkbox" checked={presaDatto} onChange={(e) => setPresaDatto(e.target.checked)} />
          <span>Ho capito: i file originali vengono cancellati e non si possono recuperare.</span>
        </label>
      </Finestra>
    </>
  );
}
