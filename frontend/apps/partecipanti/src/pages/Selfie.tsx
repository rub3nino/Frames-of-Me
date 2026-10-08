import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Screen, Callout, GlifoMotivo, motivoSelfie } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";
import {
  CHALLENGE_STEPS, LivenessError, STEP_LABELS, cameraSupported,
  loadLandmarker, openCamera, runChallenge, stopStream, type ChallengeStep,
} from "../lib/liveness";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

/**
 * Il selfie. La schermata con più stati di tutta l'app, e la regola che la
 * governa è una sola: NESSUNO STATO È SOLO COLORE. Ogni stato ha una forma e
 * una parola, e un rifiuto dice che cosa fare di diverso — non «non valido».
 *
 * Gli stati, e da dove ognuno si sa davvero:
 *
 * - DAL BROWSER, mentre la camera è aperta: sto aprendo la camera; il passo
 *   da fare (guarda, gira a sinistra, gira a destra, sbatti le palpebre) con
 *   le tacche di `.mini-tappe` e la parola in una regione viva; tempo scaduto;
 *   camera negata o assente; file di formato sbagliato.
 * - DAL SERVER, dopo l'invio: nessun volto, volto troppo piccolo, foto
 *   sfocata o scura, più di una persona. Questi quattro NON si possono sapere
 *   qui: il landmarker gira con `numFaces: 1` e non misura la qualità, quindi
 *   inventarli lato client vorrebbe dire mentire. Arrivano in `reason` da
 *   `GET /v1/events/:slug/gallery` (CONTRACTS.md), e questa pagina li RILEGGE
 *   all'ingresso: chi torna a rifare il selfie trova scritto, sopra la
 *   camera, perché il precedente non è andato e cosa cambiare. Ogni motivo ha
 *   il suo glifo, non la sua tinta.
 * - MENTRE SI ASPETTA un clic già fatto: `.btn-spin` DENTRO il bottone che ha
 *   iniziato l'attesa. Non uno scheletro al posto del bottone, non uno
 *   spinner a tutto schermo.
 *
 * Il consenso: un adulto lo dà qui. Un minore NON lo dà qui — l'ha dato chi
 * ne ha la responsabilità, e chiederglielo di nuovo sarebbe far firmare a un
 * quindicenne una cosa che non può autorizzare. Se il segno del genitore non
 * c'è, questa pagina NON apre la camera: senza quel consenso il volto non si
 * cerca, e il cancello è qui perché il server non ha ancora la rotta.
 */

const CONSENSO_VERSIONE = "2026-10-08";
const CONSENSO_TESTO =
  "Acconsento al confronto del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca; un modello numerico del mio volto resta per la durata dell'evento, solo per agganciare le foto caricate in seguito, e viene cancellato con le foto. Le foto restano disponibili per 90 giorni.";

type Fase = "consenso" | "ripresa";
type Provenienza = "challenge" | "file";
const isImage = (f: File) => f.type === "image/jpeg" || f.type === "image/png";

