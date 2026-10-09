"use client";

/*
 * v6 C3 (agent C): the crowd-album camera with the Polaroid frame.
 *
 * Two capture paths, one composite path:
 *
 *  - `getUserMedia` where available: a PLAIN `<video>` preview, no CSS filter on it. The
 *    shot is grabbed into a canvas, and only then does `renderPolaroid` apply the filter and
 *    draw the frame. That split is a frozen decision (C3): a live `filter` on a `<video>`
 *    repaints every frame and collapses to single-digit fps on iOS Safari and low-end
 *    Android, for pixels that are identical to the ones a single post-shot pass produces.
 *  - otherwise `<input type="file" accept="image/*" capture="environment">`, which is what
 *    an in-app browser or a locked-down WebView gives us.
 *
 * Video is out of scope for v6 (decision 4, frozen). The file input accepts only images and
 * the chosen file's MIME type is checked again before anything is decoded, because
 * `accept` is a hint on every mobile browser and a user can hand us a .mov regardless.
 *
 * The composite is uploaded; the untouched capture is kept in state as the original so the
 * frame can be re-rendered later without asking for the shot again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isUploadsClosed, uploadToAlbum } from "@/lib/crowd";
import { contentTypeOf } from "@/lib/upload";
import {
  POLAROID_FILTER_LABELS,
  POLAROID_FILTERS,
  renderPolaroid,
  type PolaroidFilter,
} from "@/lib/polaroid";

type Props = {
  albumId: string;
  /** Drawn in the frame's wide bottom border. */
  eventName: string;
  /** Second line under the caption; already formatted for Italian. */
  eventDate?: string;
  onUploaded?: (photoId: string) => void;
  onClose?: () => void;
};

type Phase = "idle" | "live" | "review" | "sending";

const FILTER_ORDER: PolaroidFilter[] = ["none", "istantanea", "notte", "bianconero"];

