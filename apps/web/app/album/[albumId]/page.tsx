"use client";

/*
 * v6 C2/C3 (agent C): the crowd album a participant sees — the feed of published photos,
 * the report button, and the side button that opens the camera.
 *
 * Everything withheld by moderation is simply absent from `GET /v1/albums/:id/photos`, so
 * there is no client-side filtering to keep in sync: when a photo reaches the report
 * threshold it leaves this list on the next load.
 */
import { use, useCallback, useEffect, useRef, useState } from "react";
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

/**
 * What a CROWD album's report sheet offers — the counting reasons only, i.e. the ones that
 * can send a photo to a moderator (MODERATION_COUNTING_REASONS in the contracts).
 *
 * `not_me` is left out on purpose, for two reasons that point the same way. It is a request
 * about ONE person ("hide this from my gallery"), while every other button here is a request
 * about EVERYONE ("a moderator should look at this"), and a sheet that mixes the two invites
 * the mistake the api then has to absorb silently. And in a crowd album it is meaningless
 * anyway: crowd photos are in nobody's match gallery, so there is nothing to hide — the api
 * would record the row and answer `hiddenForYou: false`.
 *
 * The per-person action keeps its own, older, better home: the "Non sono io" button next to
 * the photo in the personal match gallery (components/viewer.tsx for one photo,
 * components/gallery.tsx for a selection), which writes exactly the same `gallery_feedback`
 * row this route would have written. The api still accepts `not_me` here — the one-way escalation
 * from a stored `not_me` to a counting reason depends on it, and someone may want a wrong
 * match reviewed with a note — this is a UI choice, not a contract change.
 *
 * If a second album kind ever needs a different list, this is where it branches on
 * `album.kind`. One kind offers one list today, so there is no mechanism to build yet.
 */
const CROWD_REPORT_REASONS: ReportReason[] = ["inappropriate", "copyright", "other"];

/** One screenful plus some: the server caps `limit` itself, this is only the ask. */
const PAGE_LIMIT = 60;

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
  /**
   * The server's own cursor, kept and sent back EXACTLY as it arrived. It is an opaque
   * string: its encoding lives in the api (`encodeCrowdCursor`) and nothing here may parse,
   * build or alter one. `null` means there is no further page.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [quota, setQuota] = useState<{ used: number; max: number | null }>({ used: 0, max: null });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  /** What the reader did: a report was sent, or already was. Never a transport failure. */
  const [message, setMessage] = useState<string | null>(null);
  /** A page that did not load. Separate from `message`, which a reload must not wipe. */
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  /**
   * One page. `next === null` is a reload from the top and REPLACES the feed — that is what
   * a report or a fresh upload needs, since either can change what the server publishes.
   * Any other value appends, de-duplicated by photo id: pages are keyset-based, so a photo
   * added while the moderator was scrolling can shift into a page already seen.
   */
  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      try {
        const page = await listAlbumPhotos(albumId, {
          limit: PAGE_LIMIT,
          ...(next ? { cursor: next } : {}),
        });
        setPhotos((current) => {
          if (!next) return page.photos;
          const seen = new Set(current.map((photo) => photo.id));
          return [...current, ...page.photos.filter((photo) => !seen.has(photo.id))];
        });
        setCursor(page.nextCursor ?? null);
        setQuota(page.quota);
        setState("ready");
        setError(null);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Album non disponibile.");
        // A page that fails after the first one must not blank the photos already on screen.
        setState((current) => (current === "ready" ? "ready" : "error"));
      } finally {
        setLoading(false);
      }
    },
    [albumId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  /**
   * Infinite scroll: an empty sentinel under the grid, observed 600 px before it is in view
   * so the next page is usually there by the time the thumbs would have run out. The
   * observer is only an enhancement — the button next to it does the same thing for anyone
   * whose browser or settings leave it unused.
   */
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || loading) return;
    if (typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(cursor);
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loading, load]);

  const report = useCallback(
    async (photoId: string, reason: ReportReason) => {
      setReporting(null);
      try {
        const answer = await reportPhoto(photoId, reason);
        // Every reason this sheet offers counts, so the answer is always the same promise:
        // a moderator will look. It deliberately does not say "removed" — with
        // post-moderation the photo stays up until the threshold or a moderator moves it.
        setMessage(
          answer.status === "already-reported"
            ? "Hai già segnalato questa foto."
            : "Segnalazione inviata: un moderatore la controllerà. Grazie.",
        );
        // The threshold may have withheld it: a reload is the single source of truth.
        if (answer.state !== "approved") await load(null);
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
      <p className="status">
        Se una foto non dovrebbe essere qui, segnalala: la controlla un moderatore. Per
        togliere dalla tua galleria una foto in cui non ci sei, usa «Non sono io» nella
        galleria.
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
            void load(null);
          }}
        />
      ) : null}

      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p className="status">Caricamento</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <ul className="grid">
        {photos.map((photo) => (
          <li className="album-item" key={photo.id}>
            {/*
              `webUrl` is the 1600 px derivative, presigned by the api for this reader. A
              plain link in a new tab is the whole viewer: the browser's own image view
              pinches, zooms and saves better than anything built here would, and it keeps
              the feed free of a lightbox nobody has to maintain. The url expires with its
              signature, which is why it is never stored or shared — it is read from the
              page that just fetched it.
            */}
            <div className="cell">
              <a className="cell-hit" href={photo.webUrl} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.thumbUrl} alt="Foto dell'album" loading="lazy" />
              </a>
            </div>
            {reporting === photo.id ? (
              <div className="album-report">
                {CROWD_REPORT_REASONS.map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    className="linkish"
                    onClick={() => void report(photo.id, reason)}
                  >
                    {REPORT_LABELS[reason]}
                  </button>
                ))}
                <button type="button" className="linkish" onClick={() => setReporting(null)}>
                  Annulla
                </button>
              </div>
            ) : (
              <button type="button" className="linkish" onClick={() => setReporting(photo.id)}>
                Segnala
              </button>
            )}
          </li>
        ))}
      </ul>

      <div ref={sentinel} aria-hidden="true" />
      {cursor ? (
        <div className="album-more">
          <button
            type="button"
            className="button quiet"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            {loading ? "Carico…" : "Mostra altre foto"}
          </button>
        </div>
      ) : null}
      {loading && photos.length > 0 ? <p className="status">Carico altre foto…</p> : null}

      {state === "ready" && photos.length === 0 ? (
        <p className="status">Nessuna foto per ora. Sii il primo.</p>
      ) : null}
    </div>
  );
}
