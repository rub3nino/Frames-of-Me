"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Shell } from "@/components/shell";
import { api, ApiError } from "@/lib/api";
import type { PublicGalleryItem, PublicGalleryResponse } from "@/lib/types";

const PAGE_LIMIT = 60;

export function PublicGallery({ slug }: { slug: string }) {
  return (
    <Shell wide signOut>
      <PublicGalleryBody slug={slug} />
    </Shell>
  );
}

function PublicGalleryBody({ slug }: { slug: string }) {
  const [items, setItems] = useState<PublicGalleryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (next: string | null) => {
    setLoading(true);
    try {
      const query = next ? `&cursor=${encodeURIComponent(next)}` : "";
      const page = await api<PublicGalleryResponse>(
        `/v1/events/${encodeURIComponent(slug)}/public-gallery?limit=${PAGE_LIMIT}${query}`,
      );
      setItems((current) => {
        const seen = new Set(current.map((item) => item.photoId));
        return [...current, ...page.items.filter((item) => !seen.has(item.photoId))];
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a caricare le foto.");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null);
  }, [load]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cursor || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(cursor);
    }, { rootMargin: "600px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, loading, load]);

  return (
    <section>
      <h1>Galleria pubblica</h1>
      <p className="muted">Foto condivise dai partecipanti all’evento.</p>
      {error ? <p role="alert" className="error">{error}</p> : null}
      {!loading && items.length === 0 && !error ? <p>Nessuna foto disponibile.</p> : null}
      <div className="grid public-grid">
        {items.map((item) => (
          <a className="cell" key={item.photoId} href={item.webUrl} target="_blank" rel="noreferrer">
            <img src={item.thumbUrl} alt="Foto dell’evento" loading="lazy" />
          </a>
        ))}
      </div>
      <div ref={sentinel} aria-hidden="true" />
      {loading ? <p className="muted">Caricamento…</p> : null}
    </section>
  );
}
