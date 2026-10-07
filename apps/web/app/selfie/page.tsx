"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { eventSlug } from "@/lib/event";
import {
  CHALLENGE_STEPS,
  LivenessError,
  STEP_LABELS,
  cameraSupported,
  loadLandmarker,
  openCamera,
  runChallenge,
  stopStream,
  type ChallengeStep,
} from "@/lib/liveness";
import { contentTypeOf } from "@/lib/upload";
import type { GalleryResponse } from "@/lib/types";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

const CONSENT_TEXT_VERSION = "2026-10-08";
const SELFIE_FIELD_NAME = "selfie";
/** Mirrors SELFIE_LIVENESS_FIELD / selfieLivenessSchema in the contracts. */
const SELFIE_LIVENESS_FIELD = "liveness";
type Liveness = "challenge" | "file";

const CONSENT_TEXT =
  "Acconsento al confronto del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca; un modello numerico del mio volto resta per la durata dell'evento, solo per agganciare le foto caricate in seguito, e viene cancellato con le foto. Le foto restano disponibili per 90 giorni.";

type Phase = "consent" | "capture" | "result";
/** Capture phase: the camera challenge, or the file picker when the camera is out. */
type CaptureMode = "camera" | "file";

export default function SelfiePage() {
  return (
    <Shell signOut>
      <RequireRole role="participant" probe={`/v1/events/${eventSlug}/gallery`}>
        <SelfieFlow />
      </RequireRole>
    </Shell>
  );
}

function SelfieFlow() {
  const [phase, setPhase] = useState<Phase>("consent");
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [liveness, setLiveness] = useState<Liveness>("file");
  const [preview, setPreview] = useState<string | null>(null);
  const [mode, setMode] = useState<CaptureMode>("camera");
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function saveConsent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted) return;
    setPending(true);
    setError(null);
    try {
      await api(`/v1/events/${eventSlug}/consent`, {
        method: "POST",
        body: JSON.stringify({ textVersion: CONSENT_TEXT_VERSION, accepted: true }),
      });
      setMode(cameraSupported() ? "camera" : "file");
      setPhase("capture");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a salvare il consenso.");
    } finally {
      setPending(false);
    }
  }

  function choose(next: File | null, source: Liveness) {
    if (preview) URL.revokeObjectURL(preview);
    if (!next) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!contentTypeOf(next)) {
      setError("Usa un jpeg o un png.");
      return;
    }
    setError(null);
    setFile(next);
    setLiveness(source);
    setPreview(URL.createObjectURL(next));
  }

  function useFilePicker() {
    setMode("file");
    choose(null, "file");
  }

  function retryChallenge() {
    choose(null, "file");
    setMode("camera");
    setAttempt((n) => n + 1);
  }

  async function sendSelfie(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const type = contentTypeOf(file);
    if (!type) {
      setError("Usa un jpeg o un png.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      body.set(SELFIE_FIELD_NAME, file, file.name || (type === "image/png" ? "selfie.png" : "selfie.jpg"));
      body.set(SELFIE_LIVENESS_FIELD, liveness);
      await api(`/v1/events/${eventSlug}/selfie`, {
        method: "POST",
        body,
      });
      setPhase("result");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a inviare il selfie.");
    } finally {
      setPending(false);
    }
  }

  if (phase === "consent") {
    return (
      <form className="stack" onSubmit={(event) => void saveConsent(event)}>
        <div>
          <h1>Consenso</h1>
          <p className="fine">
            Puoi ritirare il consenso quando vuoi: si possono cancellare account e ricerche.
          </p>
        </div>
        <label className="consent">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>{CONSENT_TEXT}</span>
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button className="button primary" type="submit" disabled={!accepted || pending}>
            {pending ? "Salvo…" : "Conferma il consenso"}
          </button>
        </div>
      </form>
    );
  }

  if (phase === "capture") {
    const challenging = mode === "camera" && !file;
    return (
      <form className="stack" onSubmit={(event) => void sendSelfie(event)}>
        <div>
          <h1>Selfie</h1>
          <p className="lede">
            {challenging
              ? "Segui le indicazioni: lo scatto parte da solo. Nessuna immagine esce dal telefono prima dello scatto."
              : "Un primo piano, in jpeg o png, fino a 8 MB."}
          </p>
        </div>
        <input
          ref={inputRef}
          className="sr"
          type="file"
          accept="image/jpeg,image/png"
          onChange={(event) => choose(event.target.files?.[0] ?? null, "file")}
        />
        {challenging ? (
          <CameraChallenge
            key={attempt}
            onCaptured={(blob) =>
              choose(new File([blob], "selfie.jpg", { type: "image/jpeg" }), "challenge")
            }
            onFallback={useFilePicker}
          />
        ) : null}
        {preview ? (
          <img className="preview" src={preview} alt="Anteprima del selfie" />
        ) : null}
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {challenging ? null : (
          <div className="actions">
            {file ? (
              <button className="button primary" type="submit" disabled={pending}>
                {pending ? "Invio…" : "Invia il selfie"}
              </button>
            ) : (
              <button className="button primary" type="button" onClick={() => inputRef.current?.click()}>
                Scatta o scegli
              </button>
            )}
          </div>
        )}
        {file && liveness === "challenge" ? (
          <button className="linkish" type="button" onClick={retryChallenge} disabled={pending}>
            Rifai lo scatto
          </button>
        ) : null}
        {file && liveness === "file" ? (
          <button className="linkish" type="button" onClick={() => inputRef.current?.click()} disabled={pending}>
            Scegli un&apos;altra
          </button>
        ) : null}
        {!file && mode === "file" && cameraSupported() ? (
          <button className="linkish" type="button" onClick={retryChallenge}>
            Usa la camera
          </button>
        ) : null}
      </form>
    );
  }

  return <SearchResult onRetry={() => setPhase("capture")} />;
}

