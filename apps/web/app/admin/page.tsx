"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminEvent, AdminEventsResponse } from "@/lib/types";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { useEventSlug } from "@/lib/event";
import { EventsSection } from "@/components/admin/events";
import { LinksSection } from "@/components/admin/links";
import { GalleriesSection } from "@/components/admin/galleries";
import { PhotosSection } from "@/components/admin/photos";
import { StatusSection } from "@/components/admin/status";
import { ExportSection } from "@/components/admin/export";
import { ResetSection } from "@/components/admin/reset";
import { ManageSection } from "@/components/admin/manage";
// v6 D (agent D): admin console — albums, event codes, moderation, live status,
// participants, operations.
import { AlbumsSection } from "@/components/admin/albums";
import { CodesSection } from "@/components/admin/codes";
import { LiveSection } from "@/components/admin/live";
import { ModerationSection } from "@/components/admin/moderation";
import { OpsSection } from "@/components/admin/ops";
import { ParticipantsSection } from "@/components/admin/participants";

type Section =
  | "eventi"
  | "link"
  | "gallerie"
  | "foto"
  | "stato"
  | "esporta"
  | "gestione"
  | "reset"
  // v6 D (agent D)
  | "diretta"
  | "album"
  | "codici"
  | "moderazione"
  | "partecipanti"
  | "operazioni";

const SECTIONS: Array<{ key: Section; label: string }> = [
  // v6 D: the event-day screens come first — codes before the doors open, then the live
  // status and the moderation queue.
  { key: "diretta", label: "Diretta" },
  { key: "codici", label: "Codici evento" },
  { key: "album", label: "Album" },
  { key: "moderazione", label: "Moderazione" },
  { key: "partecipanti", label: "Partecipanti" },
  { key: "stato", label: "Stato" },
  { key: "eventi", label: "Eventi" },
  { key: "link", label: "Link di accesso" },
  { key: "gallerie", label: "Gallerie" },
  { key: "foto", label: "Foto" },
  { key: "esporta", label: "Esporta" },
  { key: "gestione", label: "Gestione" },
  { key: "reset", label: "Reset" },
  { key: "operazioni", label: "Operazioni" },
];

const DEFAULT_SECTION: Section = "diretta";

function readHash(): Section {
  if (typeof window === "undefined") return DEFAULT_SECTION;
  const raw = window.location.hash.replace(/^#/, "");
  return SECTIONS.some((section) => section.key === raw) ? (raw as Section) : DEFAULT_SECTION;
}

export default function AdminPage() {
  return (
    <Shell wide signOut>
      <RequireRole role="admin" probe="/v1/admin/metrics">
        <AdminHome />
      </RequireRole>
    </Shell>
  );
}

/**
 * Admin console (v5). Every section works on the selected event, which defaults to the
 * runtime slug (`/api/config`) and can be switched from the Eventi section.
 */
function AdminHome() {
  const runtimeSlug = useEventSlug();
  const [section, setSection] = useState<Section>(DEFAULT_SECTION);
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSection(readHash());
    const onHash = () => setSection(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancel = false;
    api<AdminEventsResponse>("/v1/admin/events")
      .then((data) => {
        if (cancel) return;
        setEvents(data.events);
        setEventsError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) setEventsError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere gli eventi.");
      });
    return () => {
      cancel = true;
    };
  }, [attempt]);

  const selected =
    events?.find((event) => event.id === selectedId) ??
    events?.find((event) => event.slug === runtimeSlug) ??
    events?.[0] ??
    null;

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  function go(next: Section) {
    setSection(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  return (
    <div className="admin">
      <div className="admin-head">
        <h1>Amministrazione</h1>
        <p className="meta">
          {selected ? (
            <>
              Evento <code>{selected.slug}</code> · {selected.name}
            </>
          ) : (
            "Nessun evento selezionato"
          )}
        </p>
      </div>
      <nav className="tabs" aria-label="Sezioni">
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="tab"
            aria-current={section === item.key ? "page" : undefined}
            onClick={() => go(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {section === "stato" ? <StatusSection /> : null}
      {section === "eventi" ? (
        <EventsSection
          events={events}
          selected={selected}
          error={eventsError}
          onSelect={(event) => setSelectedId(event.id)}
          onCreated={refresh}
        />
      ) : null}
      {section === "link" ? <LinksSection event={selected} /> : null}
      {section === "gallerie" ? <GalleriesSection event={selected} /> : null}
      {section === "foto" ? <PhotosSection event={selected} /> : null}
      {section === "esporta" ? <ExportSection event={selected} /> : null}
      {section === "gestione" ? <ManageSection event={selected} onChanged={refresh} /> : null}
      {section === "reset" ? <ResetSection event={selected} onDone={refresh} /> : null}
      {section === "diretta" ? <LiveSection event={selected} /> : null}
      {section === "codici" ? <CodesSection event={selected} /> : null}
      {section === "album" ? <AlbumsSection event={selected} /> : null}
      {section === "moderazione" ? <ModerationSection event={selected} /> : null}
      {section === "partecipanti" ? <ParticipantsSection event={selected} /> : null}
      {section === "operazioni" ? <OpsSection /> : null}
    </div>
  );
}
