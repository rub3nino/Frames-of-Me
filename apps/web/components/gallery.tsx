"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DownloadVariant,
  FeedbackVerdict,
  GalleryDownloadResponse,
  GalleryItem,
  GalleryReason,
  GalleryResponse,
  GalleryStatus,
} from "@/lib/types";
import { Shell } from "@/components/shell";
import { useToast } from "@/components/toast";
import { Viewer } from "@/components/viewer";
import { ApiError, api } from "@/lib/api";
import { Gate } from "@/components/require-role";

const PAGE_LIMIT = 60;
const SURE_THRESHOLD = 0.9;
const ZIP_MAX = 500;
const QUEUED_POLL_MS = 5_000;

type GroupKey = "sure" | "maybe" | "hidden";

const groupTitle: Record<GroupKey, string> = {
  sure: "Le tue foto",
  maybe: "Forse sei tu",
  hidden: "Nascoste",
};

/** Why the last selfie produced no gallery (v5), in the participant's words. */
const reasonText: Record<GalleryReason, string> = {
  no_face: "Nel selfie non si vede un volto",
  face_too_small: "Avvicinati alla camera",
  low_quality: "Il selfie è sfocato o troppo scuro",
  multiple_faces: "Nel selfie ci sono più persone",
  no_photos_yet: "Non ci sono ancora foto: ti avviseremo",
  liveness: "Il selfie non è stato accettato",
};

/** `?debug=1` or `localStorage rephoto.debug = 1`: score and source on every cell (v5). */
function useDebug(): boolean {
  const [debug, setDebug] = useState(false);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get("debug");
      if (flag === "1") localStorage.setItem("rephoto.debug", "1");
      if (flag === "0") localStorage.removeItem("rephoto.debug");
      setDebug(flag === "1" || localStorage.getItem("rephoto.debug") === "1");
    } catch {
      setDebug(false);
    }
  }, []);
  return debug;
}

export function Gallery({ slug }: { slug: string }) {
  return (
    <Shell wide signOut>
      <GalleryBody slug={slug} />
    </Shell>
  );
}

function visitKey(slug: string): string {
  return `rephoto.visit.${slug}`;
}

