import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen, CheckIcon, isEmail } from "../ui";
import { api } from "../lib/api";

export default function Iscrizione() {
  const nav = useNavigate();
  const [age, setAge] = useState<"" | "adult" | "minor">("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ready = age !== "" && isEmail(email) && consent;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setErr("");
    sessionStorage.setItem("rephoto.email", email.trim());
    if (age === "minor") { nav("/consenso-genitore"); return; }
    setBusy(true);
    try {
      await api.requestLink(email.trim(), "participant"); // POST /v1/auth/request-link
      nav("/attesa");
    } catch (e: any) {
      if (e?.status === 429) setErr("Hai richiesto troppi link. Riprova tra un'ora.");
      else { console.warn(e); nav("/attesa"); } // proceed; link may still have been sent
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <form className="stack" onSubmit={submit} noValidate>
        <div>
          <h1>Trova le tue foto</h1>
          <p className="dek">Conferenza 2026 · 12–14 marzo 2026</p>
        </div>

        <div className="agecards" role="radiogroup" aria-label="La tua età">
          <label className={"agecard" + (age === "adult" ? " sel" : "")}>
            <input type="radio" name="age" checked={age === "adult"} onChange={() => setAge("adult")} />
            <span><span className="t">Ho 18 anni o più</span></span>
          </label>
          <label className={"agecard" + (age === "minor" ? " sel" : "")}>
            <input type="radio" name="age" checked={age === "minor"} onChange={() => setAge("minor")} />
            <span><span className="t">Ho tra 14 e 17 anni</span><span className="s">Serve il consenso di un genitore o tutore</span></span>
          </label>
        </div>

        {age === "minor" && (
          <div className="banner banner-info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" strokeLinecap="round" /></svg>
            <span>Un genitore o tutore conferma il consenso al passo successivo.</span>
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="email">La tua email</label>
          <input id="email" className="input" type="email" inputMode="email" placeholder="nome@email.it"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="hint">Ti inviamo un link di accesso: niente password.</span>
        </div>

        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="box"><CheckIcon /></span>
          <span className="check-label">Acconsento a ricevere via email il link di accesso e ho letto l'<a href="#">informativa privacy</a>.</span>
        </label>

        {err && <div className="banner banner-danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" /></svg><span>{err}</span></div>}

        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!ready || busy} data-press>
          {busy ? "Invio…" : age === "minor" ? "Continua con il consenso del genitore" : "Inviami il link di accesso"}
        </button>
      </form>
    </Screen>
  );
}
