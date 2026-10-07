"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { pathForRole } from "@/lib/paths";
import type { User } from "@/lib/types";

/**
 * Participant sign-in (v6). Google, or e-mail + password from `/registrati`.
 *
 * The magic link is gone from this page on purpose: it stays as the event-day fallback on
 * `POST /v1/auth/request-link` + `/verify` (see RUN.md), it is what a password reset mails,
 * and it is still the only way in for an account created before v6.
 */
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_LOGIN === "true";

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"password" | "reset">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("google") === "annullato" ? "Accesso con Google annullato." : null,
  );

  async function onLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const data = await api<{ user: User }>("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password,
          role: "participant",
        }),
      });
      try {
        sessionStorage.setItem("rephoto.user", JSON.stringify(data.user));
      } catch {
        /* private mode */
      }
      router.replace(pathForRole(data.user.role));
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Qualcosa non ha funzionato. Riprova.",
      );
      setPending(false);
    }
  }

  async function onReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api("/v1/auth/password-reset", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Qualcosa non ha funzionato. Riprova.",
      );
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="stack">
        <h1>Controlla la posta</h1>
        <p className="lede">
          Se l&apos;indirizzo ha un account, arriva un link per scegliere una nuova password.
          Vale venti minuti.
        </p>
      </div>
    );
  }

  if (mode === "reset") {
    return (
      <form className="stack" onSubmit={(event) => void onReset(event)}>
        <div>
          <h1>Password dimenticata</h1>
          <p className="lede">Ti mandiamo un link per scegliere una nuova password.</p>
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
          <button
            className="linkish"
            type="button"
            onClick={() => {
              setMode("password");
              setError(null);
            }}
          >
            Torna all&apos;accesso
          </button>
        </p>
      </form>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void onLogin(event)}>
      <div>
        <h1>Trova le tue foto</h1>
        <p className="lede">Entra con Google o con la tua email.</p>
      </div>
      {GOOGLE_ENABLED ? (
        <div className="actions">
          {/* A full navigation, not fetch: the api answers 302 to accounts.google.com. */}
          <a className="button" href="/v1/auth/google/start">
            Accedi con Google
          </a>
        </div>
      ) : null}
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
      <label>
        Password
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
          {pending ? "Accesso…" : "Entra"}
        </button>
      </div>
      <p className="note">
        <Link className="linkish" href="/registrati">
          Non hai un account? Registrati
        </Link>
      </p>
      <p className="note">
        <button
          className="linkish"
          type="button"
          onClick={() => {
            setMode("reset");
            setError(null);
          }}
        >
          Password dimenticata?
        </button>
      </p>
      <p className="note">
        <Link className="linkish" href="/staff">
          Sei fotografo o staff?
        </Link>
      </p>
    </form>
  );
}

export default function HomePage() {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="stack">
            <h1>Trova le tue foto</h1>
            <p className="status">Caricamento</p>
          </div>
        }
      >
        <SignIn />
      </Suspense>
    </Shell>
  );
}
