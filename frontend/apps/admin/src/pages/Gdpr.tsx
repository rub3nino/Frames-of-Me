import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell, EventPicker } from "../ui";
import { useAdminEvents } from "../lib/events";
import { api } from "../lib/api";

/* GDPR & Consensi.
   Mostly GAP (02-admin-spec §3.10): consensi, minori/consenso parentale e coda
   richieste (accesso/erasure) non hanno backend — servono le tabelle
   parental_consents / data_requests e le rotte GET /v1/admin/consents,
   GET/PATCH /v1/admin/dsr, GET/POST /v1/admin/minors. Dati di esempio.
   WIRED: l'esecuzione retention usa la rotta reale
   POST /v1/admin/retention/run { eventId } → 202 { jobId }. */

const DSR = [
  { email: "anna.kovac@example.ro", kind: "Accesso", kindCls: "badge-neutral", state: "In lavorazione", stateCls: "badge-info", when: "oggi, 08:14" },
  { email: "marius.p@example.ro", kind: "Cancellazione", kindCls: "badge-danger", state: "Ricevuta", stateCls: "badge-warning", when: "oggi, 07:50" },
  { email: "g.esposito@example.it", kind: "Accesso", kindCls: "badge-neutral", state: "Completata", stateCls: "badge-success", when: "ieri, 16:30" },
];
const MINORS = [
  { email: "dragos.ilie@example.ro", age: "2009 · 15 anni", par: ["Verificato", "badge-success"], selfie: ["Sbloccato", "badge-success"], by: "l.riva · 2 mar" },
  { email: "ioana.marin@example.ro", age: "2010 · 14 anni", par: ["In attesa", "badge-warning"], selfie: ["Bloccato", "badge-danger"], by: "—" },
  { email: "matteo.costa@example.it", age: "2009 · 15 anni", par: ["Richiesto", "badge-neutral"], selfie: ["Bloccato", "badge-danger"], by: "—" },
  { email: "sara.vlad@example.ro", age: "2008 · 16 anni", par: ["Negato", "badge-danger"], selfie: ["Bloccato", "badge-danger"], by: "g.ferraro · 1 mar" },
];

