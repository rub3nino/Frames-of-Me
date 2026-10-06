"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { pathForRole } from "@/lib/paths";
import type { User } from "@/lib/types";

const inflight = new Map<string, Promise<User>>();

function Verify() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Manca il token nel link.");
      return;
    }
    let alive = true;
    let pending = inflight.get(token);
    if (!pending) {
      pending = api<{ user: User }>("/v1/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
      }).then((data) => data.user);
      inflight.set(token, pending);
    }
    pending
      .then((user) => {
        try {
          sessionStorage.setItem("rephoto.user", JSON.stringify(user));
        } catch {
          /* private mode */
        }
        if (alive) router.replace(pathForRole(user.role));
      })
      .catch((cause: unknown) => {
        inflight.delete(token);
        if (alive) setError(cause instanceof ApiError ? cause.message : "Link non valido.");
      });
    return () => {
      alive = false;
    };
  }, [router, token]);

  return (
    <Shell>
      <h1>Accesso</h1>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : (
        <p className="status">Accesso in corso</p>
      )}
    </Shell>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <h1>Accesso</h1>
          <p className="status">Accesso in corso</p>
        </Shell>
      }
    >
      <Verify />
    </Suspense>
  );
}
