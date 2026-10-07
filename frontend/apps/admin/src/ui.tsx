import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { AdminEvent } from "./lib/events";

export function Mark() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
        <path d="M22 36 V28 a6 6 0 0 1 6-6 H36" /><path d="M64 22 H72 a6 6 0 0 1 6 6 V36" />
        <path d="M78 64 V72 a6 6 0 0 1-6 6 H64" /><path d="M36 78 H28 a6 6 0 0 1-6-6 V64" />
      </g>
      <circle cx="50" cy="50" r="7.5" fill="var(--c-accent)" />
    </svg>
  );
}

const I = {
  dash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  cal: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" strokeLinecap="round" /></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8" cy="8" r="5" /><path d="M11.5 11.5L21 21M17 17l2-2M15 19l2-2" strokeLinecap="round" /></svg>,
  manage: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></svg>,
  foto: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M4 17l4.5-4c.8-.7 1.9-.7 2.7 0L20 20" /></svg>,
  gallerie: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M9 10h.01M15 10h.01" /><path d="M9.5 14a3.4 3.4 0 0 0 5 0" /></svg>,
  layout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><path d="M9 20V9" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
};

type NavEntry = { to: string; label: string; icon: ReactNode; end?: boolean };
const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  { label: "Panoramica", items: [{ to: "/admin", label: "Dashboard", icon: I.dash, end: true }] },
  { label: "Evento", items: [
    { to: "/admin/eventi", label: "Eventi", icon: I.cal },
    { to: "/admin/gestione", label: "Gestione evento", icon: I.manage },
  ] },
  { label: "Media", items: [
    { to: "/admin/foto", label: "Foto", icon: I.foto },
    { to: "/admin/gallerie", label: "Gallerie & Match", icon: I.gallerie },
  ] },
  { label: "Contenuti sito", items: [{ to: "/admin/contenuti", label: "Contenuti", icon: I.layout }] },
  { label: "Conformità", items: [{ to: "/admin/gdpr", label: "GDPR & Consensi", icon: I.shield }] },
  { label: "Sistema", items: [{ to: "/admin/link", label: "Link di accesso", icon: I.key }] },
];

export function Shell({ title, sub, action, children }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const who = (() => { try { return sessionStorage.getItem("rephoto.email") || "staff"; } catch { return "staff"; } })();
  return (
    <div className="ad-wrap">
      <aside className="sidebar">
        <a className="ad-brand" href="/admin"><Mark /> RePhoto</a>
        <nav style={{ display: "flex", flexDirection: "column" }} aria-label="Sezioni">
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
                  style={({ isActive }) => isActive ? { background: "var(--c-surface)", color: "var(--c-ink)", boxShadow: "var(--shadow-xs)" } : undefined}>
                  {n.icon}{n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="ad-chip">{who}<br /><span className="badge badge-neutral" style={{ marginTop: 4 }}>Super-admin</span></div>
      </aside>
      <main className="ad-main">
        <div className="ad-top" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div><h1>{title}</h1>{sub && <p className="sub" style={{ marginTop: 4 }}>{sub}</p>}</div>
          {action}
        </div>
        {children}
      </main>
    </div>
  );
}

/* Compact event selector for the Shell action slot — the event-scoped browse
   endpoints need an eventId, so these pages pick the event here. */
export function EventPicker({ events, value, onChange }: { events: AdminEvent[] | null; value: string; onChange: (id: string) => void }) {
  if (!events) return <div className="skeleton" style={{ width: 200, height: 38, borderRadius: "var(--r-md)" }} />;
  if (events.length === 0) return <span className="badge badge-neutral">Nessun evento</span>;
  return (
    <label className="field" style={{ gap: 4 }}>
      <span className="label" style={{ fontSize: "var(--fs-2xs)", color: "var(--c-ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Evento</span>
      <select className="select" style={{ width: "auto", minWidth: 200, padding: "9px 14px", fontSize: "var(--fs-sm)" }}
        value={value} onChange={(e) => onChange(e.target.value)} aria-label="Evento selezionato">
        {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </label>
  );
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
