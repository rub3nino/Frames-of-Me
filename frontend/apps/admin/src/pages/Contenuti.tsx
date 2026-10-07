import { useState } from "react";
import { Shell } from "../ui";

/* Contenuti sito / CMS — GAP (ux-flows §9, 02-admin-spec §3.9).
   The CMS is entirely state-objective: no backend yet. The data model
   (site_pages, content_blocks, translations) and the CRUD routes
   (/v1/admin/cms/pages, .../blocks, .../translations, POST .../publish)
   do not exist. This screen builds the target UI with placeholder data so
   the shape is agreed before the endpoints are added. Nothing here writes. */

const TABS = ["Home / sezioni", "Agenda", "Ospiti / Speaker", "Alloggio & Prezzi", "FAQ", "Traduzioni RO/IT/EN"] as const;

const LangPills = ({ it = true, en = true, ro = false }: { it?: boolean; en?: boolean; ro?: boolean }) => (
  <span className="row" style={{ gap: 5 }}>
    {([["IT", it], ["EN", en], ["RO", ro]] as [string, boolean][]).map(([l, on]) => (
      <span key={l} className={"badge " + (on ? "badge-neutral" : "badge-warning")} style={{ padding: "2px 7px" }}>{l}</span>
    ))}
  </span>
);

const Soon = () => (
  <span className="badge badge-info">In arrivo</span>
);

export default function Contenuti() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);

  return (
    <Shell title="Contenuti sito" sub="Vetrina pubblica multilingue dell'evento: home, agenda, speaker, alloggio, FAQ, traduzioni.">
      {/* GAP banner — endpoints to add */}
      <div className="banner banner-info" style={{ marginBottom: "var(--s-5)" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" strokeLinecap="round" /></svg>
        <div><strong>Funzione in arrivo: endpoint da aggiungere.</strong> Il CMS multilingue non ha ancora backend (tabelle <span className="mono">site_pages / content_blocks / translations</span> e rotte <span className="mono">/v1/admin/cms/*</span>, con <span className="mono">POST /v1/admin/cms/pages/:id/publish</span>). I contenuti mostrati sono di esempio.</div>
      </div>

      <div className="segmented" style={{ marginBottom: "var(--s-5)", flexWrap: "wrap" }} role="tablist" aria-label="Sezioni CMS">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {tab === "Home / sezioni" && (
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Blocco</th><th>Tipo</th><th>Lingue</th><th>Stato</th></tr></thead>
            <tbody>
              {[["Hero", "hero"], ["Countdown", "countdown"], ["CTA iscrizione", "cta"], ["Highlights", "grid"], ["Edizioni precedenti", "archive"]].map(([n, t]) => (
                <tr key={n}><td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{n}</td><td className="mono">{t}</td><td><LangPills ro={false} /></td><td><span className="badge badge-warning">Bozza</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Agenda" && (
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Giornata</th><th>Ora</th><th>Titolo</th><th>Sala</th><th>Lingue</th></tr></thead>
            <tbody>
              {[["Gio 4 giu", "09:30", "Apertura", "Plenaria"], ["Gio 4 giu", "11:00", "Workshop famiglie", "Sala A"], ["Ven 5 giu", "14:00", "Panel giovani", "Sala B"]].map((r, i) => (
                <tr key={i}><td>{r[0]}</td><td className="mono">{r[1]}</td><td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{r[2]}</td><td>{r[3]}</td><td><LangPills /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Ospiti / Speaker" && (
        <div className="gallery-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {["Elena Marcu", "Giorgio Bianchi", "Ana Pop", "Luca Ferrari"].map((n) => (
            <div className="card" key={n}>
              <div className="avatar avatar-lg" style={{ marginBottom: "var(--s-3)" }} />
              <div style={{ fontWeight: 600 }}>{n}</div>
              <div className="muted" style={{ fontSize: "var(--fs-sm)", margin: "4px 0 var(--s-3)" }}>Relatore</div>
              <LangPills ro={n.length % 2 === 0} />
            </div>
          ))}
        </div>
      )}

      {tab === "Alloggio & Prezzi" && (
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Sistemazione</th><th>Capienza</th><th>Prezzo</th><th>Pasti</th><th>Lingue</th></tr></thead>
            <tbody>
              {[["Campus — camera doppia", "400", "€ 180", "Inclusi"], ["Hotel partner", "120", "€ 260", "Colazione"], ["Area tende", "600", "€ 60", "Non inclusi"]].map((r, i) => (
                <tr key={i}><td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{r[0]}</td><td className="mono">{r[1]}</td><td className="mono">{r[2]}</td><td>{r[3]}</td><td><LangPills /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "FAQ" && (
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Domanda</th><th>Lingue</th><th>Stato</th></tr></thead>
            <tbody>
              {["Come mi iscrivo?", "Posso portare la famiglia?", "Dove alloggio?", "Le foto sono pubbliche?"].map((q) => (
                <tr key={q}><td style={{ color: "var(--c-ink)", fontWeight: 500 }}>{q}</td><td><LangPills ro={false} /></td><td><span className="badge badge-success">Pubblicata</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Traduzioni RO/IT/EN" && (
        <div className="card card-flat" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>Chiave</th><th>IT</th><th>EN</th><th>RO</th></tr></thead>
            <tbody>
              {[["home.hero.title", "✓", "✓", "mancante"], ["home.cta.label", "✓", "✓", "✓"], ["agenda.title", "✓", "da rivedere", "mancante"], ["faq.title", "✓", "✓", "mancante"]].map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r[0]}</td>
                  {r.slice(1).map((v, j) => (
                    <td key={j}>{v === "✓" ? <span className="badge badge-success">OK</span> : v === "mancante" ? <span className="badge badge-warning">mancante</span> : <span className="badge badge-neutral">da rivedere</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s-3)", marginTop: "var(--s-5)" }}>
        <Soon /><span className="muted" style={{ fontSize: "var(--fs-sm)" }}>Anteprima e pubblicazione disponibili quando gli endpoint CMS saranno aggiunti.</span>
      </div>
    </Shell>
  );
}
