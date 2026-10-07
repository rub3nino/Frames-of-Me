"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { AdminEvent, AdminMagicLinkResponse, Role } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded } from "@/components/admin/shared";

/** Issues a raw magic link (never mailed) and shows it as a QR for the room. */
export function LinksSection({ event }: { event: AdminEvent | null }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("participant");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; role: Role; url: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let cancel = false;
    QRCode.toDataURL(link.url, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((data) => {
        if (!cancel) setQr(data);
      })
      .catch(() => {
        if (!cancel) setQr(null);
      });
    return () => {
      cancel = true;
    };
  }, [link]);

  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setCopied(false);
    try {
      const data = await api<AdminMagicLinkResponse>("/v1/admin/magic-links", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          role,
          ...(event && role === "photographer" ? { eventId: event.id } : {}),
        }),
      });
      setLink({ email: email.trim().toLowerCase(), role, url: data.url });
    } catch (cause) {
      setLink(null);
      setError(cause instanceof ApiError ? cause.message : "Emissione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="block">
      <h2>Link di accesso</h2>
      <p className="note">
        Il link vale venti minuti e non viene spedito: mostralo come QR o incollalo. Per i fotografi l&apos;utente
        viene creato e collegato all&apos;evento selezionato.
      </p>
      <EventNeeded event={event} />
      <form onSubmit={(e) => void issue(e)}>
        <label>
          Email
          <input
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Ruolo">
          <button type="button" role="radio" aria-checked={role === "participant"} onClick={() => setRole("participant")}>
            Partecipante
          </button>
          <button type="button" role="radio" aria-checked={role === "photographer"} onClick={() => setRole("photographer")}>
            Fotografo
          </button>
          <button type="button" role="radio" aria-checked={role === "admin"} onClick={() => setRole("admin")}>
            Amministratore
          </button>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending}>
            {pending ? "Emetto…" : "Emetti il link"}
          </button>
        </div>
      </form>
      {link ? (
        <div className="qr-card">
          {qr ? <img className="qr" src={qr} alt={`QR del link di accesso per ${link.email}`} /> : null}
          <p className="meta">
            {link.email} · {link.role}
          </p>
          <p className="link-text">
            <code>{link.url}</code>
          </p>
          <div className="actions inline">
            <button type="button" className="button quiet" onClick={() => void copy()}>
              {copied ? "Copiato" : "Copia il link"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