export default function Selfie() {
  const nav = useNavigate();
  const minore = sessionStorage.getItem("fom.minore") === "1";
  const consensoGenitore = sessionStorage.getItem("fom.consenso-genitore");

  /* Per un minore il consenso c'è già: si parte dalla ripresa. */
  const [fase, setFase] = useState<Fase>(minore && consensoGenitore ? "ripresa" : "consenso");
  const [accettato, setAccettato] = useState(false);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [provenienza, setProvenienza] = useState<Provenienza>("file");
  const [anteprima, setAnteprima] = useState<string | null>(null);
  const [modo, setModo] = useState<"camera" | "file">(cameraSupported() ? "camera" : "file");
  const [motivoCamera, setMotivoCamera] = useState("");
  const [tentativo, setTentativo] = useState(0);
  /* Il motivo del selfie precedente, letto dal server una volta sola. */
  const [motivoPrec, setMotivoPrec] = useState<ReturnType<typeof motivoSelfie>>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (anteprima) URL.revokeObjectURL(anteprima); }, [anteprima]);

  /* Perché il selfie precedente non è andato. Una chiamata, all'ingresso.
     `no_photos_yet` non è un rifiuto: il selfie era buono, mancano le foto. */
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const g: any = await api.getGallery(EVENT_SLUG, { limit: 1 });
        if (!vivo || g?.status === "queued") return;
        const m = motivoSelfie(g?.reason);
        if (m && g?.reason !== "no_photos_yet") setMotivoPrec(m);
      } catch { /* senza galleria la pagina funziona comunque */ }
    })();
    return () => { vivo = false; };
  }, []);

  async function salvaConsenso(e: React.FormEvent) {
    e.preventDefault();
    if (!accettato || inCorso) return;
    setInCorso(true);
    setErrore("");
    try {
      await api.giveConsent(EVENT_SLUG, CONSENSO_VERSIONE, true);
      setFase("ripresa");
    } catch (err: any) {
      if (err?.status === 401) setErrore("La sessione è scaduta. Torna all'accesso ed entra di nuovo.");
      else setErrore("Non è stato possibile registrare il consenso. Riprova; se continua, chiedi al banco dell'evento.");
    } finally {
      setInCorso(false);
    }
  }

  function scegli(prossimo: File | null, da: Provenienza) {
    if (anteprima) URL.revokeObjectURL(anteprima);
    if (!prossimo) { setFile(null); setAnteprima(null); return; }
    if (!isImage(prossimo)) {
      setErrore("Questo file non è una foto: serve un jpeg o un png. Se l'hai scaricata da una chat, riscattala con la camera.");
      return;
    }
    setErrore("");
    setMotivoPrec(null);
    setFile(prossimo);
    setProvenienza(da);
    setAnteprima(URL.createObjectURL(prossimo));
  }

  async function invia(e: React.FormEvent) {
    e.preventDefault();
    if (!file || inCorso) return;
    setInCorso(true);
    setErrore("");
    try {
      await api.sendSelfie(EVENT_SLUG, file, provenienza, file.name);
      nav("/attesa");
    } catch (err: any) {
      const stato = err?.status;
      if (stato === 401) setErrore("La sessione è scaduta. Torna all'accesso ed entra di nuovo.");
      else if (stato === 429) setErrore("Hai già cercato più volte di seguito. Aspetta qualche minuto e riprova: le foto non si perdono.");
      else if (stato === 413) setErrore("La foto è troppo grande. Riscattala con la camera invece di scegliere un file dalla galleria.");
      else setErrore("Non è stato possibile inviare il selfie. Controlla la rete e riprova.");
      setInCorso(false);
    }
  }

  /* --- Il cancello del minore ---------------------------------------------
     Senza il consenso di chi ha la responsabilità non si apre nemmeno la
     camera. Rosso: è un errore che blocca il lavoro, non un «guarda qui». */
  if (minore && !consensoGenitore) {
    return (
      <Screen center>
        <div className="colonna">
          <h1 className="titolo">Serve il consenso di un genitore</h1>
          <Callout variante="errore">
            Hai dichiarato di avere tra 14 e 17 anni. Finché un genitore o chi ti tutela non
            conferma, non cerchiamo il tuo volto in nessuna foto.
          </Callout>
          <Link className="btn btn--primary btn--block" to="/consenso-genitore">
            Apri il consenso del genitore
          </Link>
          <p className="nota">
            La conferma la dà un adulto, su questo telefono o sul suo. Dura un minuto.
          </p>
        </div>
      </Screen>
    );
  }

  /* --- Il consenso dell'adulto -------------------------------------------- */
  if (fase === "consenso") {
    return (
      <Screen dati>
        <form className="colonna" onSubmit={salvaConsenso}>
          <header className="gruppo">
            <h1 className="titolo">Fai un selfie</h1>
            <p className="dek">Serve solo a trovarti tra le foto dell'evento.</p>
          </header>

          <label className="check accesso__consenso">
            <input
              type="checkbox"
              checked={accettato}
              onChange={(e) => setAccettato(e.target.checked)}
            />
            <span>{CONSENSO_TESTO}</span>
          </label>

          <Callout variante="info">
            Il file del selfie si cancella subito dopo la ricerca. Puoi revocare il consenso
            quando vuoi da «I miei dati».
          </Callout>

          {errore && <Callout variante="errore">{errore}</Callout>}

          <button
            className="btn btn--primary btn--block"
            type="submit"
            disabled={!accettato || inCorso}
            data-loading={inCorso || undefined}
            title={!accettato ? "Serve il consenso per cercare il tuo volto" : undefined}
          >
            {inCorso && <span className="btn-spin" aria-hidden="true" />}
            {modo === "camera" ? "Acconsento e apro la camera" : "Acconsento e scelgo una foto"}
          </button>
          {!accettato && (
            <span className="field__hint">Serve il consenso per cercare il tuo volto.</span>
          )}
        </form>
      </Screen>
    );
  }

  /* --- La ripresa ---------------------------------------------------------- */
  const inSfida = modo === "camera" && !file;
  return (
    <Screen dati>
      <div className="colonna">
        <header className="gruppo">
          <h1 className="titolo">Fai un selfie</h1>
          <p className="dek">
            {inSfida
              ? "Segui le indicazioni: lo scatto parte da solo, non devi premere niente."
              : "Un primo piano, da solo, con la luce davanti."}
          </p>
        </header>

        {minore && consensoGenitore && (
          <Callout variante="info">
            Il consenso per te l'ha già dato un genitore. Non serve darlo di nuovo.
          </Callout>
        )}

        {/* Perché il precedente non è andato, e cosa cambiare. Ambra: non è un
            errore bloccante, è «guarda qui, fai così». Il glifo cambia con il
            motivo, così due rifiuti diversi non sono la stessa tinta. */}
        {motivoPrec && (
          <Callout variante="attention" glifo={<GlifoMotivo nome={motivoPrec.glifo} piccolo />}>
            <b>{motivoPrec.titolo}.</b> {motivoPrec.rimedio}
          </Callout>
        )}

        {motivoCamera && <Callout variante="attention">{motivoCamera}</Callout>}
        {errore && <Callout variante="errore">{errore}</Callout>}

        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png"
          capture="user"
          onChange={(e) => scegli(e.target.files?.[0] ?? null, "file")}
        />

        {inSfida && (
          <Sfida
            key={tentativo}
            onScatto={(blob) => scegli(new File([blob], "selfie.jpg", { type: "image/jpeg" }), "challenge")}
            onRinuncia={(perche) => { setModo("file"); setMotivoCamera(perche); scegli(null, "file"); }}
          />
        )}

        {anteprima && (
          <div className="ripresa">
            <div className="ripresa__quadro">
              <img src={anteprima} alt="Anteprima del selfie" />
            </div>
          </div>
        )}

        {/* L'unico primario, e dice verbo + oggetto. Lo spinner sta dentro. */}
        {file ? (
          <>
            <button
              className="btn btn--primary btn--block"
              type="button"
              onClick={invia}
              disabled={inCorso}
              data-loading={inCorso || undefined}
            >
              {inCorso && <span className="btn-spin" aria-hidden="true" />}
              Trova le mie foto
            </button>
            <button
              className="btn btn--link"
              type="button"
              onClick={() => {
                scegli(null, "file");
                if (provenienza === "challenge") { setModo("camera"); setTentativo((n) => n + 1); }
                else inputRef.current?.click();
              }}
            >
              {provenienza === "challenge" ? "Rifai lo scatto" : "Scegli un'altra foto"}
            </button>
          </>
        ) : modo === "file" ? (
          <>
            <button className="btn btn--primary btn--block" type="button" onClick={() => inputRef.current?.click()}>
              Scatta o scegli una foto
            </button>
            {cameraSupported() && (
              <button
                className="btn btn--link"
                type="button"
                onClick={() => { setMotivoCamera(""); setModo("camera"); setTentativo((n) => n + 1); }}
              >
                Usa la camera con le indicazioni
              </button>
            )}
          </>
        ) : null}

        <p className="nota">
          Il selfie non finisce in nessuna galleria e non lo vede nessuno: serve solo al
          confronto, e il file si cancella subito dopo.
        </p>
      </div>
    </Screen>
  );
}