export function Camera({ albumId, eventName, eventDate, onUploaded, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [filter, setFilter] = useState<PolaroidFilter>("istantanea");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The untouched capture: kept so the frame can be re-rendered on a filter change. */
  const [capture, setCapture] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);

  const supportsStream = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function",
    [],
  );

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopStream, [stopStream]);

  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview?.url]);

  const startLive = useCallback(async () => {
    setError(null);
    if (!supportsStream) {
      fileRef.current?.click();
      return;
    }
    try {
      // `video: true` is the camera feed, not a video recording: nothing is ever recorded.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 2560 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setPhase("live");
    } catch {
      // Permission refused, no camera, or an in-app browser: fall back to the file picker.
      setPhase("idle");
      fileRef.current?.click();
    }
  }, [supportsStream]);

  /** Builds the composite from the untouched capture and shows it. */
  const compose = useCallback(
    async (source: Blob, chosen: PolaroidFilter) => {
      const result = await renderPolaroid(source, {
        caption: eventName,
        ...(eventDate ? { subtitle: eventDate } : {}),
        filter: chosen,
      });
      setPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return { url: URL.createObjectURL(result.blob), blob: result.blob };
      });
    },
    [eventDate, eventName],
  );

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    setError(null);
    // Grab the frame at the sensor's own size, unfiltered. The filter and the frame come
    // afterwards, in `renderPolaroid`.
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("La fotocamera non è disponibile su questo dispositivo.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const shot = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92),
    );
    if (!shot) {
      setError("Scatto non riuscito. Riprova.");
      return;
    }
    stopStream();
    setCapture(shot);
    try {
      await compose(shot, filter);
      setPhase("review");
    } catch {
      setError("Non riesco a elaborare la foto. Riprova.");
      setPhase("idle");
    }
  }, [compose, filter, stopStream]);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      // Decision 4 (frozen): no video in v6. `accept` is only a hint, so the real file is
      // what decides, and `contentTypeOf` refuses every `video/*` outright.
      //
      // It is deliberately not the strict JPEG/PNG test: a photo picked on an iPhone can
      // report `image/jpg`, and one forwarded through a messaging app can report nothing at
      // all, and both are photos this album wants. The resolved type is then put BACK on the
      // file, because `renderPolaroid` refuses anything whose own type is not exactly
      // `image/jpeg` or `image/png`.
      const type = contentTypeOf(file);
      if (!type) {
        setError("Puoi inviare solo foto (JPEG o PNG). I video non sono ammessi.");
        return;
      }
      const source = file.type === type ? file : new File([file], file.name, { type });
      setCapture(source);
      try {
        await compose(source, filter);
        setPhase("review");
      } catch {
        setError("Non riesco a leggere questa immagine. Prova con un'altra foto.");
      }
    },
    [compose, filter],
  );

  const changeFilter = useCallback(
    async (chosen: PolaroidFilter) => {
      setFilter(chosen);
      if (!capture) return;
      try {
        await compose(capture, chosen);
      } catch {
        setError("Non riesco ad applicare il filtro. Riprova.");
      }
    },
    [capture, compose],
  );

  const send = useCallback(async () => {
    if (!preview) return;
    setPhase("sending");
    setError(null);
    try {
      const outcome = await uploadToAlbum(albumId, preview.blob, "polaroid.jpg");
      if (outcome.status === "auto_rejected") {
        setNotice("La foto non è stata pubblicata: non ha superato il controllo automatico.");
      } else if (outcome.status === "already-uploaded") {
        setNotice("Questa foto era già nell'album.");
      } else {
        setNotice("Foto pubblicata.");
        onUploaded?.(outcome.photoId);
      }
      setCapture(null);
      setPreview((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return null;
      });
      setPhase("idle");
    } catch (cause) {
      setPhase("review");
      if (isUploadsClosed(cause)) {
        setError(cause instanceof Error ? cause.message : "I caricamenti sono chiusi.");
        return;
      }
      setError(cause instanceof Error ? cause.message : "Caricamento non riuscito.");
    }
  }, [albumId, onUploaded, preview]);

  const retake = useCallback(() => {
    setCapture(null);
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setPhase("idle");
  }, []);

  return (
    <section className="camera" aria-label="Fotocamera">
      {/* accept="image/*" and no `capture` of video: photos only (decision 4). */}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void onFile(file);
        }}
      />

      {phase === "live" ? (
        <div className="camera-live">
          {/* No CSS filter here, on purpose: see the file header. */}
          <video ref={videoRef} playsInline muted autoPlay className="camera-preview" />
          <div className="camera-actions">
            <button type="button" onClick={() => void shoot()}>
              Scatta
            </button>
            <button
              type="button"
              onClick={() => {
                stopStream();
                setPhase("idle");
              }}
            >
              Annulla
            </button>
          </div>
        </div>
      ) : null}

      {phase !== "live" && preview ? (
        <div className="camera-review">
          {/* The composite itself: frame and filter are already in the pixels. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.url} alt="Anteprima della foto con cornice" />
          <fieldset className="camera-filters">
            <legend>Filtro</legend>
            {FILTER_ORDER.filter((name) => name in POLAROID_FILTERS).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={filter === name}
                onClick={() => void changeFilter(name)}
              >
                {POLAROID_FILTER_LABELS[name]}
              </button>
            ))}
          </fieldset>
          <div className="camera-actions">
            <button type="button" onClick={() => void send()} disabled={phase === "sending"}>
              {phase === "sending" ? "Invio…" : "Pubblica"}
            </button>
            <button type="button" onClick={retake} disabled={phase === "sending"}>
              Rifai
            </button>
          </div>
        </div>
      ) : null}

      {phase === "idle" && !preview ? (
        <div className="camera-actions">
          <button type="button" onClick={() => void startLive()}>
            Apri la fotocamera
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}>
            Scegli una foto
          </button>
          {onClose ? (
            <button type="button" onClick={onClose}>
              Chiudi
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
