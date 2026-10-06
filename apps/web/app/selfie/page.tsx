"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { eventSlug } from "@/lib/event";
import { contentTypeOf } from "@/lib/upload";
import type { GalleryResponse } from "@/lib/types";

const CONSENT_TEXT_VERSION = "2026-10-06";
const SELFIE_FIELD_NAME = "selfie";

const CONSENT_TEXT =
  "Acconsento al confronto temporaneo del mio volto con le foto dell'evento per trovare gli scatti in cui compaio. Il selfie viene cancellato subito dopo la ricerca. Le foto restano disponibili per 90 giorni.";

type Phase = "consent" | "capture" | "result";

export default function SelfiePage() {
  return (
    <Shell signOut>
      <RequireRole role="participant" probe={`/v1/events/${eventSlug}/gallery`}>
        <SelfieFlow />
      </RequireRole>
    </Shell>
  );
}

function SelfieFlow() {
  const [phase, setPhase] = useState<Phase>("consent");
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function saveConsent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted) return;
    setPending(true);
    setError(null);
    try {
      await api(`/v1/events/${eventSlug}/consent`, {
        method: "POST",
        body: JSON.stringify({ textVersion: CONSENT_TEXT_VERSION, accepted: true }),
      });
      setPhase("capture");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a salvare il consenso.");
    } finally {
      setPending(false);
    }
  }

  function choose(next: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    if (!next) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!contentTypeOf(next)) {
      setError("Usa un jpeg o un png.");
      return;
    }
    setError(null);
    setFile(next);
    setPreview(URL.createObjectURL(next));
  }

  async function sendSelfie(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const type = contentTypeOf(file);
    if (!type) {
      setError("Usa un jpeg o un png.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      body.set(SELFIE_FIELD_NAME, file, file.name || (type === "image/png" ? "selfie.png" : "selfie.jpg"));
      await api(`/v1/events/${eventSlug}/selfie`, {
        method: "POST",
        body,
      });
      setPhase("result");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a inviare il selfie.");
    } finally {
      setPending(false);
    }
  }

  if (phase === "consent") {
    return (
      <form className="stack" onSubmit={(event) => void saveConsent(event)}>
        <div>
          <h1>Consenso</h1>
          <p className="fine">
            Puoi ritirare il consenso quando vuoi: si possono cancellare account e ricerche.
          </p>
        </div>
        <label className="consent">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>{CONSENT_TEXT}</span>
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button className="button primary" type="submit" disabled={!accepted || pending}>
            {pending ? "Salvo…" : "Conferma il consenso"}
          </button>
        </div>
      </form>
    );
  }

  if (phase === "capture") {
    return (
      <form className="stack" onSubmit={(event) => void sendSelfie(event)}>
        <div>
          <h1>Selfie</h1>
          <p className="lede">Un primo piano, in jpeg o png, fino a 8 MB.</p>
        </div>
        <input
          ref={inputRef}
          className="sr"
          type="file"
          accept="image/jpeg,image/png"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
        {preview ? (
          <img className="preview" src={preview} alt="Anteprima del selfie" />
        ) : null}
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          {file ? (
            <button className="button primary" type="submit" disabled={pending}>
              {pending ? "Invio…" : "Invia il selfie"}
            </button>
          ) : (
            <button className="button primary" type="button" onClick={() => inputRef.current?.click()}>
              Scatta o scegli
            </button>
          )}
        </div>
        {file ? (
          <button className="linkish" type="button" onClick={() => inputRef.current?.click()}>
            Scegli un&apos;altra
          </button>
        ) : null}
      </form>
    );
  }

  return <SearchResult onRetry={() => setPhase("capture")} />;
}

function SearchResult({ onRetry }: { onRetry: () => void }) {
  const [gallery, setGallery] = useState<GalleryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const data = await api<GalleryResponse>(`/v1/events/${eventSlug}/gallery`);
        if (stop) return;
        setGallery(data);
        if (data.status === "ready") stop = true;
      } catch (cause) {
        if (!stop) {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere lo stato.");
        }
      }
    }
    void tick();
    const id = window.setInterval(() => {
      if (!stop) void tick();
    }, 2500);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const ready = gallery?.status === "ready";

  return (
    <div className="stack">
      <h1>Ti mandiamo il link</h1>
      <p className="lede">
        {ready
          ? "Puoi aprirle ora. Il link resta anche nella posta."
          : "Il confronto è in corso. Puoi chiudere questa pagina: il link arriva per posta."}
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        {ready ? (
          <Link className="button primary" href={`/e/${eventSlug}`}>
            Apri le foto
          </Link>
        ) : error ? (
          <button className="button primary" type="button" onClick={onRetry}>
            Riprova
          </button>
        ) : (
          <p className="status">Confronto in corso</p>
        )}
      </div>
    </div>
  );
}