/**
 * La sfida. La guida dentro il quadro è la cornice di messa a fuoco del
 * marchio, a tratto: prima era una sfumatura radiale che velava il viso, e le
 * sfumature sono vietate.
 *
 * Le tacche sono `.mini-tappe`, il componente che il sistema ha già per «a
 * che punto sei». Sono decorative — la parola del passo la dice la regione
 * viva qui sotto, che è quello che legge uno screen reader e quello che
 * resta leggibile senza distinguere i colori.
 */
function Sfida({
  onScatto,
  onRinuncia,
}: { onScatto: (b: Blob) => void; onRinuncia: (perche: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lmRef = useRef<FaceLandmarker | null>(null);
  const [stato, setStato] = useState<"apro" | "corso" | "scaduto">("apro");
  const [passo, setPasso] = useState<ChallengeStep>("look");
  const [giro, setGiro] = useState(0);
  const ultimo = useRef({ onScatto, onRinuncia });
  ultimo.current = { onScatto, onRinuncia };

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const controller = new AbortController();
    const { signal } = controller;
    (async (video: HTMLVideoElement) => {
      try {
        if (!streamRef.current || !lmRef.current) {
          const [cam, lm] = await Promise.allSettled([openCamera(), loadLandmarker()]);
          if (cam.status !== "fulfilled" || lm.status !== "fulfilled" || signal.aborted) {
            if (cam.status === "fulfilled") stopStream(cam.value);
            if (lm.status === "fulfilled") lm.value.close();
            if (signal.aborted) return;
            throw cam.status === "rejected" ? cam.reason : (lm as PromiseRejectedResult).reason;
          }
          streamRef.current = cam.value;
          lmRef.current = lm.value;
          video.srcObject = cam.value;
          await video.play();
        }
        if (signal.aborted) return;
        setStato("corso");
        const blob = await runChallenge({ video, landmarker: lmRef.current, onStep: setPasso, signal });
        ultimo.current.onScatto(blob);
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof LivenessError && cause.code === "timeout") { setStato("scaduto"); return; }
        /* Ogni motivo dice cosa fare di diverso, non «camera non disponibile». */
        const code = cause instanceof LivenessError ? cause.code : "";
        ultimo.current.onRinuncia(
          code === "denied"
            ? "La camera è bloccata per questo sito. Puoi sbloccarla dalle impostazioni del browser, oppure scattare una foto normale qui sotto."
            : code === "model"
            ? "Le indicazioni guidate non si caricano su questo telefono. Scatta una foto normale qui sotto: funziona uguale."
            : "Questo telefono non ci dà accesso alla camera. Scatta una foto normale qui sotto.",
        );
      }
    })(el);
    return () => controller.abort();
  }, [giro]);

  useEffect(
    () => () => {
      stopStream(streamRef.current);
      streamRef.current = null;
      lmRef.current?.close();
      lmRef.current = null;
    },
    [],
  );

  const attivo = CHALLENGE_STEPS.indexOf(passo);
  return (
    <div className="ripresa">
      <div className="ripresa__quadro">
        <video ref={videoRef} autoPlay muted playsInline aria-label="Anteprima della camera" />
        <div className="ripresa__guida" aria-hidden="true">
          <svg viewBox="0 0 75 100" fill="none" preserveAspectRatio="none">
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeOpacity="0.8">
              <path d="M10 26 V19 a5 5 0 0 1 5-5 H22" />
              <path d="M53 14 H60 a5 5 0 0 1 5 5 V26" />
              <path d="M65 74 V81 a5 5 0 0 1-5 5 H53" />
              <path d="M22 86 H15 a5 5 0 0 1-5-5 V74" />
            </g>
          </svg>
        </div>
      </div>

      <div className="mini-tappe" aria-hidden="true">
        {CHALLENGE_STEPS.map((nome, i) => (
          <i
            key={nome}
            className={stato !== "corso" ? "" : i < attivo ? "done" : i === attivo ? "now" : ""}
          />
        ))}
      </div>

      <p className="ripresa__passo" role="status" aria-live="polite">
        {stato === "apro"
          ? "Apro la camera…"
          : stato === "scaduto"
          ? "Tempo scaduto: non siamo riusciti a seguirti"
          : STEP_LABELS[passo]}
      </p>

      {stato === "scaduto" ? (
        <>
          <p className="ripresa__aiuto">
            Tieni il viso dentro la cornice e fai un movimento alla volta, senza fretta.
          </p>
          <button className="btn btn--primary" type="button" onClick={() => { setStato("apro"); setGiro((n) => n + 1); }}>
            Riprova le indicazioni
          </button>
        </>
      ) : (
        <p className="ripresa__aiuto">Tieni il viso nella cornice, a circa 40 cm.</p>
      )}

      <button
        className="btn btn--link"
        type="button"
        onClick={() => onRinuncia("")}
      >
        Scatta una foto normale invece
      </button>
    </div>
  );
}
