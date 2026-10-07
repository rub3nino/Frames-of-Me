"use client";

import { useEffect, useState } from "react";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const raw = process.env.NEXT_PUBLIC_EVENT_SLUG || "demo";

/** Build-time slug: the fallback while `/api/config` has not answered (and for v4 pages). */
export const eventSlug = SLUG.test(raw) ? raw : "demo";

let resolved: string | null = null;
let pending: Promise<string> | null = null;

/** Fetches `/api/config` once per page load; later callers share the answer. */
export function loadEventSlug(): Promise<string> {
  if (resolved) return Promise.resolve(resolved);
  if (!pending) {
    pending = fetch("/api/config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        const slug = (data as { eventSlug?: unknown } | null)?.eventSlug;
        resolved = typeof slug === "string" && SLUG.test(slug) ? slug : eventSlug;
        return resolved;
      })
      .catch(() => {
        pending = null;
        return eventSlug;
      });
  }
  return pending;
}

/**
 * The event slug at runtime (v5). Starts with the build-time value so pages render at once,
 * then switches to what the server reports; the two are equal in every deployed setup that
 * sets `EVENT_SLUG` and `NEXT_PUBLIC_EVENT_SLUG` alike.
 */
export function useEventSlug(): string {
  const [slug, setSlug] = useState(resolved ?? eventSlug);
  useEffect(() => {
    let cancel = false;
    void loadEventSlug().then((value) => {
      if (!cancel) setSlug(value);
    });
    return () => {
      cancel = true;
    };
  }, []);
  return slug;
}
