import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Mark, isEmail } from "../ui";

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // magic-link fallback
  const [linkMode, setLinkMode] = useState(false);
  const [sent, setSent] = useState(false);

  async function loginWithPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email) || !password || busy) return;
    setBusy(true); setErr("");
    try {
      sessionStorage.setItem("rephoto.email", email.trim());
      await api.login(email.trim(), password, "admin");
      nav("/admin");
    } catch (e: any) {
      setErr(e?.status === 401 ? "Email o password non corrette." : "Accesso non riuscito. Riprova.");
    } finally { setBusy(false); }
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email) || busy) return;
    setBusy(true); setErr("");
    try {
      sessionStorage.setItem("rephoto.email", email.trim());
      await api.requestLink(email.trim(), "admin");
      setSent(true);
    } catch (e: any) {
      setErr(e?.status === 400 ? "Questo indirizzo non è abilitato come staff." : "Non riusciamo a inviare il link.");
    } finally { setBusy(false); }
  }

  return (
    <div className="ad-auth">
      <div className="card">
        <div className="row" style={{ gap: 8, marginBottom: "var(--s-5)" }}>
          <span style={{ width: 28, height: 28, display: "inline-flex", color: "var(--c-ink)" }}><Mark /></span>
          <b style={{ fontSize: "1.0625rem", letterSpacing: "-0.01em" }}>RePhoto</b>
        </div>

        {sent ? (
          <><h2 style={{ marginBottom: "var(--s-2)" }}>Controlla la posta</h2><p className="muted">Apri il link e tocca “Entra”.</p></>
        ) : linkMode ? (
          <form className="stack" onSubmit={sendLink}>
            <div><h2 style={{ marginBottom: "var(--s-2)" }}>Link di accesso</h2><p className="muted">Ti inviamo un link via email, senza password.</p></div>
            <div className="field"><label className="label">Email</label><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@bakertilly.it" /></div>
            {err && <div className="banner banner-danger"><span>{err}</span></div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={!isEmail(email) || busy} data-press>{busy ? "Invio…" : "Inviami il link"}</button>
            <button className="btn btn-ghost btn-block" type="button" onClick={() => { setLinkMode(false); setErr(""); }}>← Accedi con le credenziali</button>
          </form>
        ) : (
          <form className="stack" onSubmit={loginWithPassword}>
            <div><h2 style={{ marginBottom: "var(--s-2)" }}>Area staff</h2><p className="muted">Accedi con le tue credenziali.</p></div>
            <div className="field"><label className="label">Email</label><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@bakertilly.it" /></div>
            <div className="field"><label className="label">Password</label><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></div>
            {err && <div className="banner banner-danger"><span>{err}</span></div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={!isEmail(email) || !password || busy} data-press>{busy ? "Accesso…" : "Accedi"}</button>
            <button className="btn btn-ghost btn-block" type="button" onClick={() => { setLinkMode(true); setErr(""); }}>Accedi con un link via email</button>
          </form>
        )}
      </div>
    </div>
  );
}
