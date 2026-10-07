"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { pathForRole } from "@/lib/paths";
import type { User } from "@/lib/types";

/**
 * Magic-link sign-in. Since v6 nothing links here — the home page offers Google and
 * e-mail + password — but the path stays working on purpose: it is the event-day fallback
 * documented in RUN.md, reachable by typing the URL or by following a mailed link.
 */
const inflight = new Map<string, Promise<User>>();

function Verify() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "Manca il token nel link.");

  function enter() {
    if (!token || pending) return;
    setPending(true);
    setError(null);
    let request = inflight.get(token);
    if (!request) {
      request = api<{ user: User }>("/v1/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
      }).then((data) => data.user);
      inflight.set(token, request);
    }
    request
      .then((user) => {
        try {
          sessionStorage.setItem("rephoto.user", JSON.stringify(user));
        } catch {
          /* private mode */
        }
        router.replace(pathForRole(user.role));
      })
      .catch((cause: unknown) => {
        inflight.delete(token);
        setPending(false);
        setError(cause instanceof ApiError ? cause.message : "Link non valido.");
      });
  }

  return (
    <Shell>
      <div className="stack">
        <div>
          <h1>Accesso</h1>
          <p className="lede">Tocca il pulsante per entrare.</p>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button className="button primary" type="button" onClick={enter} disabled={!token || pending}>
            {pending ? "Accesso in corso…" : "Entra"}
          </button>
        </div>
      </div>
    </Shell>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <h1>Accesso</h1>
          <p className="status">Caricamento</p>
        </Shell>
      }
    >
      <Verify />
    </Suspense>
  );
}
