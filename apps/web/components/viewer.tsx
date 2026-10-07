"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedbackVerdict, GalleryItem } from "@/lib/types";
import { useReducedMotion } from "@/lib/motion";

const EASE = "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)";

export function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onDownload,
  onFeedback,
  debug = false,
}: {
  items: GalleryItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Resolves with a fallback URL when the browser blocked the popup, null otherwise. */
  onDownload?: (item: GalleryItem) => Promise<string | null>;
  /** "Non sono io" / "Sono io" (v5). */
  onFeedback?: (item: GalleryItem, verdict: FeedbackVerdict) => void;
  /** Shows score and source under the photo (v5). */
  debug?: boolean;
}) {
  const reduced = useReducedMotion();
  const [downloading, setDownloading] = useState(false);
  const [fallback, setFallback] = useState<{ photoId: string; url: string } | null>(null);

  async function download(item: GalleryItem) {
    if (!onDownload || downloading) return;
    setDownloading(true);
    setFallback(null);
    try {
      const url = await onDownload(item);
      if (url) setFallback({ photoId: item.photoId, url });
    } finally {
      setDownloading(false);
    }
  }
  const dialogRef = useRef<HTMLDivElement>(null);
  const reelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef({ active: false, startX: 0, origin: 0, time: 0, id: -1 });
  const finishRef = useRef<((event: TransitionEvent) => void) | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  function readX(element: HTMLElement): number {
    const value = getComputedStyle(element).transform;
    if (!value || value === "none") return 0;
    return new DOMMatrix(value).m41;
  }

  function cancelFinish() {
    const element = reelRef.current;
    const finish = finishRef.current;
    if (element && finish) element.removeEventListener("transitionend", finish);
    finishRef.current = null;
  }

  function jump(next: number) {
    const clamped = Math.max(0, Math.min(items.length - 1, next));
    if (clamped === indexRef.current) return;
    cancelFinish();
    const element = reelRef.current;
    if (element) {
      element.style.transition = "none";
      element.style.transform = "translate3d(0, 0, 0)";
    }
    onIndex(clamped);
  }

  function settle(next: number, fromX: number) {
    const element = reelRef.current;
    if (!element) return;
    const width = element.clientWidth || window.innerWidth;
    const target = next === indexRef.current ? 0 : next > indexRef.current ? -width : width;
    if (reduced || next === indexRef.current) {
      element.style.transition = "none";
      element.style.transform = "translate3d(0, 0, 0)";
      if (next !== indexRef.current) onIndex(next);
      return;
    }
    element.style.transition = "none";
    element.style.transform = `translate3d(${fromX}px, 0, 0)`;
    requestAnimationFrame(() => {
      element.style.transition = EASE;
      element.style.transform = `translate3d(${target}px, 0, 0)`;
    });
    const finish = (event: TransitionEvent) => {
      if (event.propertyName !== "transform") return;
      finishRef.current = null;
      element.style.transition = "none";
      element.style.transform = "translate3d(0, 0, 0)";
      if (next !== indexRef.current) onIndex(next);
    };
    finishRef.current = finish;
    element.addEventListener("transitionend", finish);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (reduced || !event.isPrimary || event.button !== 0) return;
    const element = reelRef.current;
    if (!element) return;
    cancelFinish();
    element.setPointerCapture(event.pointerId);
    element.style.transition = "none";
    drag.current = {
      active: true,
      startX: event.clientX,
      origin: readX(element),
      time: performance.now(),
      id: event.pointerId,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active || event.pointerId !== drag.current.id) return;
    const element = reelRef.current;
    if (!element) return;
    let delta = event.clientX - drag.current.startX;
    const atStart = indexRef.current === 0 && drag.current.origin + delta > 0;
    const atEnd = indexRef.current === items.length - 1 && drag.current.origin + delta < 0;
    if (atStart || atEnd) delta *= 0.35;
    element.style.transform = `translate3d(${drag.current.origin + delta}px, 0, 0)`;
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active || event.pointerId !== drag.current.id) return;
    drag.current.active = false;
    const element = reelRef.current;
    if (!element) return;
    const width = element.clientWidth || window.innerWidth;
    const x = readX(element);
    const delta = event.clientX - drag.current.startX;
    const elapsed = Math.max(performance.now() - drag.current.time, 1);
    const velocity = Math.abs(delta) / elapsed;
    let next = indexRef.current;
    if ((x <= -width * 0.25 || (delta < 0 && velocity > 0.11)) && next < items.length - 1) {
      next += 1;
    } else if ((x >= width * 0.25 || (delta > 0 && velocity > 0.11)) && next > 0) {
      next -= 1;
    }
    settle(next, x);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      jump(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      jump(index - 1);
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const current = items[index];
  const previous = index > 0 ? items[index - 1] : null;
  const next = index < items.length - 1 ? items[index + 1] : null;
  if (!current) return null;

  return (
    <div
      ref={dialogRef}
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Foto dell'evento"
      onKeyDown={onKeyDown}
    >
      <div className="viewer-top">
        <button ref={closeRef} type="button" className="linkish" onClick={onClose}>
          Chiudi
        </button>
        {current.originalReady === false ? (
          <p className="tag-web" title="Scarica usa la versione web finché l'originale non arriva">
            solo web
          </p>
        ) : null}
        <p className="meta">
          {index + 1} di {items.length}
          {debug ? ` · ${current.score.toFixed(2)} · ${current.source}` : ""}
        </p>
      </div>
      <div
        className="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={reelRef} className="reel">
          {!reduced && previous ? (
            <img className="neighbor prev" src={previous.webUrl} alt="" draggable={false} />
          ) : null}
          <img src={current.webUrl} alt="Foto dell'evento" draggable={false} />
          {!reduced && next ? (
            <img className="neighbor next" src={next.webUrl} alt="" draggable={false} />
          ) : null}
        </div>
      </div>
      <div className="viewer-nav">
        <button type="button" className="linkish" onClick={() => jump(index - 1)} disabled={index === 0}>
          Precedente
        </button>
        {onDownload ? (
          fallback && fallback.photoId === current.photoId ? (
            <a className="linkish" href={fallback.url} target="_blank" rel="noopener noreferrer">
              Apri il file
            </a>
          ) : (
            <button type="button" className="linkish" onClick={() => void download(current)} disabled={downloading}>
              {downloading ? "Preparo…" : "Scarica"}
            </button>
          )
        ) : null}
        {onFeedback ? (
          <button
            type="button"
            className="linkish"
            onClick={() => onFeedback(current, current.feedback === "not_me" ? "me" : "not_me")}
          >
            {current.feedback === "not_me" ? "Sono io" : "Non sono io"}
          </button>
        ) : null}
        <button
          type="button"
          className="linkish"
          onClick={() => jump(index + 1)}
          disabled={index === items.length - 1}
        >
          Successiva
        </button>
      </div>
    </div>
  );
}
