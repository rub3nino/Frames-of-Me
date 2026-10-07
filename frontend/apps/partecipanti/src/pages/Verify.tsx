import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Screen } from "../ui";
import { api } from "../lib/api";

export default function Verify() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const token = sp.get("token") || "";
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);

  // Anti-scanner: we do NOT consume the token on load; only on the explicit click.
  async function enter() {
    if (!token) { setBad(true); return; }
    setBusy(true); setBad(false);
    try {
      await api.verify(token); // POST /v1/auth/verify -> sets the session cookie
      nav("/selfie");
    } catch (e) {
      setBad(true);
    } finally { setBusy(false); }
  }

  return (
    <Screen center>
      <div className="card" style={{ textAlign: "center" }}>
        {!bad ? (
          <>
            <h1 style={{ marginBottom: "var(--s-2)" }}>Bentornato</h1>
            <p className="dek" style={{ marginBottom: "var(--s-5)" }}>Tocca per entrare e vedere le tue foto.</p>
            <button className="btn btn-primary btn-lg btn-block" onClick={enter} disabled={busy} data-press>
              {busy ? "Accesso…" : "Entra"}
            </button>
          </>
        ) : (
          <>
            <div className="banner banner-danger" style={{ textAlign: "left" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" /></svg>
              <span>Questo link non è più valido.</span>
            </div>
            <button className="btn btn-primary btn-block" style={{ marginTop: "var(--s-4)" }} onClick={() => nav("/")} data-press>
              Richiedi un nuovo link
            </button>
          </>
        )}
      </div>
    </Screen>
  );
}
