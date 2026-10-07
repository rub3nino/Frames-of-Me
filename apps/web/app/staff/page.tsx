"use client";

import { useState } from "react";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";

type StaffRole = "photographer" | "admin";

/** Staff sign-in (v5): the home page is for participants only, so photographers and admins ask here. */
export default function StaffPage() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("photographer");
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
        body: JSON.stringify({ email: email.trim(), role }),
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
          <p className="lede">Il link vale venti minuti. Se l&apos;email non è tra lo staff non arriva nulla.</p>
        </div>
      ) : (
        <form className="stack" onSubmit={(event) => void onSubmit(event)}>
          <div>
            <h1>Accesso staff</h1>
            <p className="lede">Fotografi e amministratori. I partecipanti entrano dalla pagina iniziale.</p>
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
          <div className="segmented" role="radiogroup" aria-label="Ruolo">
            <button
              type="button"
              role="radio"
              aria-checked={role === "photographer"}
              onClick={() => setRole("photographer")}
            >
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
          <div className="actions">
            <button className="button primary" type="submit" disabled={pending}>
              {pending ? "Invio…" : "Mandami il link"}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}