export default function Gdpr() {
  const nav = useNavigate();
  const { events, eventId, setEventId } = useAdminEvents();
  const [retOpen, setRetOpen] = useState(false);
  const [retBusy, setRetBusy] = useState(false);
  const [toast, setToast] = useState("");
  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(""), 2800); };

  async function runRetention() {
    if (!eventId || retBusy) return;
    setRetBusy(true);
    try {
      await api.raw(`/admin/retention/run`, { method: "POST", json: { eventId } });
      setRetOpen(false); flash("Pulizia retention avviata.");
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) return nav("/");
      setRetOpen(false); flash("Avvio retention non riuscito.");
    } finally { setRetBusy(false); }
  }

  return (
    <Shell title="GDPR & Consensi" sub="Consensi, minori e diritti degli interessati (Art. 15/17) per l'evento selezionato."
      action={<EventPicker events={events} value={eventId} onChange={setEventId} />}>

      {toast && <div className="banner banner-success" style={{ marginBottom: "var(--s-5)" }}><span>{toast}</span></div>}

      {/* GAP banner */}
      <div className="banner banner-info" style={{ marginBottom: "var(--s-5)" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" strokeLinecap="round" /></svg>
        <div><strong>Funzione in arrivo: endpoint da aggiungere.</strong> Consensi, minori/consenso parentale e coda richieste non hanno ancora backend (<span className="mono">GET /v1/admin/consents</span>, <span className="mono">GET/PATCH /v1/admin/dsr</span>, <span className="mono">GET/POST /v1/admin/minors</span>, tabelle <span className="mono">parental_consents / data_requests</span>). I dati sotto sono di esempio. L'esecuzione retention qui sotto è invece reale.</div>
      </div>

      <div className="statgrid" style={{ marginBottom: "var(--s-5)" }}>
        {[["Consensi attivi", "5.618"], ["Consensi revocati", "47"], ["Minori con consenso", "214"], ["In attesa parentale", "38"]].map(([c, n]) => (
          <div className="stat" key={c}><div className="num mono">{n}</div><div className="cap">{c}</div></div>
        ))}
      </div>

      {/* DSR queue (GAP) */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
          <h3 style={{ margin: 0 }}>Richieste degli interessati</h3><span className="badge badge-warning">esempio</span>
        </div>
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Richiedente</th><th>Tipo</th><th>Stato</th><th>Ricevuta</th></tr></thead>
            <tbody>
              {DSR.map((r) => (
                <tr key={r.email}><td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{r.email}</td><td><span className={"badge " + r.kindCls}>{r.kind}</span></td><td><span className={"badge " + r.stateCls}>{r.state}</span></td><td className="muted" style={{ fontSize: "var(--fs-xs)" }}>{r.when}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Minors (GAP) */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
          <div><h3 style={{ margin: 0 }}>Minori & consenso parentale</h3><p className="muted" style={{ fontSize: "var(--fs-sm)", marginTop: 4 }}>Il selfie resta bloccato finché il consenso del genitore non è verificato (dato biometrico, Art. 9).</p></div>
          <span className="badge badge-warning">esempio</span>
        </div>
        <div className="banner banner-success" style={{ marginBottom: "var(--s-4)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" strokeLinecap="round" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div><strong>0</strong> minori senza consenso hanno superato il blocco del selfie.</div>
        </div>
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Partecipante</th><th>Età</th><th>Consenso parentale</th><th>Selfie</th><th>Verificato da</th></tr></thead>
            <tbody>
              {MINORS.map((m) => (
                <tr key={m.email}>
                  <td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{m.email}</td>
                  <td className="mono" style={{ fontSize: "var(--fs-xs)" }}>{m.age}</td>
                  <td><span className={"badge " + m.par[1]}>{m.par[0]}</span></td>
                  <td><span className={"badge " + m.selfie[1]}>{m.selfie[0]}</span></td>
                  <td className="muted" style={{ fontSize: "var(--fs-xs)" }}>{m.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Retention — WIRED */}
      <div className="card">
        <h3 style={{ marginBottom: "var(--s-2)" }}>Esecuzioni retention</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-5)" }}>Avvia subito la pulizia delle foto oltre la soglia di retention dell'evento selezionato. Operazione <strong>irreversibile</strong>, eseguita in background. <span className="mono">POST /v1/admin/retention/run</span></p>
        <button className="btn btn-danger" onClick={() => setRetOpen(true)} disabled={!eventId} data-press>Esegui pulizia ora…</button>
        <div className="row" style={{ gap: "var(--s-5)", marginTop: "var(--s-5)", paddingTop: "var(--s-5)", borderTop: "1px solid var(--c-line)", flexWrap: "wrap" }}>
          <a className="link-more" href="/docs/DPIA.md" target="_blank" rel="noreferrer"><span>DPIA (documento)</span></a>
          <span className="muted" style={{ fontSize: "var(--fs-xs)", marginLeft: "auto" }}>Informativa in vigore: <span className="mono">consent-v3</span></span>
        </div>
      </div>

      {/* Retention confirm */}
      <div className="scrim" data-state={retOpen ? "open" : "closed"} onClick={() => !retBusy && setRetOpen(false)} />
      <div className="modal" data-state={retOpen ? "open" : "closed"} role="alertdialog" aria-label="Eseguire la retention">
        <h3 style={{ marginBottom: "var(--s-3)" }}>Eseguire la pulizia retention?</h3>
        <p style={{ color: "var(--c-ink-2)", fontSize: "var(--fs-sm)" }}>Le foto oltre la soglia di retention vengono eliminate in modo <strong>irreversibile</strong> (archivio + collezione di riconoscimento). Il job viene accodato e registrato in <span className="mono">audit_log</span>.</p>
        <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
          <button className="btn btn-secondary" onClick={() => setRetOpen(false)} disabled={retBusy}>Annulla</button>
          <button className="btn btn-danger" onClick={runRetention} disabled={retBusy} data-press>{retBusy ? "Avvio…" : "Esegui pulizia"}</button>
        </div>
      </div>
    </Shell>
  );
}