type ChallengeStatus = "loading" | "running" | "timeout";

/**
 * Camera preview plus the MediaPipe challenge. Reports the frontal JPEG through `onCaptured`;
 * calls `onFallback` when the camera is denied/unsupported or the landmarker cannot load.
 * A step timeout shows "Riprova" and re-runs the steps on the same stream and model.
 */
function CameraChallenge({
  onCaptured,
  onFallback,
}: {
  onCaptured: (blob: Blob) => void;
  onFallback: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const [status, setStatus] = useState<ChallengeStatus>("loading");
  const [step, setStep] = useState<ChallengeStep>("look");
  const [round, setRound] = useState(0);
  const latest = useRef({ onCaptured, onFallback });
  latest.current = { onCaptured, onFallback };

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const controller = new AbortController();
    const { signal } = controller;

    async function run(video: HTMLVideoElement) {
      try {
        if (!streamRef.current || !landmarkerRef.current) {
          // Both in parallel, but whichever succeeds while the other fails (or the effect is
          // gone) is released: a camera stream must never outlive the challenge.
          const [cameraResult, landmarkerResult] = await Promise.allSettled([openCamera(), loadLandmarker()]);
          if (cameraResult.status !== "fulfilled" || landmarkerResult.status !== "fulfilled" || signal.aborted) {
            if (cameraResult.status === "fulfilled") stopStream(cameraResult.value);
            if (landmarkerResult.status === "fulfilled") landmarkerResult.value.close();
            if (signal.aborted) return;
            throw cameraResult.status === "rejected" ? cameraResult.reason : (landmarkerResult as PromiseRejectedResult).reason;
          }
          const stream = cameraResult.value;
          const landmarker = landmarkerResult.value;
          streamRef.current = stream;
          landmarkerRef.current = landmarker;
          video.srcObject = stream;
          await video.play();
        }
        if (signal.aborted) return;
        setStatus("running");
        const blob = await runChallenge({
          video,
          landmarker: landmarkerRef.current,
          onStep: setStep,
          signal,
        });
        latest.current.onCaptured(blob);
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof LivenessError && cause.code === "timeout") {
          setStatus("timeout");
          return;
        }
        latest.current.onFallback();
      }
    }
    void run(element);

    return () => controller.abort();
  }, [round]);

  // Camera and model live as long as the component: released on unmount only.
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  const activeIndex = CHALLENGE_STEPS.indexOf(step);

  return (
    <div className="live">
      <div className="live-frame">
        <video ref={videoRef} autoPlay muted playsInline aria-label="Anteprima della camera" />
        <div className="live-guide" aria-hidden="true" />
      </div>
      <ol className="live-steps" aria-hidden="true">
        {CHALLENGE_STEPS.map((name, index) => (
          <li
            key={name}
            data-state={
              status !== "running" ? undefined : index < activeIndex ? "done" : index === activeIndex ? "active" : undefined
            }
          />
        ))}
      </ol>
      <p className="live-step" role="status" aria-live="polite">
        {status === "loading"
          ? "Apro la camera…"
          : status === "timeout"
            ? "Tempo scaduto. Riprova."
            : STEP_LABELS[step]}
      </p>
      {status === "timeout" ? (
        <div className="actions inline">
          <button className="button primary" type="button" onClick={() => setRound((n) => n + 1)}>
            Riprova
          </button>
        </div>
      ) : (
        <p className="live-hint">Tieni il viso nell&apos;ovale, a circa 40 cm.</p>
      )}
      <button className="linkish" type="button" onClick={onFallback}>
        Usa un file invece
      </button>
    </div>
  );
}

function SearchResult({ onRetry }: { onRetry: () => void }) {
  const [gallery, setGallery] = useState<GalleryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const data = await api<GalleryResponse>(`/v1/events/${eventSlug}/gallery`);
        if (stop) return;
        setGallery(data);
        if (data.status === "ready") stop = true;
      } catch (cause) {
        if (!stop) {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere lo stato.");
        }
      }
    }
    void tick();
    const id = window.setInterval(() => {
      if (!stop) void tick();
    }, 2500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const ready = gallery?.status === "ready";

  return (
    <div className="stack">
      <h1>Ti mandiamo il link</h1>
      <p className="lede">
        {ready
          ? "Puoi aprirle ora. Il link resta anche nella posta."
          : "Il confronto è in corso. Puoi chiudere questa pagina: il link arriva per posta."}
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        {ready ? (
          <Link className="button primary" href={`/e/${eventSlug}`}>
            Apri le foto
          </Link>
        ) : error ? (
          <button className="button primary" type="button" onClick={onRetry}>
            Riprova
          </button>
        ) : (
          <p className="status">Confronto in corso</p>
        )}
      </div>
    </div>
  );
}
