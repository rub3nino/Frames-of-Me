import { useEffect, useState } from "react";
// @ts-ignore plain module
import { createClient } from "@api";

/** The demo event the whole portal is pinned to today. A real event selector
 * is a GAP: GET /v1/photographer/events (event_photographers join). */
export const EVENT_SLUG = "demo";

export type ActiveEvent = { id: string; slug: string; name: string } | null;

/**
 * Resolves the active event id the same way Upload.tsx does (api.getEvent(slug)).
 * Returns { event, loading, error }. Never throws.
 */
export function useActiveEvent() {
  const [event, setEvent] = useState<ActiveEvent>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const api = createClient();
    api
      .getEvent(EVENT_SLUG)
      .then((e: any) => { if (alive) { setEvent({ id: e.id, slug: e.slug, name: e.name }); setLoading(false); } })
      .catch(() => { if (alive) { setError(true); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  return { event, loading, error };
}
