import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppBar } from "../ui";
import { api } from "../lib/api";

/* GDPR self-service for the participant.
   Only the logout action is wired: revoke / export / erasure are backend GAPs —
   today they pass through the admin (docs/ux-flows.md §9.4, docs/analysis §6.3).
   Each gap feature shows a small banner-info "Funzione in arrivo". */
export default function IMieiDati() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2600); }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try { await api.logout(); } catch { /* ignore: clear client state anyway */ }
    finally { nav("/"); }
  }

  return (
    <>
      <AppBar />
      <main className="screen screen--wide">
        <h1 style={{ marginBottom: "var(--s-6)" }}>I miei dati</h1>

        {/* --- Consent status -------------------------------------------- */}
        <section className="block">
          <h3>Consenso biometrico</h3>
          <div className="status-row">
            <span className="badge badge-success">Consenso attivo</span>
          </div>
          <p>Hai acconsentito all'uso del tuo volto per trovare le foto in cui compari. Puoi revocarlo quando vuoi: smetteremo di cercarti nelle nuove foto.</p>
          <div className="actions">
            {/* GAP: nessun endpoint di revoca self-service in CONTRACTS (oggi via admin). */}
            <button className="btn btn-secondary" type="button" onClick={() => flash("Richiesta registrata")} data-press>Revoca il consenso</button>
            <div className="banner banner-info">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" /></svg>
              <span>Funzione in arrivo: endpoint da aggiungere.</span>
            </div>
          </div>
        </section>

        {/* --- Data export ----------------------------------------------- */}
        <section className="block">
          <h3>Scarica i miei dati</h3>
          <p>Ricevi via email una copia dei dati che ti riguardano: email, consensi registrati e l'elenco delle foto collegate al tuo account.</p>
          <div className="actions">
            {/* GAP: nessun endpoint di portabilità/esportazione self-service in CONTRACTS. */}
            <button className="btn btn-secondary" type="button" onClick={() => flash("Richiesta registrata")} data-press>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></svg>
              Scarica i miei dati
            </button>
            <div className="banner banner-info">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" /></svg>
              <span>Funzione in arrivo: endpoint da aggiungere.</span>
            </div>
          </div>
        </section>

        {/* --- Erasure (danger zone) ------------------------------------- */}
        <section className="block">
          <h3>Cancellazione</h3>
          <p>Puoi chiedere la cancellazione del tuo account e dei tuoi dati in qualsiasi momento.</p>
          <div className="danger-zone">
            <h3>Cancella i miei dati e le mie foto trovate</h3>
            <p>Elimina il tuo account, i consensi e la tua galleria personale. Le foto di gruppo scattate da altri restano di proprietà del fotografo e non vengono eliminate.</p>
            <div className="actions">
              {/* GAP: la cancellazione self-service non esiste; oggi passa dall'admin (DELETE /v1/admin/participants/:id). */}
              <button className="btn btn-danger" type="button" onClick={() => setDel(true)} data-press>Cancella i miei dati</button>
              <div className="banner banner-info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" /></svg>
                <span>Funzione in arrivo: endpoint da aggiungere.</span>
              </div>
            </div>
          </div>
        </section>

        {/* --- Logout (wired) -------------------------------------------- */}
        <section className="block">
          <h3>Esci</h3>
          <p>Chiudi la sessione su questo dispositivo. Potrai rientrare con un nuovo link via email.</p>
          <div className="actions">
            <button className="btn btn-secondary" type="button" onClick={logout} disabled={busy} data-press>{busy ? "Esco…" : "Esci"}</button>
          </div>
        </section>
      </main>

      {/* Confirm deletion modal (gap-flagged action) */}
      <div className="scrim" data-state={del ? "open" : "closed"} onClick={() => setDel(false)} />
      <div className="modal" data-state={del ? "open" : "closed"} role="dialog" aria-modal="true" aria-label="Cancellare i tuoi dati?">
        <h3 style={{ marginBottom: "var(--s-3)" }}>Cancellare i tuoi dati?</h3>
        <p style={{ color: "var(--c-ink-2)", fontSize: "var(--fs-sm)", lineHeight: 1.55 }}>
          Questa azione è definitiva. Elimineremo il tuo account, i consensi e la tua galleria personale. Le foto di gruppo scattate da altri non vengono eliminate.
        </p>
        <div className="banner banner-info" style={{ marginTop: "var(--s-4)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere.</span>
        </div>
        <div className="modal-row">
          <button className="btn btn-secondary" type="button" onClick={() => setDel(false)} data-press>Annulla</button>
          <button className="btn btn-danger" type="button" onClick={() => { setDel(false); flash("Richiesta registrata"); }} data-press>Cancella</button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
