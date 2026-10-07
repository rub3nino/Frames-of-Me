import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shell, EventPicker, isEmail } from "../ui";
import { useAdminEvents } from "../lib/events";
import { api } from "../lib/api";

/* Gestione evento — the event-scoped operations panel. All wired to real routes:
     PATCH  /v1/admin/events/:id            (access open|list, retentionDays)
     POST   /v1/admin/photographers/invite  (invite a photographer)
     POST   /v1/admin/participants/import    (import allowlist)
     DELETE /v1/admin/participants/:id       (remove a participant, confirm)
     DELETE /v1/admin/photos/:id             (remove a photo, confirm)
     POST   /v1/admin/events/:id/reset       (reset, type-the-slug confirm)
   GAP: there is no read endpoint for participants/photographers lists yet
   (ux-flows §9.2), so removals here take an id — find it in Gallerie/Foto. */

const IMPORT_MAX = 5000;

export default function Gestione() {
  const nav = useNavigate();
  const { events, eventId, setEventId, current } = useAdminEvents();
  const [toast, setToast] = useState("");

  // access + retention (PATCH)
  const [access, setAccess] = useState<"open" | "list">("open");
  const [retention, setRetention] = useState("90");
  const [patchBusy, setPatchBusy] = useState(false);

  useEffect(() => {
    if (current) { setAccess(current.access); setRetention(String(current.retentionDays)); }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(""), 2500); };
  const guard = (e: any) => { if (e?.status === 401 || e?.status === 403) nav("/"); };

  async function patchEvent(body: Record<string, unknown>, msg: string) {
    if (!eventId || patchBusy) return;
    setPatchBusy(true);
    try { await api.raw(`/admin/events/${eventId}`, { method: "PATCH", json: body }); flash(msg); }
    catch (e: any) { guard(e); flash("Aggiornamento non riuscito."); }
    finally { setPatchBusy(false); }
  }

  // invite photographer (POST)
  const [fgEmail, setFgEmail] = useState("");
  const [fgBusy, setFgBusy] = useState(false);
  const [fgErr, setFgErr] = useState("");
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(fgEmail) || !eventId || fgBusy) return;
    setFgBusy(true); setFgErr("");
    try { await api.raw(`/admin/photographers/invite`, { method: "POST", json: { email: fgEmail.trim().toLowerCase(), eventId } }); setFgEmail(""); flash("Invito inviato."); }
    catch (e: any) { guard(e); setFgErr("Invito non riuscito."); }
    finally { setFgBusy(false); }
  }

  // import participants (POST)
  const [emails, setEmails] = useState("");
  const [impBusy, setImpBusy] = useState(false);
  const lines = emails.split("\n").map((s) => s.trim()).filter(Boolean);
  const over = lines.length > IMPORT_MAX;
  async function doImport(e: React.FormEvent) {
    e.preventDefault();
    if (!lines.length || over || !eventId || impBusy) return;
    setImpBusy(true);
    try {
      const d: any = await api.raw(`/admin/participants/import`, { method: "POST", json: { eventId, emails: lines } });
      setEmails(""); flash(`${d.inserted ?? lines.length} partecipanti importati.`);
    } catch (e: any) { guard(e); flash("Import non riuscito."); }
    finally { setImpBusy(false); }
  }

  // delete participant / photo by id (DELETE, confirm)
  const [partId, setPartId] = useState("");
  const [photoId, setPhotoId] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "participant" | "photo"; id: string }>(null);
  const [delBusy, setDelBusy] = useState(false);
  async function doDelete() {
    if (!confirm || delBusy) return;
    setDelBusy(true);
    const path = confirm.kind === "participant" ? `/v1/admin/participants/${confirm.id}` : `/v1/admin/photos/${confirm.id}`;
    try {
      await api.raw(path, { method: "DELETE" });
      if (confirm.kind === "participant") setPartId(""); else setPhotoId("");
      flash(confirm.kind === "participant" ? "Partecipante rimosso." : "Foto eliminata.");
      setConfirm(null);
    } catch (e: any) {
      guard(e);
      flash(e?.status === 404 ? "ID non trovato." : "Operazione non riuscita.");
      setConfirm(null);
    } finally { setDelBusy(false); }
  }

  // reset (POST, type-the-slug)
  const [resetOpen, setResetOpen] = useState(false);
  const [resetSlug, setResetSlug] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  async function doReset() {
    if (!current || resetSlug !== current.slug || resetBusy) return;
    setResetBusy(true);
    try {
      await api.raw(`/admin/events/${eventId}/reset`, { method: "POST", json: { confirm: current.slug } });
      setResetOpen(false); setResetSlug(""); flash("Reset avviato.");
    } catch (e: any) { guard(e); flash("Reset non riuscito."); }
    finally { setResetBusy(false); }
  }

  const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

  return (
    <Shell title="Gestione evento" sub="Accesso, fotografi, partecipanti e manutenzione dell'evento selezionato."
      action={<EventPicker events={events} value={eventId} onChange={setEventId} />}>

      {toast && <div className="banner banner-success" style={{ marginBottom: "var(--s-5)" }}><span>{toast}</span></div>}

      {/* Access + retention */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <h3 style={{ marginBottom: "var(--s-2)" }}>Accesso e retention</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-5)" }}>In «Lista» solo le email importate possono fare il selfie. Ridurre la retention anticipa la cancellazione delle foto oltre la nuova soglia.</p>
        <div className="row" style={{ gap: "var(--s-6)", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field">
            <label className="label">Accesso</label>
            <div className="segmented">
              <button aria-selected={access === "open"} onClick={() => { setAccess("open"); patchEvent({ access: "open" }, "Accesso: aperto."); }} disabled={patchBusy}>Aperto</button>
              <button aria-selected={access === "list"} onClick={() => { setAccess("list"); patchEvent({ access: "list" }, "Accesso: riservato (lista)."); }} disabled={patchBusy}>Riservato (lista)</button>
            </div>
          </div>
          <form className="row" style={{ gap: "var(--s-2)", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); patchEvent({ retentionDays: Number(retention) || 1 }, "Retention aggiornata."); }}>
            <div className="field"><label className="label">Giorni retention</label><input className="input" type="number" min={1} style={{ width: 120 }} value={retention} onChange={(e) => setRetention(e.target.value)} /></div>
            <button className="btn btn-secondary" type="submit" disabled={patchBusy} data-press>Salva</button>
          </form>
        </div>
      </div>

      {/* Invite photographer */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <h3 style={{ marginBottom: "var(--s-2)" }}>Invita fotografo</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-5)" }}>Riceve un link <span className="mono">/invito</span> per questo evento. L'invito scade dopo 7 giorni.</p>
        <form className="row" style={{ gap: "var(--s-3)", alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={invite}>
          <div className="field" style={{ flex: 1, minWidth: 260 }}><label className="label">Email</label><input className="input" type="email" value={fgEmail} onChange={(e) => setFgEmail(e.target.value)} placeholder="nome@studio.it" /></div>
          <button className="btn btn-primary" type="submit" disabled={!isEmail(fgEmail) || fgBusy} data-press>{fgBusy ? "Invio…" : "Invia invito"}</button>
        </form>
        {fgErr && <div className="banner banner-danger" style={{ marginTop: "var(--s-4)" }}><span>{fgErr}</span></div>}
        {/* GAP ux-flows §9.2: no GET elenco fotografi / stato inviti — only the invite above. */}
        <div className="banner banner-info" style={{ marginTop: "var(--s-4)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" strokeLinecap="round" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere — l'elenco fotografi e lo stato inviti non hanno ancora una read (<span className="mono">GET /v1/admin/photographers</span>).</span>
        </div>
      </div>

      {/* Import participants */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <h3 style={{ marginBottom: "var(--s-2)" }}>Importa partecipanti</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-4)" }}>Un indirizzo per riga. Massimo <span className="mono">{IMPORT_MAX.toLocaleString("it-IT")}</span> per import. Gli indirizzi già presenti vengono ignorati.</p>
        <form onSubmit={doImport}>
          <textarea className="textarea" rows={6} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder={"laura.bianchi@gmail.com\nm.rossi@outlook.it"} />
          <div className="row" style={{ justifyContent: "space-between", marginTop: "var(--s-3)" }}>
            <span className="mono" style={{ fontSize: "var(--fs-sm)", color: over ? "var(--c-danger-ink)" : "var(--c-ink-2)", fontWeight: over ? 600 : 400 }}>{lines.length.toLocaleString("it-IT")} / {IMPORT_MAX.toLocaleString("it-IT")}</span>
            <button className="btn btn-primary" type="submit" disabled={!lines.length || over || impBusy} data-press>{impBusy ? "Importo…" : "Importa"}</button>
          </div>
        </form>
      </div>

      {/* Remove by id */}
      <div className="card" style={{ marginBottom: "var(--s-5)" }}>
        <h3 style={{ marginBottom: "var(--s-2)" }}>Rimuovi per ID</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-5)" }}>Trovi l'ID partecipante in Gallerie (userId) e l'ID foto in Foto (dettaglio).</p>
        <div className="row" style={{ gap: "var(--s-6)", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 280 }}>
            <label className="label">Partecipante (userId)</label>
            <div className="row" style={{ gap: "var(--s-2)" }}>
              <input className="input mono" style={{ fontSize: "var(--fs-xs)" }} value={partId} onChange={(e) => setPartId(e.target.value)} placeholder="uuid" />
              <button className="btn btn-danger btn-sm" disabled={!uuid(partId)} onClick={() => setConfirm({ kind: "participant", id: partId.trim() })} data-press>Rimuovi</button>
            </div>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 280 }}>
            <label className="label">Foto (photoId)</label>
            <div className="row" style={{ gap: "var(--s-2)" }}>
              <input className="input mono" style={{ fontSize: "var(--fs-xs)" }} value={photoId} onChange={(e) => setPhotoId(e.target.value)} placeholder="uuid" />
              <button className="btn btn-danger btn-sm" disabled={!uuid(photoId)} onClick={() => setConfirm({ kind: "photo", id: photoId.trim() })} data-press>Elimina</button>
            </div>
          </div>
        </div>
      </div>

      {/* Reset */}
      <div className="card" style={{ borderColor: "var(--c-danger-soft)" }}>
        <h3 style={{ marginBottom: "var(--s-2)", color: "var(--c-danger-ink)" }}>Reset evento</h3>
        <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: "var(--s-5)" }}>Svuota l'evento: foto, derivati, volti, gallerie e consensi. Operazione pesante e <strong>irreversibile</strong>, eseguita in background.</p>
        <button className="btn btn-danger" onClick={() => setResetOpen(true)} disabled={!current} data-press>Reset evento…</button>
      </div>

      {/* Delete by-id confirm */}
      <div className="scrim" data-state={confirm ? "open" : "closed"} onClick={() => !delBusy && setConfirm(null)} />
      <div className="modal" data-state={confirm ? "open" : "closed"} role="alertdialog" aria-label="Conferma rimozione">
        <h3 style={{ marginBottom: "var(--s-3)" }}>{confirm?.kind === "participant" ? "Rimuovere il partecipante?" : "Eliminare la foto?"}</h3>
        <p style={{ color: "var(--c-ink-2)", fontSize: "var(--fs-sm)" }}>
          {confirm?.kind === "participant"
            ? <>Vengono cancellati l'utente, le sue gallerie, i consensi e le sessioni. <strong>Le foto di gruppo scattate da altri non vengono eliminate.</strong></>
            : <>L'operazione è <strong>irreversibile</strong>: la foto viene rimossa dall'archivio e dalla collezione di riconoscimento.</>}
        </p>
        <p className="mono" style={{ fontSize: "var(--fs-xs)", color: "var(--c-ink-3)", marginTop: "var(--s-3)" }}>{confirm?.id}</p>
        <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
          <button className="btn btn-secondary" onClick={() => setConfirm(null)} disabled={delBusy}>Annulla</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={delBusy} data-press>{delBusy ? "Elaboro…" : "Conferma"}</button>
        </div>
      </div>

      {/* Reset confirm — type the slug */}
      <div className="scrim" data-state={resetOpen ? "open" : "closed"} onClick={() => !resetBusy && setResetOpen(false)} />
      <div className="modal" data-state={resetOpen ? "open" : "closed"} role="alertdialog" aria-label="Reset evento">
        <h3 style={{ marginBottom: "var(--s-3)" }}>Reset «{current?.name}»?</h3>
        <p style={{ color: "var(--c-ink-2)", fontSize: "var(--fs-sm)" }}>Tutte le foto, le gallerie e i dati associati vengono eliminati in modo <strong>irreversibile</strong>. Per confermare digita lo slug dell'evento.</p>
        <div className="field" style={{ marginTop: "var(--s-4)" }}>
          <label className="label">Digita <span className="mono">{current?.slug}</span></label>
          <input className="input mono" value={resetSlug} onChange={(e) => setResetSlug(e.target.value)} placeholder={current?.slug} autoFocus />
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
          <button className="btn btn-secondary" onClick={() => { setResetOpen(false); setResetSlug(""); }} disabled={resetBusy}>Annulla</button>
          <button className="btn btn-danger" onClick={doReset} disabled={resetSlug !== current?.slug || resetBusy} data-press>{resetBusy ? "Avvio…" : "Reset evento"}</button>
        </div>
      </div>
    </Shell>
  );
}
