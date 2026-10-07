"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import type { User } from "@/lib/types";

const inflight = new Map<string, Promise<User>>();

function Invite() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "Manca il token nel link.");

  function accept() {
    if (!token || pending) return;
    setPending(true);
    setError(null);
    let request = inflight.get(token);
    if (!request) {
      request = api<{ user: User }>("/v1/auth/accept-invite", {
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
        router.replace("/upload");
      })
      .catch((cause: unknown) => {
        inflight.delete(token);
        setPending(false);
        setError(cause instanceof ApiError ? cause.message : "Invito non valido.");
      });
  }

  return (
    <Shell>
      <div className="stack">
        <div>
          <h1>Invito</h1>
          <p className="lede">Sei stato invitato a caricare le foto di un evento.</p>
        </div>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button className="button primary" type="button" onClick={accept} disabled={!token || pending}>
            {pending ? "Accetto…" : "Accetta l'invito"}
          </button>
        </div>
      </div>
    </Shell>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <h1>Invito</h1>
          <p className="status">Caricamento</p>
        </Shell>
      }
    >
      <Invite />
    </Suspense>
  );
}
