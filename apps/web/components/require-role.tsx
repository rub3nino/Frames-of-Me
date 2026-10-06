"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { pathForRole } from "@/lib/paths";

export function Gate({ kind }: { kind: "anon" | "wrong" }) {
  if (kind === "anon") {
    return (
      <div className="stack">
        <h1>Serve l&apos;accesso</h1>
        <p className="lede">Chiedi un link con la tua email.</p>
        <div className="actions">
          <Link className="button primary" href="/">
            Chiedi il link
          </Link>
        </div>
      </div>
    );
  }

  const stored = readStoredRole();
  return (
    <div className="stack">
      <h1>Pagina non disponibile</h1>
      <p className="lede">Il tuo accesso porta altrove.</p>
      <div className="actions">
        <Link className="button primary" href={stored ? pathForRole(stored) : "/"}>
          Continua
        </Link>
      </div>
    </div>
  );
}

export function RequireRole({
  role,
  probe,
  children,
}: {
  role: Role;
  probe: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<"loading" | "ok" | "anon" | "wrong">("loading");

  useEffect(() => {
    let cancel = false;
    api(probe)
      .then(() => {
        if (!cancel) setState("ok");
      })
      .catch((error: unknown) => {
        if (cancel) return;
        if (error instanceof ApiError && error.status === 403) setState("wrong");
        else setState("anon");
      });
    return () => {
      cancel = true;
    };
  }, [probe, role]);

  if (state === "loading") return <p className="status">Caricamento</p>;
  if (state === "anon") return <Gate kind="anon" />;
  if (state === "wrong") return <Gate kind="wrong" />;
  return children;
}

function readStoredRole(): Role | null {
  try {
    const raw = sessionStorage.getItem("rephoto.user");
    if (!raw) return null;
    const role = (JSON.parse(raw) as { role?: Role }).role;
    if (role === "participant" || role === "photographer" || role === "admin") return role;
    return null;
  } catch {
    return null;
  }
}
