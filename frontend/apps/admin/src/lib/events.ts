import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";

/* Shared across the event-scoped admin pages (Foto, Gallerie, Gestione, GDPR).
   The real admin browse endpoints (GET /v1/admin/photos, /v1/admin/galleries)
   require an eventId, so these pages pick an event first. The choice is kept in
   sessionStorage so it survives navigation between the pages. */
const KEY = "rephoto.admin.eventId";

export type AdminEvent = {
  id: string;
  slug: string;
  name: string;
  access: "open" | "list";
  retentionDays: number;
  photos: number;
  galleries: number;
  participants: number;
  photographers: number;
  createdAt: string;
};

export function useAdminEvents() {
  const nav = useNavigate();
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [eventId, setEventIdState] = useState<string>(() => {
    try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
  });
  const [err, setErr] = useState("");

  useEffect(() => {
    api.adminEvents()
      .then((d: any) => {
        const list: AdminEvent[] = d.events || [];
        setEvents(list);
        setEventIdState((cur) => {
          if (cur && list.some((e) => e.id === cur)) return cur;
          const first = list[0]?.id || "";
          try { if (first) sessionStorage.setItem(KEY, first); } catch {}
          return first;
        });
      })
      .catch((e: any) => {
        if (e?.status === 401 || e?.status === 403) nav("/");
        else setErr("Impossibile caricare gli eventi.");
      });
  }, [nav]);

  const setEventId = (id: string) => {
    setEventIdState(id);
    try { sessionStorage.setItem(KEY, id); } catch {}
  };

  const current = events?.find((e) => e.id === eventId) || null;
  return { events, eventId, setEventId, current, err };
}
