import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Screen, CheckIcon } from "../ui";
import { api, EVENT_SLUG } from "../lib/api";
import {
  CHALLENGE_STEPS, LivenessError, SERVER_ACTION_LABELS, STEP_LABELS, cameraSupported,
  loadLandmarker, openCamera, runChallenge, runServerChallenge, stopStream,
  type ServerAction,
} from "../lib/liveness";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

const CONSENT_TEXT_VERSION = "2026-10-08";
const CONSENT_TEXT =
  "Acconsento al confronto del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca; un modello numerico del mio volto resta per la durata dell'evento, solo per agganciare le foto caricate in seguito, e viene cancellato con le foto. Le foto restano disponibili per 90 giorni.";

type Phase = "consent" | "capture" | "result";
type Liveness = "challenge" | "file";
const isImage = (f: File) => f.type === "image/jpeg" || f.type === "image/png";

export default function Selfie() {
  const [phase, setPhase] = useState<Phase>("consent");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [liveness, setLiveness] = useState<Liveness>("file");
  // Server-verified challenge (v4 report F05): set when the server dictated and the client
  // completed a challenge. Its frames are uploaded instead of a single selfie.
  const [challenge, setChallenge] = useState<{ id: string; frames: Blob[] } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [mode, setMode] = useState<"camera" | "file">("camera");
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function saveConsent(e: React.FormEvent) {
    e.preventDefault();
    if (!accepted || busy) return;
    setBusy(true); setErr(null);
    try {
      await api.giveConsent(EVENT_SLUG, CONSENT_TEXT_VERSION, true); // POST .../consent
      setMode(cameraSupported() ? "camera" : "file");
      setPhase("capture");
    } catch (e: any) { setErr(e?.message || "Non riusciamo a salvare il consenso."); }
    finally { setBusy(false); }
  }

  function choose(next: File | null, source: Liveness) {
    if (preview) URL.revokeObjectURL(preview);
    setChallenge(null);
    if (!next) { setFile(null); setPreview(null); return; }
    if (!isImage(next)) { setErr("Usa un jpeg o un png."); return; }
    setErr(null); setFile(next); setLiveness(source); setPreview(URL.createObjectURL(next));
  }

  // A completed server challenge: keep its frames, and show the frontal frame as the preview.
  function chooseChallenge(id: string, frames: Blob[]) {
    if (preview) URL.revokeObjectURL(preview);
    const frontal = frames[frames.length - 1]!;
    const frontalFile = new File([frontal], "selfie.jpg", { type: frontal.type || "image/jpeg" });
    setErr(null);
    setChallenge({ id, frames });
    setLiveness("challenge");
    setFile(frontalFile);
    setPreview(URL.createObjectURL(frontal));
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true); setErr(null);
    try {
      if (challenge) await api.sendSelfieChallenge(EVENT_SLUG, challenge.id, challenge.frames);
      else await api.sendSelfie(EVENT_SLUG, file, liveness, file.name); // POST .../selfie
      setPhase("result");
    } catch (e: any) {
      if (e?.status === 429) setErr("Hai già cercato più volte. Riprova più tardi.");
      else setErr(e?.message || "Non riusciamo a inviare il selfie.");
    } finally { setBusy(false); }
  }

  if (phase === "consent") {
    return (
      <Screen tabbar>
        <form className="stack" onSubmit={saveConsent}>
          <div>
            <h1>Scatta un selfie</h1>
            <p className="dek">Lo usiamo solo per trovarti tra le foto.</p>
          </div>
          <label className="check">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span className="box"><CheckIcon /></span>
            <span className="check-label">{CONSENT_TEXT}</span>
          </label>
          <div className="reassure">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 3.5v6c0 5-3.5 8.6-8 10-4.5-1.4-8-5-8-10v-6L12 2Z" /><path d="M8.5 12l2.4 2.4L16 9" /></svg>
            <span>Il selfie viene cancellato subito dopo la ricerca. Puoi ritirare il consenso quando vuoi.</span>
          </div>
          {err && <div className="banner banner-danger"><span>{err}</span></div>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!accepted || busy} data-press>
            {busy ? "Salvo…" : "Acconsento e continuo"}
          </button>
        </form>
      </Screen>
    );
  }

  if (phase === "capture") {
    const challenging = mode === "camera" && !file;
    return (
      <Screen tabbar>
        <form className="stack" onSubmit={send}>
          <div>
            <h1>Scatta un selfie</h1>
            <p className="dek">{challenging ? "Segui le indicazioni: lo scatto parte da solo." : "Un primo piano, jpeg o png."}</p>
          </div>
          <input ref={inputRef} className="sr-only" type="file" accept="image/jpeg,image/png"
            onChange={(e) => choose(e.target.files?.[0] ?? null, "file")} />
          {challenging && (
            <CameraChallenge key={attempt}
              onChallenge={chooseChallenge}
              onCaptured={(blob) => choose(new File([blob], "selfie.jpg", { type: "image/jpeg" }), "challenge")}
              onFallback={() => { setMode("file"); choose(null, "file"); }} />
          )}
          {preview && <img className="preview" src={preview} alt="Anteprima del selfie" />}
          {err && <div className="banner banner-danger"><span>{err}</span></div>}
          {!challenging && (
            file
              ? <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy} data-press>{busy ? "Invio…" : "Trova le mie foto"}</button>
              : <button className="btn btn-secondary btn-block" type="button" onClick={() => inputRef.current?.click()} data-press>Scatta o scegli una foto</button>
          )}
          {file && liveness === "challenge" && <button className="muted-link" type="button" onClick={() => { choose(null, "file"); setMode("camera"); setAttempt((n) => n + 1); }}>Rifai lo scatto</button>}
          {file && liveness === "file" && <button className="muted-link" type="button" onClick={() => inputRef.current?.click()}>Scegli un'altra</button>}
          {!file && mode === "file" && cameraSupported() && <button className="muted-link" type="button" onClick={() => { setMode("camera"); setAttempt((n) => n + 1); }}>Usa la camera</button>}
        </form>
      </Screen>
    );
  }

  return <SearchResult />;
}

