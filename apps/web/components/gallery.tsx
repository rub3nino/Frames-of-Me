"use client";

import { useEffect, useState } from "react";
import type { GalleryDownloadResponse, GalleryItem, GalleryResponse } from "@/lib/types";
import { Shell } from "@/components/shell";
import { useToast } from "@/components/toast";
import { Viewer } from "@/components/viewer";
import { ApiError, api } from "@/lib/api";
import { Gate } from "@/components/require-role";

export function Gallery({ slug }: { slug: string }) {
  return (
    <Shell wide signOut>
      <GalleryBody slug={slug} />
    </Shell>
  );
}

function GalleryBody({ slug }: { slug: string }) {
  const toast = useToast();
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [links, setLinks] = useState<string[]>([]);
  const [status, setStatus] = useState<GalleryResponse["status"] | null>(null);
  const [gate, setGate] = useState<"anon" | "wrong" | null>(null);

  useEffect(() => {
    let cancel = false;
    setItems(null);
    setError(null);
    setGate(null);
    api<GalleryResponse>(`/v1/events/${slug}/gallery`)
      .then((data) => {
        if (cancel) return;
        setStatus(data.status);
        setItems(data.items);
      })
      .catch((cause: unknown) => {
        if (cancel) return;
        if (cause instanceof ApiError && cause.status === 401) setGate("anon");
        else if (cause instanceof ApiError && cause.status === 403) setGate("wrong");
        else setError(cause instanceof ApiError ? cause.message : "Non riusciamo a caricare le foto.");
      });
    return () => {
      cancel = true;
    };
  }, [slug, attempt]);

  function toggle(photoId: string) {
    setLinks([]);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  async function download() {
    const photoIds = (items ?? []).filter((item) => selected.has(item.photoId)).map((item) => item.photoId);
    if (photoIds.length === 0) return;
    const popups = photoIds.map(() => window.open("about:blank", "_blank", "noopener"));
    setPending(true);
    try {
      const data = await api<GalleryDownloadResponse>(`/v1/events/${slug}/gallery/download`, {
        method: "POST",
        body: JSON.stringify({ photoIds }),
      });
      const blocked: string[] = [];
      data.urls.forEach((entry, index) => {
        const popup = popups[index];
        if (popup) popup.location.href = entry.url;
        else blocked.push(entry.url);
      });
      setLinks(blocked);
      if (blocked.length === 0) toast("Download avviato");
    } catch (cause) {
      popups.forEach((popup) => popup?.close());
      toast(cause instanceof ApiError ? cause.message : "Non riusciamo a preparare il download.");
    } finally {
      setPending(false);
    }
  }

  const count = selected.size;
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

      {items && items.length === 0 ? (
        <div className="empty">
          <h1>{indexingOpen ? "L'indicizzazione è ancora aperta." : "Nessuna corrispondenza."}</h1>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <>
          <h1>Le tue foto</h1>
          <p className="meta">{items.length === 1 ? "1 foto" : `${items.length} foto`}</p>
          <div className={count > 0 ? "grid-wrap has-bar" : "grid-wrap"}>
            <div className="grid">
              {items.map((item, index) => (
                <Cell
                  key={item.photoId}
                  item={item}
                  index={index}
                  selected={selected.has(item.photoId)}
                  onOpen={() => setOpen(index)}
                  onToggle={() => toggle(item.photoId)}
                />
              ))}
            </div>
          </div>
        </>
      ) : null}

      {count > 0 ? (
        <div className="bar">
          <p className="meta">{count === 1 ? "1 foto" : `${count} foto`}</p>
          {links.length > 0 ? (
            <ul className="open-links">
              {links.map((url, index) => (
                <li key={`${url}-${index}`}>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    Apri foto {index + 1}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bar-actions">
              <button type="button" className="linkish" onClick={() => setSelected(new Set())}>
                Annulla
              </button>
              <button className="button primary" type="button" onClick={() => void download()} disabled={pending}>
                {pending ? "Apertura…" : "Scarica"}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {open !== null && items ? (
        <Viewer items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

function Cell({
  item,
  index,
  selected,
  onOpen,
  onToggle,
}: {
  item: GalleryItem;
  index: number;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="cell">
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
      <label className="pick">
        <input type="checkbox" checked={selected} onChange={onToggle} />
        <span className="sr">Seleziona foto {index + 1}</span>
      </label>
    </div>
  );
}
