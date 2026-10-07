"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { pathForRole } from "@/lib/paths";
import type { User } from "@/lib/types";

/**
 * Participant self-registration (v6, B3) and the landing page of the password-reset mail.
 *
 * Registration needs the event code printed on the badge/QR and sends no e-mail at all:
 * `users.email_verified_at` stays null until the address is proven. With `?reset=<token>`
 * this page is instead the second half of a password reset.
 */
/**
 * Kept in step with `PASSWORD_MIN_LENGTH` in `packages/contracts/src/http.ts`. It is not
 * imported: `tsc` in this app cannot read the contracts sources, which use `.ts` import
 * specifiers (see `transpilePackages` in next.config.ts — Next transpiles, tsc does not).
 */
const PASSWORD_MIN_LENGTH = 10;

function Register() {
  const router = useRouter();
  const params = useSearchParams();
  const resetToken = params.get("reset") ?? "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [eventCode, setEventCode] = useState(params.get("codice") ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function enter(user: User) {
    try {
      sessionStorage.setItem("rephoto.user", JSON.stringify(user));
    } catch {
      /* private mode */
    }
    router.replace(pathForRole(user.role));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const data = resetToken
        ? await api<{ user: User }>("/v1/auth/password-reset/confirm", {
            method: "POST",
            body: JSON.stringify({ token: resetToken, password }),
          })
        : await api<{ user: User }>("/v1/auth/register", {
            method: "POST",
            body: JSON.stringify({
              email: email.trim(),
              password,
              eventCode: eventCode.trim(),
            }),
          });
      enter(data.user);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Qualcosa non ha funzionato. Riprova.",
      );
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={(event) => void onSubmit(event)}>
      <div>
        <h1>{resetToken ? "Nuova password" : "Registrati"}</h1>
        <p className="lede">
          {resetToken
            ? "Scegli una nuova password: almeno dieci caratteri."
            : "Serve il codice stampato sul badge dell’evento."}
        </p>
      </div>
      {resetToken ? null : (
        <>
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
            Codice evento
            <input
              type="text"
              name="eventCode"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              value={eventCode}
              onChange={(event) => setEventCode(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
        </>
      )}
      <label>
        Password
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <p className="note">Almeno {PASSWORD_MIN_LENGTH} caratteri.</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Attendi…" : resetToken ? "Salva la password" : "Crea l’account"}
        </button>
      </div>
      <p className="note">
        <Link className="linkish" href="/">
          Hai già un account? Accedi
        </Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="stack">
            <h1>Registrati</h1>
            <p className="status">Caricamento</p>
          </div>
        }
      >
        <Register />
      </Suspense>
    </Shell>
  );
}