function CameraChallenge({
  onChallenge,
  onCaptured,
  onFallback,
}: {
  onChallenge: (id: string, frames: Blob[]) => void;
  onCaptured: (b: Blob) => void;
  onFallback: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lmRef = useRef<FaceLandmarker | null>(null);
  const [status, setStatus] = useState<"loading" | "running" | "timeout">("loading");
  // Progress is generic: the legacy flow has fixed steps, the server flow a dictated action list.
  const [instruction, setInstruction] = useState<string>("");
  const [progress, setProgress] = useState<{ index: number; total: number }>({ index: 0, total: CHALLENGE_STEPS.length });
  const [round, setRound] = useState(0);
  const latest = useRef({ onChallenge, onCaptured, onFallback });
  latest.current = { onChallenge, onCaptured, onFallback };

  useEffect(() => {
    const el = videoRef.current; if (!el) return;
    const controller = new AbortController(); const { signal } = controller;
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
          streamRef.current = cam.value; lmRef.current = lm.value;
          video.srcObject = cam.value; await video.play();
        }
        if (signal.aborted) return;

        // v4 report F05: ask the server for a challenge. When it answers, run the dictated
        // sequence and upload every frame. A 404 means the server runs the legacy flow.
        let serverActions: ServerAction[] | null = null;
        let challengeId = "";
        try {
          const challenge = await api.getSelfieChallenge(EVENT_SLUG);
          serverActions = challenge.actions as ServerAction[];
          challengeId = challenge.challengeId;
        } catch (cause) {
          // 404 = the server runs the legacy single-selfie flow; anything else is a real error.
          const status = (cause as { status?: number } | null)?.status;
          if (status !== 404) throw cause;
        }
        if (signal.aborted) return;
        setStatus("running");

        if (serverActions) {
          setProgress({ index: 0, total: serverActions.length });
          const frames = await runServerChallenge({
            video,
            landmarker: lmRef.current,
            actions: serverActions,
            onAction: (action, index) => {
              setInstruction(SERVER_ACTION_LABELS[action]);
              setProgress({ index, total: serverActions!.length });
            },
            signal,
          });
          latest.current.onChallenge(challengeId, frames);
        } else {
          setProgress({ index: 0, total: CHALLENGE_STEPS.length });
          const blob = await runChallenge({
            video,
            landmarker: lmRef.current,
            onStep: (step) => {
              setInstruction(STEP_LABELS[step]);
              setProgress({ index: CHALLENGE_STEPS.indexOf(step), total: CHALLENGE_STEPS.length });
            },
            signal,
          });
          latest.current.onCaptured(blob);
        }
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof LivenessError && cause.code === "timeout") { setStatus("timeout"); return; }
        latest.current.onFallback();
      }
    })(el);
    return () => controller.abort();
  }, [round]);

  useEffect(() => () => { stopStream(streamRef.current); streamRef.current = null; lmRef.current?.close(); lmRef.current = null; }, []);

  return (
    <div className="live">
      <div className="live-frame">
        <video ref={videoRef} autoPlay muted playsInline aria-label="Anteprima della camera" />
        <div className="live-guide" aria-hidden="true" />
      </div>
      <ol className="live-steps" aria-hidden="true">
        {Array.from({ length: progress.total }, (_, i) => (
          <li key={i} data-state={status !== "running" ? undefined : i < progress.index ? "done" : i === progress.index ? "active" : undefined} />
        ))}
      </ol>
      <p className="live-step" role="status" aria-live="polite">
        {status === "loading" ? "Apro la camera…" : status === "timeout" ? "Tempo scaduto. Riprova." : instruction}
      </p>
      {status === "timeout"
        ? <button className="btn btn-primary" type="button" onClick={() => setRound((n) => n + 1)} data-press>Riprova</button>
        : <p className="live-hint">Tieni il viso nell'ovale, a circa 40 cm.</p>}
      <button className="muted-link" type="button" onClick={onFallback}>Usa un file invece</button>
    </div>
  );
}

function SearchResult() {
  const [status, setStatus] = useState<string>("queued");
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const g: any = await api.getGallery(EVENT_SLUG);
        if (stop) return;
        setStatus(g.status);
        if (g.status === "ready") stop = true;
      } catch { /* keep polling */ }
    };
    tick();
    const id = window.setInterval(() => { if (!stop) tick(); }, 2500);
    return () => { stop = true; window.clearInterval(id); };
  }, []);
  const ready = status === "ready";
  return (
    <Screen center tabbar>
      <div className="stack" style={{ textAlign: "center" }}>
        <h1>{ready ? "Le tue foto sono pronte" : "Confronto in corso…"}</h1>
        <p className="dek">{ready ? "Apri la tua galleria." : "Ci vuole qualche secondo. Puoi chiudere la pagina: ti avvisiamo per email."}</p>
        {ready
          ? <Link className="btn btn-primary btn-lg btn-block" to={`/e/${EVENT_SLUG}`} data-press>Apri le mie foto</Link>
          : <div style={{ marginTop: "var(--s-5)" }}><span className="badge badge-info">In corso</span></div>}
      </div>
    </Screen>
  );
}
