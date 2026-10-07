import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Screen, CheckIcon } from "../ui";
import { api } from "../lib/api";

export default function ConsensoGenitore() {
  const nav = useNavigate();
  const email = sessionStorage.getItem("rephoto.email") || "";
  const [g, setG] = useState("");
  const [rel, setRel] = useState("");
  const [minor, setMinor] = useState("");
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const [busy, setBusy] = useState(false);

  const ready = g.trim() && rel && minor.trim() && c1 && c2;

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    // NOTE: a dedicated endpoint for guardian/minor consent is a backend gap
    // (e.g. POST /v1/consents/guardian). For now we proceed with the magic link;
    // the biometric consent row is recorded at the selfie step.
    try { await api.requestLink(email, "participant"); } catch (err) { console.warn(err); }
    setBusy(false);
    nav("/attesa");
  }

  return (
    <Screen>
      <form className="stack" onSubmit={confirm}>
        <div>
          <h1>Consenso del genitore</h1>
          <p className="dek">Conferenza 2026 · per un partecipante di 14–17 anni</p>
        </div>
        <p style={{ color: "var(--c-ink-2)", lineHeight: 1.55 }}>
          Stai dando il consenso, come <b>genitore o tutore</b>, perché il selfie del minore venga
          usato per riconoscerlo tra le foto dell'evento e mostrargli soltanto le sue. È un
          <b> dato biometrico</b> (art. 9 GDPR); per un minore di 18 anni serve il consenso di chi ne
          ha la responsabilità (art. 8 GDPR).
        </p>

        <div className="field">
          <label className="label">Il tuo nome e cognome</label>
          <input className="input" value={g} onChange={(e) => setG(e.target.value)} placeholder="Nome e cognome del genitore o tutore" />
        </div>
        <div className="field">
          <label className="label">Rapporto con il minore</label>
          <select className="select" value={rel} onChange={(e) => setRel(e.target.value)}>
            <option value="">Seleziona…</option>
            <option>Madre</option><option>Padre</option><option>Tutore legale</option><option>Altro</option>
          </select>
        </div>
        <div className="field">
          <label className="label">Nome e cognome del minore</label>
          <input className="input" value={minor} onChange={(e) => setMinor(e.target.value)} placeholder="Nome e cognome del minore" />
        </div>

        <label className="check">
          <input type="checkbox" checked={c1} onChange={(e) => setC1(e.target.checked)} />
          <span className="box"><CheckIcon /></span>
          <span className="check-label">Confermo di essere il genitore o tutore del minore indicato.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={c2} onChange={(e) => setC2(e.target.checked)} />
          <span className="box"><CheckIcon /></span>
          <span className="check-label">Acconsento all'uso del selfie del minore per riconoscerlo nelle foto dell'evento. Il selfie viene cancellato dopo la ricerca.</span>
        </label>

        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!ready || busy} data-press>
          {busy ? "Invio…" : "Confermo e continuo"}
        </button>
      </form>
    </Screen>
  );
}
