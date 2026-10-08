import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Screen, Callout, GlifoMotivo, IconOk, motivoSelfie } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";

/**
 * La galleria personale. Due comportamenti qui sono prescritti, non scelti, e
 * sono il motivo della forma della pagina.
 *
 * 1. «NON SONO IO» TOGLIE UNA FOTO SBAGLIATA PER QUELLA PERSONA SOLA.
 *    Scrive `gallery_feedback` con `verdict: "not_me"`. Non è una
 *    segnalazione e non tocca la foto di nessun altro: una foto di gruppo
 *    viene agganciata a dieci persone e nove di loro la rifiutano
 *    correttamente, quindi contarla come abuso trasformerebbe l'errore
 *    normale del riconoscimento in rimozioni globali.
 * 2. LE FOTO TOLTE VANNO IN UN GRUPPO «NASCOSTE», NON SPARISCONO. Chi tocca
 *    il bottone per sbaglio — e su un telefono capita — deve poter tornare
 *    indietro: dentro «Nascoste» il verso opposto è «Sono io» e riscrive il
 *    verdetto. Una cosa che sparisce senza traccia non si annulla.
 *
 * Il punteggio, dove si mostra, è un NUMERO più delle TACCHE (`.score`): mai
 * una tinta. Un numero da solo non dice se 83 è molto, le tacche lo dicono a
 * colpo d'occhio, e il colore non dice niente a chi non lo distingue. Si
 * mostra con `?debug=1` sulle celle (come da CONTRACTS.md) e sempre nel
 * visore, dove c'è lo spazio per leggerlo.
 *
 * La soglia 0,9 che divide «Le tue foto» da «Forse sei tu» è la stessa del
 * resto del sistema (CONTRACTS.md: il worker tiene da 0,8, la UI divide a
 * 0,9). Non è un numero di questa pagina.
 *
 * Niente animazione sull'apertura dei gruppi: aprire un gruppo è un filtro, e
 * sui filtri non c'è movimento. Il chevron del vecchio codice ruotava con una
 * transizione: via.
 */

type Item = {
  photoId: string;
  thumbUrl: string;
  webUrl: string;
  score: number;
  source: "match" | "attach";
  createdAt?: string;
  originalReady?: boolean;
  feedback?: "me" | "not_me" | null;
};
type Resp = {
  status: "empty" | "queued" | "ready";
  total: number;
  items: Item[];
  nextCursor: string | null;
  reason?: string | null;
};
type Variante = "original" | "web";

/** La soglia del sistema, non di questa pagina. */
const SICURO = 0.9;
const PAGINA = 60;
/** Tetto dello ZIP lato API: oltre, il primario si spegne e dice perché. */
const ZIP_MAX = 500;
const visitaKey = (slug: string) => `fom.visita.${slug}`;

const nf = new Intl.NumberFormat("it-IT");

