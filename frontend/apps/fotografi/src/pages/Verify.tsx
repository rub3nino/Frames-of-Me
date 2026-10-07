import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
// @ts-ignore plain module
import { createClient } from "@api";
import { Mark } from "../ui";

const api = createClient();

export default function Verify() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const token = sp.get("token") || "";
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);

  async function enter() {
    if (!token) { setBad(true); return; }
    setBusy(true); setBad(false);
    try { await api.verify(token); nav("/upload"); }
    catch { setBad(true); }
    finally { setBusy(false); }
  }

  return (
    <div className="fz-auth">
      <div className="card" style={{ textAlign: "center" }}>
        <span style={{ width: 30, height: 30, display: "inline-flex", color: "var(--c-ink)", margin: "0 auto var(--s-4)" }}><Mark /></span>
        {!bad ? (
          <>
            <h2 style={{ marginBottom: "var(--s-2)" }}>Bentornato</h2>
            <p className="muted" style={{ marginBottom: "var(--s-5)" }}>Tocca per entrare e caricare le foto.</p>
            <button className="btn btn-primary btn-lg btn-block" onClick={enter} disabled={busy} data-press>{busy ? "Accesso…" : "Entra"}</button>
          </>
        ) : (
          <>
            <div className="banner banner-danger" style={{ textAlign: "left" }}><span>Questo link non è più valido.</span></div>
            <button className="btn btn-primary btn-block" style={{ marginTop: "var(--s-4)" }} onClick={() => nav("/")} data-press>Richiedi un nuovo link</button>
          </>
        )}
      </div>
    </div>
  );
}
