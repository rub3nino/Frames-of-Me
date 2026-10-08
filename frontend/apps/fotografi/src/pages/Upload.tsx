import { useEffect, useMemo, useRef, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";
import {
  Shell, Esito, Quota, Spin, nf, bytes,
  IconAvviso, IconCartella, IconOk, type EsitoTipo,
} from "../ui";
import { ApiError } from "../lib/net";
import {
  uploadOriginal, uploadWebStage, uploadOriginalStage, sha256Hex, contentTypeOf,
  UPLOAD_MAX_BYTES, type ImageType,
} from "../lib/upload";
import { renderWebJpeg, isWebRenderSupported, UnsupportedImageError } from "../lib/image-resize";
import {
  isFolderWatchSupported, pickFolder, ensurePermission, scanFolder, FolderPickCancelled,
} from "../lib/folder-watch";
import { useActiveEvent } from "../lib/event";

/**
 * Caricamento. È la pagina che un fotografo tiene aperta per ore mentre
 * l'evento va avanti, e l'unica domanda a cui deve rispondere in un colpo
 * d'occhio è: cosa è arrivato, cosa sta andando, cosa non è andato.
 *
 * Le regole che le danno questa forma, e non un'altra:
 *
 * 1. L'attesa sta DENTRO il pulsante che l'ha iniziata. Qui l'unica attesa
 *    con un pulsante davanti è la scelta della cartella (dialogo + prima
 *    lettura): la rotella gira lì. Il caricamento dei file non ha una
 *    rotella, ha una BARRA con i numeri veri accanto, perché un progresso
 *    noto non si racconta con un'animazione. Nessuna rotella a tutto
 *    schermo: la pagina resta usabile mentre carica.
 * 2. Lo scheletro (`.skel`) tiene il posto di un elenco che sta arrivando —
 *    la prima lettura della cartella — e non di un elenco vuoto, che ha
 *    invece una frase che dice perché è vuoto.
 * 3. I numeri del progresso sono tabulari, in formato italiano e interi: mai
 *    troncati, mai arrotondati a una cifra che nasconde il resto.
 * 4. Niente griglia di numeri grandi: i conteggi stanno su una riga
 *    (`.summary`), e la copertura della coda è un numero più dei segni.
 * 5. Nessuno stato è solo colore. Un file non inviato ha una FORMA e una
 *    PAROLA, e il rosso è riservato a ciò che da qui non si può rimediare
 *    (formato sbagliato, file troppo grande, nome non valido). Un guasto di
 *    rete è ambra: «guarda qui», non «è finita».
 * 6. Riprovare è un gesto deliberato. Niente ritentativi automatici: la coda
 *    non si riaccende da sola, e il pulsante dice che cosa rimette in coda.
 */

const CONC = 4;
const WATCH_INTERVAL_MS = 10_000;
const WEB_FIRST_KEY = "rephoto.webFirst";
/** Oltre questo numero la tabella non cresce: nessuno legge 800 righe. */
const RIGHE_MAX = 200;

type Stato = "coda" | "impronta" | "preparo" | "invio" | "web-inviata" | "fatta" | "presente" | "guasto";

/** Un guasto dice COSA, PERCHÉ e COME si rimedia. Senza le tre cose non è un
 *  messaggio d'errore, è un allarme. */
type Guasto = { parola: string; perche: string; rimedio: string; ritentabile: boolean };

type Item = {
  id: string; file: File; name: string; size: number; type: ImageType;
  stato: Stato; inviati: number; daInviare: number;
  guasto?: Guasto;
  photoId?: string; webFatta?: boolean; // per riprendere dalla fase originale
};

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
let seq = 0;

const PAROLA: Record<Stato, string> = {
  coda: "In coda",
  impronta: "Calcolo l'impronta",
  preparo: "Preparo la versione web",
  invio: "In invio",
  "web-inviata": "Web arrivata",
  fatta: "Caricata",
  presente: "Già presente",
  guasto: "Non inviata",
};

const FORMA: Record<Stato, EsitoTipo> = {
  coda: "spento",
  impronta: "corso",
  preparo: "corso",
  invio: "corso",
  "web-inviata": "corso",
  fatta: "fatto",
  presente: "spento",
  guasto: "attesa",
};

/** Traduce un errore in un guasto leggibile. Quello che il fotografo può
 *  rimediare da qui è ambra e si riprova; quello che no è rosso e dice come
 *  uscirne (riesportare il file, chiamare lo staff). */
function leggiGuasto(e: unknown, webFatta: boolean): Guasto {
  const riprendi = webFatta
    ? "Riprova: riparte dall'originale, la versione web è già arrivata."
    : "Riprova: riparte dalla parte che si è interrotta, non da zero.";

  if (e instanceof ApiError) {
    if (e.status === 403) return {
      parola: "Non consentita", ritentabile: false,
      perche: "Il tuo accesso non è abilitato a caricare per questo evento.",
      rimedio: "Chiedi allo staff di aggiungerti all'evento, poi ricarica la pagina.",
    };
    if (e.status === 413) return {
      parola: "Da scartare", ritentabile: false,
      perche: "Il server ha rifiutato il file perché troppo grande.",
      rimedio: "Esportalo sotto i 60 MB e rimettilo nella cartella.",
    };
    if (e.status === 422 || e.status === 400) return {
      parola: "Da scartare", ritentabile: false,
      perche: `Il server ha rifiutato il file: ${e.message}.`,
      rimedio: "Riesportalo in JPEG dalla scheda e rimettilo nella cartella.",
    };
    if (e.status === 429) return {
      parola: "Non inviata", ritentabile: true,
      perche: "Troppi caricamenti insieme: il server ha chiesto di rallentare.",
      rimedio: "Riprova tra un minuto: la coda riparte da dove si era fermata.",
    };
    if (e.status >= 500) return {
      parola: "Non inviata", ritentabile: true,
      perche: `Il server ha risposto con un errore (${e.status}).`,
      rimedio: riprendi,
    };
    return { parola: "Non inviata", ritentabile: true, perche: e.message, rimedio: riprendi };
  }

  if (e instanceof UnsupportedImageError) return {
    parola: "Da scartare", ritentabile: false,
    perche: "Questo browser non riesce ad aprire l'immagine: è un formato che non legge o il file è corrotto.",
    rimedio: "Riesportalo in JPEG, oppure spegni «Prima il web» per inviare l'originale così com'è.",
  };

  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "TimeoutError") return {
    parola: "Non inviata", ritentabile: true,
    perche: "Una parte del file non è arrivata entro due minuti: la rete dell'evento è lenta o satura.",
    rimedio: riprendi,
  };
  if (err?.name === "AbortError") return {
    parola: "Interrotta", ritentabile: true,
    perche: "Il caricamento è stato interrotto.",
    rimedio: riprendi,
  };
  return {
    parola: "Non inviata", ritentabile: true,
    perche: err?.message || "La connessione si è interrotta durante l'invio.",
    rimedio: riprendi,
  };
}

