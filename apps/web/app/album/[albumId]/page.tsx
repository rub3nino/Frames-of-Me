"use client";

/*
 * v6 C2/C3 (agent C): the crowd album a participant sees — the feed of published photos,
 * the report button, and the side button that opens the camera.
 *
 * Everything withheld by moderation is simply absent from `GET /v1/albums/:id/photos`, so
 * there is no client-side filtering to keep in sync: when a photo reaches the report
 * threshold it leaves this list on the next load.
 */
import { use, useCallback, useEffect, useState } from "react";
import { Camera } from "@/components/camera";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError } from "@/lib/api";
import { listAlbumPhotos, reportPhoto } from "@/lib/crowd";
import type { AlbumPhoto, ReportReason } from "@/lib/types";

const REPORT_LABELS: Record<ReportReason, string> = {
  inappropriate: "Contenuto inappropriato",
  not_me: "Non sono io",
  copyright: "Diritti d'autore",
  other: "Altro",
};

export default function AlbumPage({ params }: { params: Promise<{ albumId: string }> }) {
  const { albumId } = use(params);
  return (
    <Shell wide signOut>
      <RequireRole role="participant" probe={`/v1/albums/${albumId}/photos?limit=1`}>
        <CrowdAlbum albumId={albumId} />
      </RequireRole>
    </Shell>
  );
}

function CrowdAlbum({ albumId }: { albumId: string }) {
  const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
  const [quota, setQuota] = useState<{ used: number; max: number | null }>({ used: 0, max: null });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await listAlbumPhotos(albumId, { limit: 60 });
      setPhotos(page.photos);
      setQuota(page.quota);
      setState("ready");
    } catch (cause) {
      setState("error");
      setMessage(cause instanceof ApiError ? cause.message : "Album non disponibile.");
    }
  }, [albumId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = useCallback(
    async (photoId: string, reason: ReportReason) => {
      setReporting(null);
      try {
        const answer = await reportPhoto(photoId, reason);
        // "Non sono io" is a per-user correction, not a takedown: say so, so nobody taps it
        // expecting the photo to disappear for everyone.
        setMessage(
          answer.status === "already-reported"
            ? "Hai già segnalato questa foto."
            : answer.hiddenForYou
              ? "Foto nascosta dalla tua galleria. Resta visibile agli altri."
              : answer.counts
                ? "Segnalazione inviata. Grazie."
                : "Segnalazione registrata. Grazie.",
        );
        // The threshold may have withheld it: a reload is the single source of truth.
        if (answer.state !== "approved") await load();
      } catch (cause) {
        setMessage(cause instanceof ApiError ? cause.message : "Segnalazione non inviata.");
      }
    },
    [load],
  );

  const full = quota.max !== null && quota.used >= quota.max;

  return (
    <div className="stack">
      <h1>Album di tutti</h1>
      <p className="lede">
        {quota.max === null
          ? "Aggiungi le tue foto all'album."
          : `Hai caricato ${quota.used} foto su ${quota.max}.`}
      </p>

      <div className="actions">
        <button
          type="button"
          className="button primary"
          disabled={full}
          onClick={() => setCameraOpen((open) => !open)}
        >
          {cameraOpen ? "Chiudi la fotocamera" : "Aggiungi una foto"}
        </button>
      </div>
      {full ? <p className="status">Hai raggiunto il numero massimo di foto.</p> : null}

      {cameraOpen ? (
        <Camera
          albumId={albumId}
          eventName="Album di tutti"
          onClose={() => setCameraOpen(false)}
          onUploaded={() => {
            setCameraOpen(false);
            void load();
          }}
        />
      ) : null}

      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p className="status">Caricamento</p> : null}
      {state === "error" ? <p role="alert">{message}</p> : null}

      <ul className="grid">
        {photos.map((photo) => (
          <li key={photo.id}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.thumbUrl} alt="" loading="lazy" />
            {reporting === photo.id ? (
              <div className="actions">
                {(Object.keys(REPORT_LABELS) as ReportReason[]).map((reason) => (
                  <button key={reason} type="button" onClick={() => void report(photo.id, reason)}>
                    {REPORT_LABELS[reason]}
                  </button>
                ))}
                <button type="button" onClick={() => setReporting(null)}>
                  Annulla
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setReporting(photo.id)}>
                Segnala
              </button>
            )}
          </li>
        ))}
      </ul>
      {state === "ready" && photos.length === 0 ? (
        <p className="status">Nessuna foto per ora. Sii il primo.</p>
      ) : null}
    </div>
  );
}
