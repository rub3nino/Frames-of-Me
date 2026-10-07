"use client";

import Link from "next/link";
import { useState } from "react";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";

export default function HomePage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/v1/auth/request-link", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role: "participant" }),
      });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Qualcosa non ha funzionato. Riprova.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell>
      {sent ? (
        <div className="stack">
          <h1>Controlla la posta</h1>
          <p className="lede">Il link vale venti minuti.</p>
        </div>
      ) : (
        <form className="stack" onSubmit={(event) => void onSubmit(event)}>
          <div>
            <h1>Trova le tue foto</h1>
            <p className="lede">Ti mandiamo un link per entrare.</p>
          </div>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button className="button primary" type="submit" disabled={pending}>
              {pending ? "Invio…" : "Mandami il link"}
            </button>
          </div>
          <p className="note">
            <Link className="linkish" href="/public-gallery">
              Galleria pubblica
            </Link>
            <br />
            <Link className="linkish" href="/public-upload">
              Condividi una foto
            </Link>
            <br />
            <Link className="linkish" href="/staff">
              Sei fotografo o staff?
            </Link>
          </p>
        </form>
      )}
    </Shell>
  );
}