export default function Upload() {
  const api = useMemo(() => createClient(), []);
  const { event } = useActiveEvent();
  const webSupportato = useMemo(() => isWebRenderSupported(), []);
  const cartellaSupportata = useMemo(() => isFolderWatchSupported(), []);

  const [files, setFiles] = useState<Item[]>([]);
  const [sopra, setSopra] = useState(false);
  const [vista, setVista] = useState<"tutti" | "guasti" | "corso" | "fatti">("tutti");
  const [nonAbilitato, setNonAbilitato] = useState(false);
  const [webFirst, setWebFirst] = useState<boolean>(() => {
    if (!webSupportato) return false;
    try { const v = localStorage.getItem(WEB_FIRST_KEY); return v === null ? true : v === "1"; } catch { return true; }
  });

  const eventIdRef = useRef<string | null>(null);
  const webFirstRef = useRef(webFirst);
  const coda = useRef<Item[]>([]);
  const attivi = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Cartella sorvegliata
  const [cartella, setCartella] = useState<string | null>(null);
  const [inAscolto, setInAscolto] = useState(false);
  const [cartellaMsg, setCartellaMsg] = useState<string | null>(null);
  const [cartellaAgg, setCartellaAgg] = useState(0);
  const [primaLettura, setPrimaLettura] = useState(false);
  const dirHandle = useRef<FileSystemDirectoryHandle | null>(null);
  const visti = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);

  useEffect(() => { if (event) eventIdRef.current = event.id; }, [event]);
  useEffect(() => { webFirstRef.current = webFirst; try { localStorage.setItem(WEB_FIRST_KEY, webFirst ? "1" : "0"); } catch {} }, [webFirst]);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const update = (id: string, patch: Partial<Item>) =>
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function lavora(item: Item) {
    const evId = eventIdRef.current;
    if (!evId) {
      update(item.id, { stato: "guasto", guasto: {
        parola: "In attesa dell'evento", ritentabile: true,
        perche: "L'evento non è ancora collegato: senza l'evento il server non sa dove mettere la foto.",
        rimedio: "Riprova tra qualche secondo: il collegamento all'evento si ritenta da solo.",
      } });
      return;
    }
    const onP = (l: number, t: number) => update(item.id, { inviati: l, daInviare: t });
    let webFatta = item.webFatta === true;
    try {
      // Ripresa: la versione web è già arrivata, riparte l'originale.
      if (webFatta && item.photoId) {
        update(item.id, { stato: "web-inviata", inviati: 0, daInviare: item.size, guasto: undefined });
        await uploadOriginalStage(item.file, item.photoId, evId, item.type, await sha256Hex(item.file), onP);
        update(item.id, { stato: "fatta", inviati: item.size, daInviare: item.size });
        return;
      }

      update(item.id, { stato: "impronta", guasto: undefined });
      const sha = await sha256Hex(item.file);

      if (webFirstRef.current && webSupportato) {
        let web;
        try {
          update(item.id, { stato: "preparo" });
          web = await renderWebJpeg(item.file);
        } catch (e) {
          // Se il browser non sa aprire l'immagine, l'originale parte comunque:
          // è un ripiego, non un errore da mostrare.
          if (e instanceof UnsupportedImageError) web = null;
          else throw e;
        }
        if (web) {
          update(item.id, { stato: "invio", inviati: 0, daInviare: web.blob.size });
          const esito = await uploadWebStage(item.file, web.blob, evId, item.type, sha, onP);
          webFatta = true;
          update(item.id, { stato: "web-inviata", inviati: 0, daInviare: item.size, photoId: esito.photoId, webFatta: true });
          await uploadOriginalStage(item.file, esito.photoId, evId, item.type, sha, onP);
          update(item.id, { stato: "fatta", inviati: item.size, daInviare: item.size });
          return;
        }
      }

      update(item.id, { stato: "invio", inviati: 0, daInviare: item.size });
      await uploadOriginal(item.file, evId, item.type, sha, onP);
      update(item.id, { stato: "fatta", inviati: item.size, daInviare: item.size });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Non è un guasto: la foto c'è già. Trattino neutro, non rosso.
        update(item.id, { stato: "presente" });
        return;
      }
      const guasto = leggiGuasto(e, webFatta);
      if (e instanceof ApiError && e.status === 403) setNonAbilitato(true);
      update(item.id, { stato: "guasto", guasto });
    }
  }

  function scorri() {
    while (attivi.current < CONC && coda.current.length) {
      const item = coda.current.shift()!;
      attivi.current++;
      lavora(item).finally(() => { attivi.current--; scorri(); });
    }
  }

  function aggiungi(list: FileList | File[]) {
    const buoni: Item[] = [];
    const scarti: Item[] = [];
    for (const file of Array.from(list)) {
      const type = contentTypeOf(file);
      const base: Item = {
        id: "f" + ++seq, file, name: file.name, size: file.size,
        type: type || "image/jpeg", stato: "coda", inviati: 0, daInviare: file.size,
      };
      // Questi tre non si riprovano: il file è sbagliato, non la rete. Rosso,
      // e il rimedio è un'azione fuori dal browser.
      if (!type) scarti.push({ ...base, stato: "guasto", guasto: {
        parola: "Da scartare", ritentabile: false,
        perche: "Non è un JPEG né un PNG: l'evento accetta solo questi due formati.",
        rimedio: "Esportalo in JPEG dalla scheda e rimettilo nella cartella.",
      } });
      else if (file.size < 1) scarti.push({ ...base, stato: "guasto", guasto: {
        parola: "Da scartare", ritentabile: false,
        perche: "Il file è di 0 byte: la copia dalla scheda non è finita.",
        rimedio: "Ricopialo dalla scheda, poi rimettilo nella cartella.",
      } });
      else if (file.size > UPLOAD_MAX_BYTES) scarti.push({ ...base, stato: "guasto", guasto: {
        parola: "Da scartare", ritentabile: false,
        perche: `Pesa ${bytes(file.size)}: il limite per foto è 60 MB.`,
        rimedio: "Esportalo a qualità più bassa, o riduci il lato lungo, e rimettilo nella cartella.",
      } });
      else buoni.push(base);
    }
    setFiles((fs) => [...fs, ...buoni, ...scarti]);
    coda.current.push(...buoni);
    scorri();
  }

  /** Riprovare è un gesto deliberato: nessun ritentativo automatico. */
  function riprova(item: Item) {
    const next: Item = { ...item, stato: "coda", inviati: 0, daInviare: item.size, guasto: undefined };
    update(item.id, next);
    coda.current.push(next);
    scorri();
  }

  function riprovaTutti() {
    const daRifare = files.filter((f) => f.stato === "guasto" && f.guasto?.ritentabile);
    if (!daRifare.length) return;
    const next = daRifare.map((f) => ({ ...f, stato: "coda" as Stato, inviati: 0, daInviare: f.size, guasto: undefined }));
    setFiles((fs) => fs.map((f) => next.find((n) => n.id === f.id) ?? f));
    coda.current.push(...next);
    scorri();
  }

  const c = useMemo(() => {
    const n = { coda: 0, corso: 0, fatte: 0, presenti: 0, guasti: 0, ritentabili: 0, origDovuti: 0 };
    let bInviati = 0;
    let bTotali = 0;
    for (const f of files) {
      bTotali += f.size;
      if (f.stato === "coda") n.coda++;
      else if (f.stato === "impronta" || f.stato === "preparo" || f.stato === "invio") n.corso++;
      else if (f.stato === "web-inviata") { n.corso++; n.origDovuti++; }
      else if (f.stato === "fatta") { n.fatte++; bInviati += f.size; }
      else if (f.stato === "presente") { n.presenti++; bInviati += f.size; }
      else if (f.stato === "guasto") { n.guasti++; if (f.guasto?.ritentabile) n.ritentabili++; }
    }
    return { ...n, bInviati, bTotali, chiusi: n.fatte + n.presenti };
  }, [files]);

  const mostrati = useMemo(() => {
    const dentro = (f: Item) =>
      vista === "tutti" ? true
      : vista === "guasti" ? f.stato === "guasto"
      : vista === "corso" ? (f.stato === "coda" || f.stato === "impronta" || f.stato === "preparo" || f.stato === "invio" || f.stato === "web-inviata")
      : (f.stato === "fatta" || f.stato === "presente");
    return files.filter(dentro);
  }, [files, vista]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setSopra(false);
    if (e.dataTransfer?.files?.length) aggiungi(e.dataTransfer.files);
  };

  // ---- Cartella sorvegliata ----------------------------------------------
  async function leggiCartella() {
    const h = dirHandle.current;
    if (!h) return;
    const ok = await ensurePermission(h);
    if (!ok) { setCartellaMsg("Il permesso sulla cartella non è stato concesso: senza quello non possiamo rileggerla."); fermaAscolto(); return; }
    let trovati: File[];
    try { trovati = await scanFolder(h); }
    catch (e: unknown) {
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        setCartellaMsg("Il permesso sulla cartella è stato revocato. Scegli di nuovo la cartella per riprendere.");
        fermaAscolto();
      }
      return;
    }
    const nuovi = trovati.filter((f) => contentTypeOf(f) && !visti.current.has(fileKey(f)));
    trovati.forEach((f) => visti.current.add(fileKey(f)));
    if (nuovi.length) { aggiungi(nuovi); setCartellaAgg((n) => n + nuovi.length); }
  }

  function avviaTimer() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => { void leggiCartella(); }, WATCH_INTERVAL_MS);
  }

  async function scegliCartella() {
    setCartellaMsg(null);
    try {
      const h = await pickFolder();
      dirHandle.current = h;
      visti.current = new Set();
      setCartella(h.name);
      setCartellaAgg(0);
      setInAscolto(true);
      setPrimaLettura(true);
      try { await leggiCartella(); } finally { setPrimaLettura(false); }
      avviaTimer();
    } catch (e) {
      if (e instanceof FolderPickCancelled) return;
      setCartellaMsg(e instanceof Error ? e.message : "Non è stato possibile aprire la cartella.");
    }
  }

  function pausaAscolto() { if (timer.current) window.clearInterval(timer.current); timer.current = null; setInAscolto(false); }
  function riprendiAscolto() { if (!dirHandle.current) return; setInAscolto(true); void leggiCartella(); avviaTimer(); }
  function fermaAscolto() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    dirHandle.current = null;
    visti.current = new Set();
    setInAscolto(false);
    setCartella(null);
  }

  return (
    <Shell
      titolo="Caricamento"
      dove={files.length ? `${nf(files.length)} file in questa sessione` : undefined}
      evento={event ? event.name : null}
      conteggi={{ "/upload": c.coda + c.corso, "/qualita": c.guasti }}
    >
      {/* Bloccante: da qui non si carica nulla. Questo è uno dei pochi rossi
          che la pagina può mostrare. */}
      {nonAbilitato && (
        <div className="callout callout--errore" role="alert">
          <IconAvviso />
          <span className="callout__text">
            <strong>Non sei abilitato a caricare per questo evento.</strong> I file in coda
            resteranno fermi. Chiedi allo staff di aggiungerti all'evento, poi ricarica la pagina.
          </span>
        </div>
      )}

      {/* Una riga di conteggi, non una griglia di numeri grandi. Finché non c'è
          niente in sessione la riga non si inventa degli zeri. */}
      {files.length > 0 && (
        <>
          <div className="summary">
            <span><b className="dato">{nf(c.chiusi)}</b> di <b className="dato">{nf(files.length)}</b> arrivate</span>
            <span><b className="dato">{nf(c.coda)}</b> in coda</span>
            <span><b className="dato">{nf(c.corso)}</b> in corso</span>
            {webFirst && <span><b className="dato">{nf(c.origDovuti)}</b> originali da inviare</span>}
            <span><b className="dato">{nf(c.presenti)}</b> già presenti</span>
            <span><b className="dato">{nf(c.guasti)}</b> non inviate</span>
            <Quota n={c.chiusi} su={files.length} suffisso="della sessione arrivato" />
          </div>

          {/* Progresso noto: una barra e i numeri veri accanto. */}
          <div className="totale">
            <div className="totale__barra">
              <span className="progress" aria-hidden="true">
                <i style={{ width: (c.bTotali ? (c.bInviati / c.bTotali) * 100 : 0) + "%" }} />
              </span>
              <span className="totale__n">{bytes(c.bInviati)} di {bytes(c.bTotali)}</span>
            </div>
          </div>
        </>
      )}

      {/* Il primario della schermata sta dove avviene il gesto. */}
      <div
        className="dropzone"
        data-over={sopra || undefined}
        onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setSopra(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => { if (--dragDepth.current <= 0) setSopra(false); }}
        onDrop={onDrop}
      >
        <strong className="dropzone__t">Trascina qui le foto</strong>
        <button className="btn btn--primary" type="button" onClick={() => inputRef.current?.click()}>
          Scegli i file da caricare
        </button>
        <input
          ref={inputRef} type="file" accept="image/jpeg,image/png" multiple hidden
          onChange={(e) => { if (e.target.files) aggiungi(e.target.files); e.currentTarget.value = ""; }}
        />
        <span className="nota-min">
          JPEG o PNG · fino a 60 MB per foto · i duplicati si saltano da soli
          {event ? "" : " · sto collegando l'evento"}
        </span>
      </div>

      {/* Un interruttore, non una casella: accende una modalità con effetto
          immediato e reversibile. Lo stato si legge dal pomello e dalla parola. */}
      <div className="box">
        <div className="box__body">
          <label className="switch-row">
            <span className="switch">
              <input
                type="checkbox" checked={webFirst} disabled={!webSupportato}
                onChange={(e) => setWebFirst(e.target.checked)}
              />
              <span className="switch__track" />
            </span>
            <span>
              <strong>Prima il web, poi gli originali</strong>
              <span className="cell-sub">
                {webSupportato
                  ? (webFirst
                      ? "Acceso: la versione web (lato lungo 1600 px) parte subito ed è cercabile in pochi secondi; l'originale la segue."
                      : "Spento: parte direttamente l'originale, e la foto diventa cercabile quando l'intero file è arrivato.")
                  : "Non disponibile: questo browser non sa ridimensionare le immagini, quindi partono gli originali."}
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* Cartella sorvegliata */}
      <div className="box">
        <div className="box__head">Cartella sorvegliata</div>
        <div className="box__body">
          <div className="guarda">
            <span className="nota">
              Scegli la cartella dove la macchina scarica: viene riletta ogni 10 secondi e i nuovi
              JPEG e PNG partono da soli.
            </span>
            {cartellaSupportata && !cartella && (
              <span className="guarda__fine">
                {/* L'attesa (dialogo + prima lettura) gira dentro questo pulsante. */}
                <button
                  className="btn" type="button" onClick={() => void scegliCartella()}
                  disabled={primaLettura} data-loading={primaLettura || undefined}
                >
                  {primaLettura ? <Spin /> : <IconCartella />}
                  {primaLettura ? "Leggo la cartella" : "Scegli la cartella"}
                </button>
              </span>
            )}
          </div>

          {/* Dentro un riquadro si separa con una linea, non con un altro
              riquadro: questa spiegazione è prosa, non un callout. */}
          {!cartellaSupportata && (
            <div className="guarda">
              <span className="nota-min">
                Qui non è disponibile: solo Chrome ed Edge sanno rileggere una cartella. Su questo
                browser trascina le foto o usa «Scegli i file da caricare».
              </span>
            </div>
          )}

          {cartella && (
            <div className="guarda">
              {inAscolto
                ? <Esito tipo="corso">In ascolto</Esito>
                : <Esito tipo="spento">In pausa</Esito>}
              <span className="nomefile" title={cartella}>{cartella}</span>
              <span className="nota-min dato">{nf(cartellaAgg)} file presi da qui</span>
              <span className="guarda__fine">
                {inAscolto
                  ? <button className="btn btn--sm btn--ghost" type="button" onClick={pausaAscolto}>Metti in pausa</button>
                  : <button className="btn btn--sm btn--ghost" type="button" onClick={riprendiAscolto}>Riprendi l'ascolto</button>}
                <button className="btn btn--sm btn--ghost" type="button" onClick={fermaAscolto}>Lascia la cartella</button>
              </span>
            </div>
          )}

        </div>
      </div>

      {/* Il permesso perso ferma la lettura: è «guarda qui», e il callout sta
          in pagina — non dentro il riquadro — con l'azione che lo risolve. */}
      {cartellaMsg && (
        <div className="callout callout--attention" role="status">
          <IconAvviso />
          <span className="callout__text">{cartellaMsg}</span>
          {cartellaSupportata && (
            <button
              className="btn btn--sm" type="button" onClick={() => void scegliCartella()}
              disabled={primaLettura} data-loading={primaLettura || undefined}
            >
              {primaLettura && <Spin />}
              Scegli di nuovo la cartella
            </button>
          )}
        </div>
      )}

      {/* «Guarda qui» è ambra, non rosso: questi file si recuperano. E si
          recuperano con un gesto, mai da soli. */}
      {c.ritentabili > 0 && (
        <div className="callout callout--attention" role="status">
          <IconAvviso />
          <span className="callout__text">
            <strong>{nf(c.ritentabili)} {c.ritentabili === 1 ? "foto non è partita" : "foto non sono partite"}.</strong>{" "}
            Ognuna dice sotto che cosa è andato storto. Il caricamento riprende dalla parte
            interrotta, non da zero.
          </span>
          <button className="btn btn--sm" type="button" onClick={riprovaTutti}>
            Rimetti in coda {c.ritentabili === 1 ? "la foto" : `le ${nf(c.ritentabili)} foto`}
          </button>
        </div>
      )}

      <div className="sez">
        <h2>La coda</h2>
        <span className="sez__n">
          {files.length ? `${nf(mostrati.length)} di ${nf(files.length)} file` : "nessun file"}
        </span>
      </div>

      {files.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Filtra la coda">
          {([
            ["tutti", "Tutti", files.length],
            ["corso", "In corso", c.coda + c.corso],
            ["guasti", "Non inviate", c.guasti],
            ["fatti", "Arrivate", c.chiusi],
          ] as const).map(([k, label, n]) => (
            <button
              key={k} className="tab" type="button" role="tab"
              aria-selected={vista === k} onClick={() => setVista(k)}
            >
              {label} <span className="chip"><b>{nf(n)}</b></span>
            </button>
          ))}
        </div>
      )}

      {/* Lo scheletro tiene il posto dell'elenco che sta arrivando dalla prima
          lettura della cartella. Un elenco vuoto, invece, dice perché è vuoto. */}
      {primaLettura && files.length === 0 ? (
        <div className="tbl-wrap">
          <div className="skel-righe" aria-hidden="true">
            <div className="skel" /><div className="skel" /><div className="skel" />
            <div className="skel" /><div className="skel" />
          </div>
          <span className="sr-only" role="status">Sto leggendo la cartella.</span>
        </div>
      ) : mostrati.length === 0 ? (
        <div className="empty">
          <IconOk />
          <h2>{files.length === 0 ? "Niente in coda" : "Niente in questo elenco"}</h2>
          <p>
            {files.length === 0
              ? "Trascina le foto qui sopra, scegli i file, oppure fai sorvegliare la cartella dove scarica la macchina: i nuovi scatti partiranno da soli."
              : "Cambia filtro per vedere gli altri file di questa sessione."}
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col" className="num">Peso</th>
                <th scope="col">Stato</th>
                <th scope="col">Avanzamento</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {mostrati.slice(0, RIGHE_MAX).map((f) => {
                const inCorso = f.stato === "invio" || f.stato === "web-inviata";
                const pct = f.daInviare ? Math.round((f.inviati / f.daInviare) * 100) : 0;
                return (
                  <tr key={f.id}>
                    <td>
                      <span className="nomefile" title={f.name}>{f.name}</span>
                      {f.guasto && (
                        <span className="cell-sub">{f.guasto.perche} {f.guasto.rimedio}</span>
                      )}
                    </td>
                    <td className="num" data-etichetta="Peso">{bytes(f.size)}</td>
                    <td data-etichetta="Stato">
                      {/* Forma e parola. Il rombo rosso solo su ciò che da qui
                          non si rimedia; l'ambra su ciò che si riprova. */}
                      <Esito tipo={f.stato === "guasto" && !f.guasto?.ritentabile ? "bloccato" : FORMA[f.stato]}>
                        {f.stato === "guasto" ? (f.guasto?.parola ?? PAROLA.guasto) : PAROLA[f.stato]}
                      </Esito>
                    </td>
                    <td data-etichetta="Avanzamento">
                      {inCorso ? (
                        <span className="avanz">
                          <span className="progress progress--sm" aria-hidden="true">
                            <i style={{ width: pct + "%" }} />
                          </span>
                          <span className="avanz__n">
                            {f.stato === "web-inviata" ? "originale " : ""}
                            {nf(pct)} % · {bytes(f.inviati)} di {bytes(f.daInviare)}
                          </span>
                        </span>
                      ) : f.stato === "fatta" ? (
                        <span className="avanz__n">{bytes(f.size)} inviati</span>
                      ) : (
                        <span className="avanz__n">—</span>
                      )}
                    </td>
                    <td className="tbl__fine">
                      {f.stato === "guasto" && f.guasto?.ritentabile && (
                        <button className="btn btn--sm" type="button" onClick={() => riprova(f)}>
                          Riprova
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {mostrati.length > RIGHE_MAX && (
            <div className="tbl__piu">
              <span className="nota-min">
                Mostro i primi <span className="dato">{nf(RIGHE_MAX)}</span> file di{" "}
                <span className="dato">{nf(mostrati.length)}</span>. Gli altri scorrono in coda
                senza bisogno che tu li guardi; se qualcosa non parte lo trovi in «Non inviate».
              </span>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
