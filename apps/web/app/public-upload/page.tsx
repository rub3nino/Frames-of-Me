"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { useEventSlug } from "@/lib/event";
import { contentTypeOf, sha256Hex, uploadOriginal } from "@/lib/upload";
import type { EventInfo } from "@/lib/types";

export default function PublicUploadPage() {
  const slug = useEventSlug();
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<EventInfo>(`/v1/events/${encodeURIComponent(slug)}`)
      .then(setEvent)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "Evento non disponibile."));
  }, [slug]);

  async function onChange(file: File | undefined) {
    if (!file || !event) return;
    const type = contentTypeOf(file);
    if (!type) {
      setError("Sono accettati solo file JPEG o PNG.");
      return;
    }
    setError(null);
    try {
      setStatus("Calcolo checksum…");
      const hash = await sha256Hex(file);
      setStatus("Caricamento…");
      await uploadOriginal(file, event.id, type, hash, () => undefined, undefined, "public");
      setStatus("Foto caricata nella galleria pubblica.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Caricamento non riuscito.");
      setStatus("");
    }
  }

  return (
    <Shell signOut>
      <section className="stack">
        <h1>Condividi una foto</h1>
        <p className="lede">La foto sarà visibile nella galleria pubblica dell’evento.</p>
        <label className="button primary" htmlFor="public-photo">Scegli una foto</label>
        <input id="public-photo" type="file" accept="image/jpeg,image/png" hidden onChange={(event) => void onChange(event.target.files?.[0])} />
        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="alert" role="alert">{error}</p> : null}
      </section>
    </Shell>
  );
}
