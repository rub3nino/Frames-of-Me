import { useState } from "react";
import { Shell, isEmail } from "../ui";
import { api } from "../lib/api";

export default function LinkAccesso() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("photographer");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  // --- Credentials (email + password) ---
  const [cEmail, setCEmail] = useState("");
  const [cRole, setCRole] = useState("photographer");
  const [cPass, setCPass] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState("");
  const [cOk, setCOk] = useState("");

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email) || busy) return;
    setBusy(true); setErr(""); setUrl(""); setCopied(false);
    try {
      const d: any = await api.adminMintLink(email.trim(), role); // POST /v1/admin/magic-links
      setUrl(d.url);
    } catch (e: any) { setErr(e?.message || "Non riusciamo a generare il link."); }
    finally { setBusy(false); }
  }

  function randomPass() {
    const a = "abcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    const buf = new Uint32Array(14);
    crypto.getRandomValues(buf);
    for (const n of buf) s += a[n % a.length];
    setCPass(s);
  }

  async function createStaff(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(cEmail) || cPass.length < 8 || cBusy) return;
    setCBusy(true); setCErr(""); setCOk("");
    try {
      await api.adminCreateStaff(cEmail.trim(), cRole, cPass); // POST /v1/admin/staff
      setCOk(`Credenziali salvate per ${cEmail.trim()} (${cRole === "admin" ? "Amministratore" : "Fotografo"}). Consegna email e password alla persona.`);
    } catch (e: any) {
      setCErr(e?.status === 400 ? "Dati non validi (password: almeno 8 caratteri)." : e?.message || "Non riusciamo a salvare le credenziali.");
    } finally { setCBusy(false); }
  }

  return (
    <Shell title="Accessi staff">
      <p className="ad-top sub" style={{ marginTop: "-16px", marginBottom: "var(--s-6)" }}>Crea credenziali (email + password) per admin e fotografi, oppure genera un link di accesso una tantum.</p>

      <div style={{ display: "grid", gap: "var(--s-5)", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", alignItems: "start" }}>

        {/* Credenziali con password */}
        <div className="card">
          <h3 style={{ marginBottom: "var(--s-1)" }}>Credenziali con password</h3>
          <p className="muted" style={{ marginBottom: "var(--s-4)" }}>La persona accede con email e password dalla sua area (fotografi / admin).</p>
          <form className="stack" onSubmit={createStaff}>
            <div className="field"><label className="label">Email</label><input className="input" type="email" value={cEmail} onChange={(e) => setCEmail(e.target.value)} placeholder="nome@studio.it" /></div>
            <div className="field"><label className="label">Ruolo</label>
              <select className="select" value={cRole} onChange={(e) => setCRole(e.target.value)}>
                <option value="photographer">Fotografo</option>
                <option value="admin">Amministratore</option>
              </select>
            </div>
            <div className="field"><label className="label">Password (min 8)</label>
              <div className="row" style={{ gap: "var(--s-2)" }}>
                <input className="input mono" style={{ fontSize: "var(--fs-sm)" }} type="text" value={cPass} onChange={(e) => setCPass(e.target.value)} placeholder="almeno 8 caratteri" />
                <button className="btn btn-secondary btn-sm" type="button" onClick={randomPass}>Genera</button>
              </div>
            </div>
            {cErr && <div className="banner banner-danger"><span>{cErr}</span></div>}
            {cOk && <div className="banner banner-success"><span>{cOk}</span></div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={!isEmail(cEmail) || cPass.length < 8 || cBusy} data-press>{cBusy ? "Salvo…" : "Crea / aggiorna credenziali"}</button>
          </form>
        </div>

        {/* Link una tantum */}
        <div className="card">
          <h3 style={{ marginBottom: "var(--s-1)" }}>Link di accesso una tantum</h3>
          <p className="muted" style={{ marginBottom: "var(--s-4)" }}>Magic link per qualsiasi email e ruolo. Non viene inviato per email: lo condividi tu.</p>
          <form className="stack" onSubmit={mint}>
            <div className="field"><label className="label">Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@email.it" /></div>
            <div className="field"><label className="label">Ruolo</label>
              <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="participant">Partecipante</option>
                <option value="photographer">Fotografo</option>
                <option value="admin">Amministratore</option>
              </select>
            </div>
            {err && <div className="banner banner-danger"><span>{err}</span></div>}
            <button className="btn btn-primary btn-block" type="submit" disabled={!isEmail(email) || busy} data-press>{busy ? "Genero…" : "Genera link"}</button>
          </form>
          {url && (
            <div style={{ marginTop: "var(--s-5)", paddingTop: "var(--s-5)", borderTop: "1px solid var(--c-line)" }}>
              <label className="label" style={{ display: "block", marginBottom: "var(--s-2)" }}>Link generato</label>
              <div className="row" style={{ gap: "var(--s-2)" }}>
                <input className="input mono" style={{ fontSize: "var(--fs-xs)" }} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? "Copiato" : "Copia"}</button>
              </div>
            </div>
          )}
        </div>

      </div>
    </Shell>
  );
}
