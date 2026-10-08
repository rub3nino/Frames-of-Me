"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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

const ALBUM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HOW A PARTICIPANT REACHES THE CROWD ALBUM. Nothing in this app used to build an
 * `/album/<uuid>` url, so the album was unreachable unless someone was handed a uuid, and
 * this page is the only screen every participant passes through.
 *
 * There is no participant-facing route that lists an event's albums — `GET
 * /v1/admin/events/:id/albums` is staff-only — so the album id has to arrive from outside.
 * Two ways in, and both are deliberate:
 *
 *  1. `/?album=<uuid>`, the deep link a table card or badge QR carries. After signing in,
 *     the participant lands in that album instead of at `/selfie`, and if they are already
 *     signed in they go straight there. The id is validated as a uuid before it is used.
 *  2. `NEXT_PUBLIC_CROWD_ALBUM_ID`, a standing link shown under the form, for a deployment
 *     that has one crowd album for the whole event — which is how this app is already
 *     deployed, one event per instance (`NEXT_PUBLIC_EVENT_SLUG`). It only ADDS a link; it
 *     never changes where a normal sign-in goes, because the primary flow is still selfie →
 *     personal matches.
 *
 * Neither makes the album public. `GET /v1/albums/:id/photos` still requires a participant
 * session and membership of the event, and `visibility = 'link'` means "not listed", never
 * "readable by anyone with the url". The link is a way to find the album, not a way in.
 */
const CROWD_ALBUM_ID = ALBUM_ID.test(process.env.NEXT_PUBLIC_CROWD_ALBUM_ID ?? "")
  ? (process.env.NEXT_PUBLIC_CROWD_ALBUM_ID as string)
  : null;

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

  /** The scanned album, if this page was opened as `/?album=<uuid>`. */
  const albumParam = params.get("album");
  const album = albumParam && ALBUM_ID.test(albumParam) ? albumParam : null;
  const albumHref = album ?? CROWD_ALBUM_ID;

  // Already signed in and arriving from the card: go to the album without asking again.
  // One request, and only on the deep-link path; a failure just leaves the form visible.
  useEffect(() => {
    if (!album) return;
    let cancel = false;
    void api(`/v1/albums/${album}/photos?limit=1`)
      .then(() => {
        if (!cancel) router.replace(`/album/${album}`);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [album, router]);

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
      // The scanned album wins over the role's usual landing page: it is what they asked for.
      router.replace(album ? `/album/${album}` : pathForRole(data.user.role));
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
        {album ? (
          <p className="note">Dopo l&apos;accesso entri nell&apos;album di tutti.</p>
        ) : null}
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
      {albumHref && !album ? (
        <p className="note">
          <Link className="linkish" href={`/album/${albumHref}`}>
            Album di tutti: le foto dei partecipanti
          </Link>
        </p>
      ) : null}
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