function GalleryBody({ slug }: { slug: string }) {
  const toast = useToast();
  const debug = useDebug();
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<GalleryStatus | null>(null);
  const [reason, setReason] = useState<GalleryReason | null>(null);
  const [judging, setJudging] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [gate, setGate] = useState<"anon" | "wrong" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [variant, setVariant] = useState<DownloadVariant>("original");
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({ sure: false, maybe: false, hidden: true });
  const [open, setOpen] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const idsRef = useRef<HTMLInputElement>(null);
  const variantRef = useRef<HTMLInputElement>(null);
  const lastVisit = useRef<number>(0);
  const knownTotal = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(visitKey(slug));
      lastVisit.current = raw ? Number(raw) || 0 : 0;
      localStorage.setItem(visitKey(slug), String(Date.now()));
    } catch {
      /* private mode */
    }
  }, [slug]);

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) setGate("anon");
    else if (cause instanceof ApiError && cause.status === 403) setGate("wrong");
    else setError(cause instanceof ApiError ? cause.message : "Non riusciamo a caricare le foto.");
  }, []);

  useEffect(() => {
    let cancel = false;
    setItems(null);
    setError(null);
    setGate(null);
    setCursor(null);
    api<GalleryResponse>(`/v1/events/${slug}/gallery?limit=${PAGE_LIMIT}`)
      .then((data) => {
        if (cancel) return;
        setStatus(data.status);
        setReason(data.reason ?? null);
        setTotal(data.total);
        setItems(data.items);
        setCursor(data.nextCursor);
        knownTotal.current = data.total;
      })
      .catch((cause: unknown) => {
        if (!cancel) fail(cause);
      });
    return () => {
      cancel = true;
    };
  }, [slug, attempt, fail]);

  useEffect(() => {
    if (status !== "queued") return;
    let stop = false;
    const id = window.setInterval(() => {
      api<GalleryResponse>(`/v1/events/${slug}/gallery?limit=${PAGE_LIMIT}`)
        .then((data) => {
          if (stop) return;
          setStatus(data.status);
          if (data.status === "ready") {
            setReason(data.reason ?? null);
            setTotal(data.total);
            setItems(data.items);
            setCursor(data.nextCursor);
            const before = knownTotal.current ?? 0;
            knownTotal.current = data.total;
            if (data.total > before) toast("Nuove foto");
          }
        })
        .catch(() => {
          /* keep polling */
        });
    }, QUEUED_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [slug, status, toast]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api<GalleryResponse>(
        `/v1/events/${slug}/gallery?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => {
        const seen = new Set((current ?? []).map((item) => item.photoId));
        return [...(current ?? []), ...data.items.filter((item) => !seen.has(item.photoId))];
      });
      setCursor(data.nextCursor);
      setTotal(data.total);
    } catch (cause) {
      fail(cause);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, slug, fail]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !cursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  const groups = useMemo(() => {
    const sure: { item: GalleryItem; index: number }[] = [];
    const maybe: { item: GalleryItem; index: number }[] = [];
    const hidden: { item: GalleryItem; index: number }[] = [];
    (items ?? []).forEach((item, index) => {
      if (item.feedback === "not_me") hidden.push({ item, index });
      else (item.score >= SURE_THRESHOLD ? sure : maybe).push({ item, index });
    });
    return { sure, maybe, hidden };
  }, [items]);

  /** "Non sono io" / "Sono io": one POST per photo; the verdict is kept across re-scans by the server. */
  const judge = useCallback(
    async (photoIds: string[], verdict: FeedbackVerdict) => {
      if (photoIds.length === 0 || judging) return;
      setJudging(true);
      let failed = 0;
      for (const photoId of photoIds) {
        try {
          await api(`/v1/events/${slug}/gallery/feedback`, {
            method: "POST",
            body: JSON.stringify({ photoId, verdict }),
          });
          setItems((current) =>
            (current ?? []).map((item) => (item.photoId === photoId ? { ...item, feedback: verdict } : item)),
          );
        } catch {
          failed += 1;
        }
      }
      setJudging(false);
      setSelected((current) => {
        const next = new Set(current);
        for (const id of photoIds) next.delete(id);
        return next;
      });
      if (failed > 0) toast("Non siamo riusciti a salvare tutto");
      else if (verdict === "not_me") toast(photoIds.length === 1 ? "Foto nascosta" : `${photoIds.length} foto nascoste`);
      else toast("Foto ripristinata");
    },
    [judging, slug, toast],
  );

  function toggle(photoId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function selectGroup(key: GroupKey) {
    setSelected((current) => {
      const next = new Set(current);
      for (const { item } of groups[key]) next.add(item.photoId);
      return next;
    });
  }

  function downloadZip() {
    const ids = (items ?? []).filter((item) => selected.has(item.photoId)).map((item) => item.photoId);
    if (ids.length === 0 || ids.length > ZIP_MAX) return;
    const form = formRef.current;
    if (!form || !idsRef.current || !variantRef.current) return;
    idsRef.current.value = ids.join(",");
    variantRef.current.value = variant;
    form.submit();
    toast("Preparo lo zip");
  }

  const count = selected.size;
  const tooMany = count > ZIP_MAX;
  const webOnlySelected = useMemo(
    () => (items ?? []).filter((item) => selected.has(item.photoId) && item.originalReady === false).length,
    [items, selected],
  );
  const indexingOpen = status === "queued" || status === "empty";

  if (gate) return <Gate kind={gate} />;

  return (
    <>
      {items === null && !error ? (
        <>
          <h1>Le tue foto</h1>
          <div className="grid" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div className="cell" key={index} />
            ))}
          </div>
        </>
      ) : null}

      {error ? (
        <div className="stack">
          <h1>Le tue foto</h1>
          <p className="alert" role="alert">
            {error}
          </p>
          <div className="actions">
            <button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>
              Riprova
            </button>
          </div>
        </div>
      ) : null}

      {status === "queued" ? (
        <p className="banner" role="status">
          Confronto in corso…
        </p>
      ) : null}

      {items && items.length === 0 ? (
        <div className="empty">
          <h1>{indexingOpen ? "L'indicizzazione è ancora aperta." : "Nessuna corrispondenza."}</h1>
          {reason && status !== "queued" ? (
            <p className="reason" role="status">
              {reasonText[reason]}
              {reason !== "no_photos_yet" ? " · prova un altro selfie" : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <>
          <h1>Le tue foto</h1>
          <p className="meta">{total === 1 ? "1 foto" : `${total} foto`}</p>
          <div className={count > 0 ? "grid-wrap has-bar" : "grid-wrap"}>
            {(["sure", "maybe", "hidden"] as GroupKey[]).map((key) => {
              const entries = groups[key];
              if (entries.length === 0) return null;
              const hidden = collapsed[key];
              return (
                <section className="group" key={key}>
                  <div className="group-head">
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={!hidden}
                      onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                    >
                      <span className="chevron" data-open={hidden ? "false" : "true"} aria-hidden="true" />
                      <h2>{groupTitle[key]}</h2>
                      <span className="meta">{entries.length}</span>
                    </button>
                    {!hidden ? (
                      <button type="button" className="linkish" onClick={() => selectGroup(key)}>
                        Seleziona tutte
                      </button>
                    ) : null}
                  </div>
                  {!hidden ? (
                    <div className="grid">
                      {entries.map(({ item, index }) => (
                        <Cell
                          key={item.photoId}
                          item={item}
                          index={index}
                          fresh={item.source === "attach" && Date.parse(item.createdAt) > lastVisit.current}
                          selected={selected.has(item.photoId)}
                          debug={debug}
                          onOpen={() => setOpen(index)}
                          onToggle={() => toggle(item.photoId)}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
            <div ref={sentinelRef} className="sentinel" aria-hidden="true" />
            {loadingMore ? <p className="status">Carico altre foto</p> : null}
          </div>
        </>
      ) : null}

      {count > 0 ? (
        <div className="bar">
          <div className="bar-info">
            <p className="meta">{count === 1 ? "1 foto" : `${count} foto`}</p>
            {tooMany ? (
              <p className="alert" role="alert">
                Seleziona al massimo {ZIP_MAX} foto.
              </p>
            ) : (
              <div className="variant" role="radiogroup" aria-label="Formato">
                <label>
                  <input
                    type="radio"
                    name="variant"
                    value="original"
                    checked={variant === "original"}
                    onChange={() => setVariant("original")}
                  />
                  <span>Originali</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="variant"
                    value="web"
                    checked={variant === "web"}
                    onChange={() => setVariant("web")}
                  />
                  <span>Per il web</span>
                </label>
              </div>
            )}
            {!tooMany && variant === "original" && webOnlySelected > 0 ? (
              <p className="note-web" role="status">
                {webOnlySelected === 1
                  ? "1 foto è disponibile solo in versione web"
                  : `${webOnlySelected} foto sono disponibili solo in versione web`}
              </p>
            ) : null}
          </div>
          <div className="bar-actions">
            <button type="button" className="linkish" onClick={() => setSelected(new Set())}>
              Annulla
            </button>
            <button
              type="button"
              className="linkish"
              disabled={judging}
              onClick={() => void judge([...selected], "not_me")}
              title="Nasconde le foto e lo segnala: non verranno riproposte"
            >
              {judging ? "Salvo…" : "Non sono io"}
            </button>
            <button className="button primary" type="button" onClick={downloadZip} disabled={tooMany}>
              Scarica ZIP
            </button>
          </div>
        </div>
      ) : null}

      <form
        ref={formRef}
        method="post"
        action={`/v1/events/${encodeURIComponent(slug)}/gallery/zip`}
        className="sr"
        aria-hidden="true"
        tabIndex={-1}
      >
        <input ref={idsRef} type="hidden" name="ids" />
        <input ref={variantRef} type="hidden" name="variant" />
      </form>

      {/* v6 G (agent G): the way to "I miei dati" and the withdrawal, from where people land. */}
      <p className="note">
        <a href="/i-miei-dati">I miei dati</a> — cosa conserviamo di te e come ritirare il consenso.
      </p>

      {open !== null && items ? (
        <Viewer
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onDownload={(item) => downloadOne(slug, item, toast)}
          onFeedback={(item, verdict) => void judge([item.photoId], verdict)}
          debug={debug}
        />
      ) : null}
    </>
  );
}

/** Single photo from the viewer: a popup is opened on the click so the browser does not block it. */
async function downloadOne(slug: string, item: GalleryItem, toast: (message: string) => void): Promise<string | null> {
  const popup = window.open("about:blank", "_blank", "noopener");
  try {
    const data = await api<GalleryDownloadResponse>(`/v1/events/${slug}/gallery/download`, {
      method: "POST",
      body: JSON.stringify({ photoIds: [item.photoId], variant: "original" }),
    });
    const url = data.urls[0]?.url;
    if (!url) throw new Error("Manca il link.");
    if (popup) {
      popup.location.href = url;
      return null;
    }
    return url;
  } catch (cause) {
    popup?.close();
    toast(cause instanceof ApiError ? cause.message : "Non riusciamo a preparare il download.");
    return null;
  }
}

function Cell({
  item,
  index,
  fresh,
  selected,
  debug,
  onOpen,
  onToggle,
}: {
  item: GalleryItem;
  index: number;
  fresh: boolean;
  selected: boolean;
  debug: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="cell" data-selected={selected ? "true" : "false"} data-feedback={item.feedback ?? "none"}>
      <button type="button" className="cell-hit" onClick={onOpen} aria-label={`Apri foto dell'evento ${index + 1}`}>
        <img
          className={loaded ? "thumb is-in" : "thumb"}
          src={item.thumbUrl}
          alt="Foto dell'evento"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          style={index < 6 ? { animationDelay: `${index * 40}ms` } : undefined}
          onLoad={() => setLoaded(true)}
        />
      </button>
      {fresh ? <span className="badge">Nuova</span> : null}
      {debug ? (
        <span className="debug-tag" title={item.photoId}>
          {item.score.toFixed(2)} · {item.source}
        </span>
      ) : null}
      {item.originalReady === false ? (
        <span className="tag-web" title="L'originale non è ancora stato caricato">
          solo web
        </span>
      ) : null}
      <label className="pick">
        <input type="checkbox" checked={selected} onChange={onToggle} />
        <span className="sr">Seleziona foto {index + 1}</span>
      </label>
    </div>
  );
}