export default function Galleria() {
  const slug = useParams().slug || EVENT_SLUG;
  const [sp] = useSearchParams();
  const [resp, setResp] = useState<Resp | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursore, setCursore] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [apriNascoste, setApriNascoste] = useState(false);
  const [apriForse, setApriForse] = useState(true);
  const [variante, setVariante] = useState<Variante>("original");
  const [avviso, setAvviso] = useState<{ testo: string; male?: boolean } | null>(null);
  const [visore, setVisore] = useState<number | null>(null);
  const ultimaVisita = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const idsRef = useRef<HTMLInputElement>(null);
  const varRef = useRef<HTMLInputElement>(null);
  const sentinella = useRef<HTMLDivElement>(null);
  const apritore = useRef<HTMLElement | null>(null);

  /* `?debug=1` resta acceso finché non si spegne con `?debug=0`. Serve in
     sala a chi tara le soglie, non alla persona. */
  const debug = useMemo(() => {
    try {
      const q = sp.get("debug");
      if (q === "1") localStorage.setItem("rephoto.debug", "1");
      if (q === "0") localStorage.removeItem("rephoto.debug");
      return localStorage.getItem("rephoto.debug") === "1";
    } catch {
      return sp.get("debug") === "1";
    }
  }, [sp]);

  useEffect(() => {
    try {
      ultimaVisita.current = Number(localStorage.getItem(visitaKey(slug))) || 0;
      localStorage.setItem(visitaKey(slug), String(Date.now()));
    } catch { /* un browser senza storage mostra solo una «Nuova» in meno */ }
  }, [slug]);

  /* Primo carico, e si continua a chiedere finché il confronto gira. */
  useEffect(() => {
    let fermo = false;
    const carica = async () => {
      try {
        const d = (await api.getGallery(slug, { limit: PAGINA })) as Resp;
        if (fermo) return;
        setResp(d);
        setItems(d.items || []);
        setCursore(d.nextCursor);
        if (d.status === "ready" || d.status === "empty") fermo = true;
      } catch { /* si riprova al giro dopo */ }
    };
    carica();
    const id = window.setInterval(() => { if (!fermo) carica(); }, 2500);
    return () => { fermo = true; window.clearInterval(id); };
  }, [slug]);

  /* Scorrimento infinito. */
  useEffect(() => {
    if (!cursore || !sentinella.current) return;
    const io = new IntersectionObserver(
      async (es) => {
        if (!es[0].isIntersecting || !cursore) return;
        try {
          const d = (await api.getGallery(slug, { limit: PAGINA, cursor: cursore })) as Resp;
          setItems((prec) => [...prec, ...(d.items || [])]);
          setCursore(d.nextCursor);
        } catch { /* la sentinella riproverà al prossimo incontro */ }
      },
      { rootMargin: "400px" },
    );
    io.observe(sentinella.current);
    return () => io.disconnect();
  }, [cursore, slug]);

  const gruppi = useMemo(() => {
    const nascoste = items.filter((i) => i.feedback === "not_me");
    const viste = items.filter((i) => i.feedback !== "not_me");
    return {
      nascoste,
      viste,
      sicure: viste.filter((i) => i.score >= SICURO),
      forse: viste.filter((i) => i.score < SICURO),
    };
  }, [items]);

  function parla(testo: string, male?: boolean) {
    setAvviso({ testo, male });
    window.setTimeout(() => setAvviso(null), 3200);
  }

  function commuta(id: string) {
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  /**
   * Il verdetto. Si scrive subito in pagina e si manda; se il server rifiuta,
   * si rimette come era e si dice che non è riuscito. Una foto che sembra
   * nascosta e non lo è sarebbe peggio di un'attesa.
   */
  async function verdetto(ids: string[], v: "me" | "not_me") {
    if (!ids.length) return;
    const prima = new Map(items.map((i) => [i.photoId, i.feedback ?? null]));
    setItems((p) => p.map((i) => (ids.includes(i.photoId) ? { ...i, feedback: v } : i)));
    setSel(new Set());
    try {
      for (const photoId of ids) {
        await api.raw(`/events/${slug}/gallery/feedback`, { method: "POST", json: { photoId, verdict: v } });
      }
      parla(
        v === "not_me"
          ? ids.length === 1 ? "Foto nascosta. La trovi in «Nascoste»." : `${nf.format(ids.length)} foto nascoste. Le trovi in «Nascoste».`
          : ids.length === 1 ? "Foto rimessa fra le tue." : `${nf.format(ids.length)} foto rimesse fra le tue.`,
      );
      if (v === "not_me") setApriNascoste(true);
    } catch {
      setItems((p) => p.map((i) => (ids.includes(i.photoId) ? { ...i, feedback: prima.get(i.photoId) ?? null } : i)));
      parla("Non è riuscito: la foto è ancora dov'era. Controlla la rete e riprova.", true);
    }
  }

  function avviaZip() {
    const ids = items.filter((i) => sel.has(i.photoId)).map((i) => i.photoId);
    if (!ids.length || ids.length > ZIP_MAX) return;
    if (!idsRef.current || !varRef.current || !formRef.current) return;
    idsRef.current.value = ids.join(",");
    varRef.current.value = variante;
    formRef.current.submit(); // scaricamento in streaming, navigazione same-origin
    parla("Scaricamento avviato.");
  }

  function apriVisore(id: string, da: HTMLElement | null) {
    const i = items.findIndex((x) => x.photoId === id);
    if (i < 0) return;
    apritore.current = da;
    setVisore(i);
  }
  function chiudiVisore() {
    setVisore(null);
    apritore.current?.focus();
  }

  const Cella = ({ it }: { it: Item }) => {
    const scelta = sel.has(it.photoId);
    const nuova = it.source === "attach" && it.createdAt ? Date.parse(it.createdAt) > ultimaVisita.current : false;
    const nascosta = it.feedback === "not_me";
    return (
      <div className="cella">
        <button
          type="button"
          className="cella__foto"
          aria-pressed={nascosta ? undefined : scelta}
          aria-label={nascosta ? "Foto nascosta" : scelta ? "Togli dalla selezione" : "Aggiungi alla selezione"}
          onClick={() => !nascosta && commuta(it.photoId)}
          disabled={nascosta}
        >
          <img src={it.thumbUrl} alt="" loading="lazy" />
        </button>
        {!nascosta && (
          <span className="cella__segno" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          </span>
        )}
        {nuova && <span className="chip chip--accent cella__nuova">Nuova</span>}
        <button
          type="button"
          className="btn btn--icon btn--sm cella__apri"
          aria-label="Apri la foto a tutto schermo"
          onClick={(e) => apriVisore(it.photoId, e.currentTarget)}
        >
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
          </svg>
        </button>
        {nascosta && (
          <div className="cella__dato">
            <button className="btn btn--link" type="button" onClick={() => verdetto([it.photoId], "me")}>
              Sono io
            </button>
          </div>
        )}
        {debug && !nascosta && (
          <div className="cella__dato">
            <Punteggio valore={it.score} />
            <span>{it.source === "attach" ? "aggiunta dopo" : "confronto"}</span>
          </div>
        )}
      </div>
    );
  };

  const stato = resp?.status;
  const motivo = motivoSelfie(resp?.reason);
  const troppe = sel.size > ZIP_MAX;

  return (
    <Screen wide dati>
      {/* La lista che arriva, nella forma che avrà. */}
      {(!resp || stato === "queued") && (
        <>
          {stato === "queued" && (
            <Callout variante="info">
              Il confronto sta ancora girando: le foto compaiono qui appena è finito.
            </Callout>
          )}
          <div className="griglia griglia--sotto" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="skel cella--attesa" />
            ))}
          </div>
        </>
      )}

      {/* Nessuna foto: l'esito è un motivo, con il suo glifo e il suo rimedio. */}
      {(stato === "empty" || (stato === "ready" && items.length === 0)) && (
        <div className="empty">
          <GlifoMotivo nome={motivo ? motivo.glifo : "volto"} />
          <h2>{motivo ? motivo.titolo : "Non ti abbiamo trovato in queste foto"}</h2>
          <p>
            {motivo
              ? motivo.rimedio
              : "Le foto vengono caricate man mano: ti avvisiamo per e-mail appena ce n'è una con te. Puoi anche riprovare con un primo piano più chiaro."}
          </p>
          {!motivo || motivo.glifo !== "attesa" ? (
            <Link className="btn btn--primary" to="/selfie">Fai un altro selfie</Link>
          ) : null}
        </div>
      )}

      {stato === "ready" && items.length > 0 && (
        <>
          {gruppi.sicure.length > 0 && (
            <section className="sezione">
              <div className="sezione__testa">
                <h2>Le tue foto</h2>
                <span className="chip"><b>{nf.format(gruppi.sicure.length)}</b></span>
              </div>
              <div className="griglia">
                {gruppi.sicure.map((it) => <Cella key={it.photoId} it={it} />)}
              </div>
            </section>
          )}

          {gruppi.forse.length > 0 && (
            <section className="sezione">
              <div className="sezione__testa">
                <button
                  className="sezione__apri"
                  type="button"
                  aria-expanded={apriForse}
                  onClick={() => setApriForse((v) => !v)}
                >
                  <h2>Forse sei tu</h2>
                  <Chevron aperto={apriForse} />
                </button>
                <span className="chip"><b>{nf.format(gruppi.forse.length)}</b></span>
              </div>
              {apriForse ? (
                <div className="griglia">
                  {gruppi.forse.map((it) => <Cella key={it.photoId} it={it} />)}
                </div>
              ) : (
                <p className="prosa">
                  Qui la somiglianza è più bassa: apri il gruppo e togli quelle in cui non sei tu.
                </p>
              )}
            </section>
          )}

          {/* Le foto toccate per sbaglio non spariscono: stanno qui, e da qui tornano. */}
          {gruppi.nascoste.length > 0 && (
            <section className="sezione">
              <div className="sezione__testa">
                <button
                  className="sezione__apri"
                  type="button"
                  aria-expanded={apriNascoste}
                  onClick={() => setApriNascoste((v) => !v)}
                >
                  <h2>Nascoste</h2>
                  <Chevron aperto={apriNascoste} />
                </button>
                <span className="chip"><b>{nf.format(gruppi.nascoste.length)}</b></span>
              </div>
              {apriNascoste ? (
                <div className="griglia">
                  {gruppi.nascoste.map((it) => <Cella key={it.photoId} it={it} />)}
                </div>
              ) : (
                <p className="prosa">
                  Le foto che hai detto non essere tue. Restano qui: se ne hai nascosta una per
                  sbaglio, aprila e tocca «Sono io».
                </p>
              )}
            </section>
          )}

          <div className="sentinella" ref={sentinella} />
        </>
      )}

      {/* --- La barra della selezione ---------------------------------------
          È una `.summary`: una riga di riepilogo con le azioni, non un
          secondo nero che galleggia, e non il foglio che saliva dal basso —
          quello nel sistema non esiste. Mentre il visore è aperto il primario
          della pagina scende a secondario: non ci sono due neri in vista. */}
      {sel.size > 0 && (
        <div className="summary barra-sel">
          <span className="barra-sel__n">{nf.format(sel.size)}</span>
          <span>selezionate</span>
          {/* Una casella, non un segmentato: un segmentato ha bordo e fondo
              propri e dentro la `.summary` sarebbe un riquadro dentro un
              riquadro. Ed è la forma giusta comunque — una scelta binaria
              che resta nella frase, come «includi i chiusi» in REGOLE.md §2.
              L'originale è il valore di partenza; questa è la deroga. */}
          <label className="check">
            <input
              type="checkbox"
              checked={variante === "web"}
              onChange={(e) => setVariante(e.target.checked ? "web" : "original")}
            />
            <span>Versioni più leggere</span>
          </label>
          <div className="barra-sel__fine">
            <button
              className="btn btn--danger"
              type="button"
              onClick={() => verdetto([...sel], "not_me")}
            >
              Non sono io
            </button>
            <button
              className={visore === null ? "btn btn--primary" : "btn"}
              type="button"
              onClick={avviaZip}
              disabled={troppe}
              title={troppe ? `Si scaricano al massimo ${nf.format(ZIP_MAX)} foto per volta` : undefined}
            >
              Scarica le foto
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => setSel(new Set())}>
              Annulla
            </button>
          </div>
          {troppe && (
            <span className="field__hint">
              Si scaricano al massimo {nf.format(ZIP_MAX)} foto per volta: togline qualcuna.
            </span>
          )}
        </div>
      )}

      {/* Lo ZIP è una navigazione in streaming, non una fetch. */}
      <form ref={formRef} method="post" action={api.zipAction(slug)} style={{ display: "none" }}>
        <input ref={idsRef} type="hidden" name="ids" />
        <input ref={varRef} type="hidden" name="variant" />
      </form>

      {/* Il toast dice «è fatto» DOPO il gesto. Il fondo resta inchiostro:
          cambia solo il glifo. */}
      {avviso && (
        <div className="toasts">
          <div className="toast" data-variante={avviso.male ? "error" : "success"}>
            <IconOk />
            <span>{avviso.testo}</span>
          </div>
        </div>
      )}

      {visore !== null && items[visore] && (
        <Visore
          slug={slug}
          items={items}
          indice={visore}
          debug={debug}
          onIndice={setVisore}
          onChiudi={chiudiVisore}
          onVerdetto={(id, v) => { verdetto([id], v); chiudiVisore(); }}
        />
      )}
    </Screen>
  );
}

