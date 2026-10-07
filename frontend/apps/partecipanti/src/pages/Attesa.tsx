import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen, maskEmail } from "../ui";
import { api } from "../lib/api";

export default function Attesa() {
  const nav = useNavigate();
  const email = sessionStorage.getItem("rephoto.email") || "";
  const [left, setLeft] = useState(30);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  async function resend() {
    if (left > 0 || !email) return;
    try { await api.requestLink(email, "participant"); } catch (e) { console.warn(e); }
    setSent(true); setLeft(30);
  }

  return (
    <Screen center>
      <div className="stack" style={{ textAlign: "center" }}>
        <svg className="center-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" />
        </svg>
        <h1>Controlla la posta</h1>
        <p className="dek">Abbiamo inviato un link di accesso a <span className="masked">{email ? maskEmail(email) : "la tua email"}</span>. Apri il link e tocca “Entra”.</p>
        <div className="stack" style={{ marginTop: "var(--s-5)" }}>
          <button className="btn btn-secondary btn-block" onClick={resend} disabled={left > 0} data-press>
            {left > 0 ? `Invia di nuovo tra ${left}s` : sent ? "Inviato di nuovo" : "Invia di nuovo"}
          </button>
          <button className="muted-link" onClick={() => nav("/")}>Email sbagliata? Cambiala</button>
        </div>
      </div>
    </Screen>
  );
}
