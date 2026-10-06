"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function SignOut() {
  const [pending, setPending] = useState(false);

  async function out() {
    setPending(true);
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } catch {
      /* leave anyway */
    }
    window.location.href = "/";
  }

  return (
    <button type="button" className="linkish" onClick={() => void out()} disabled={pending}>
      Esci
    </button>
  );
}