/** Il punteggio: un numero e dodici tacche. Mai una tinta, e un dato assente
 *  è un trattino — non uno zero, che qui vorrebbe dire «nessuna somiglianza». */
function Punteggio({ valore }: { valore: number | null | undefined }) {
  if (typeof valore !== "number" || Number.isNaN(valore)) {
    return <span className="score"><span className="score__n">—</span></span>;
  }
  const su100 = Math.round(valore * 100);
  const accese = Math.max(0, Math.min(12, Math.round(valore * 12)));
  return (
    <span className="score" title={`Somiglianza ${nf.format(su100)} su 100`}>
      <span className="score__n">{nf.format(su100)}</span>
      <span className="score__bar" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => <i key={i} className={i < accese ? "on" : ""} />)}
      </span>
    </span>
  );
}

/** Nessuna transizione: aprire un gruppo è un filtro. */
function Chevron({ aperto }: { aperto: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {aperto ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}

/**
 * Il visore: una foto sola sul nero del sistema. I pulsanti sono `.btn`
 * normali — prima avevano un vetro sfocato sotto, e il vetro è vietato.
 * Esc chiude e il fuoco torna a chi l'ha aperto.
 */
function Visore({
  slug, items, indice, debug, onIndice, onChiudi, onVerdetto,
}: {
  slug: string;
  items: Item[];
  indice: number;
  debug: boolean;
  onIndice: (i: number) => void;
  onChiudi: () => void;
  onVerdetto: (photoId: string, v: "me" | "not_me") => void;
}) {
  const [inCorso, setInCorso] = useState(false);
  const it = items[indice]!;
  const haPrec = indice > 0;
  const haSucc = indice < items.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChiudi();
      else if (e.key === "ArrowLeft" && indice > 0) onIndice(indice - 1);
      else if (e.key === "ArrowRight" && indice < items.length - 1) onIndice(indice + 1);
    };
    window.addEventListener("keydown", onKey);
    const prima = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prima;
    };
  }, [indice, items.length, onIndice, onChiudi]);

  async function scarica() {
    if (inCorso) return;
    setInCorso(true);
    try {
      const r: any = await api.downloadUrls(slug, [it.photoId], "original");
      const url = r?.urls?.[0]?.url;
      if (url) window.open(url, "_blank", "noopener");
    } catch { /* una firma mancata lascia il visore dov'è */ }
    finally { setInCorso(false); }
  }

  return (
    <div className="visore" role="dialog" aria-modal="true" aria-label="Foto a tutto schermo">
      <div className="visore__scena">
        <img className="visore__foto" src={it.webUrl} alt="" />
        <button className="btn btn--icon visore__chiudi" type="button" aria-label="Chiudi" onClick={onChiudi}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <button className="btn btn--icon visore__prec" type="button" aria-label="Foto precedente" disabled={!haPrec} onClick={() => haPrec && onIndice(indice - 1)}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button className="btn btn--icon visore__succ" type="button" aria-label="Foto successiva" disabled={!haSucc} onClick={() => haSucc && onIndice(indice + 1)}>
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div className="visore__barra">
        <span className="visore__conta">
          {nf.format(indice + 1)} / {nf.format(items.length)}
        </span>
        {debug && <Punteggio valore={it.score} />}
        <div className="visore__fine">
          {/* Dentro «Nascoste» il verso si inverte: la stessa foto torna fra
              le tue. Un gesto che non si annulla non è un gesto. */}
          {it.feedback === "not_me" ? (
            <button className="btn" type="button" onClick={() => onVerdetto(it.photoId, "me")}>
              Sono io
            </button>
          ) : (
            <button className="btn btn--danger" type="button" onClick={() => onVerdetto(it.photoId, "not_me")}>
              Non sono io
            </button>
          )}
          <button
            className="btn btn--primary"
            type="button"
            onClick={scarica}
            disabled={inCorso}
            data-loading={inCorso || undefined}
          >
            {inCorso && <span className="btn-spin" aria-hidden="true" />}
            Scarica la foto
          </button>
        </div>
      </div>
    </div>
  );
}
