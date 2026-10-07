"use client";

import type { AdminEvent } from "@/lib/types";

/** Shared bits of the admin sections (v5). */

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export function EventNeeded({ event }: { event: AdminEvent | null }) {
  if (event) return null;
  return <p className="note">Scegli un evento nella sezione Eventi.</p>;
}

export const reasonText: Record<string, string> = {
  no_face: "Nel selfie non si vede un volto",
  face_too_small: "Avvicinati alla camera",
  low_quality: "Il selfie è sfocato o troppo scuro",
  multiple_faces: "Nel selfie ci sono più persone",
  no_photos_yet: "Non ci sono ancora foto: ti avviseremo",
  liveness: "Il selfie non è stato accettato",
};
