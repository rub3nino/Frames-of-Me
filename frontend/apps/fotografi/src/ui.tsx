import { NavLink } from "react-router-dom";

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

const NAV = [
  { to: "/upload", label: "Caricamento" },
  { to: "/album", label: "Album" },
  { to: "/copertura", label: "Copertura" },
  { to: "/statistiche", label: "Statistiche" },
  { to: "/qualita", label: "Qualità" },
];

export function AppBar() {
  const user = (() => { try { return sessionStorage.getItem("rephoto.email") || "fotografo"; } catch { return "fotografo"; } })();
  return (
    <header className="appbar">
      <a className="brand" href="/upload"><Mark /> RePhoto</a>
      <nav className="fz-nav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => "fz-navitem" + (isActive ? " on" : "")}>{n.label}</NavLink>
        ))}
      </nav>
      <div className="grow" />
      <span className="fz-chip">{user}</span>
    </header>
  );
}

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
);
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
