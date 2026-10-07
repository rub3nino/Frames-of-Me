import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { EVENT_SLUG } from "./lib/api";

export function Mark() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
        <path d="M22 36 V28 a6 6 0 0 1 6-6 H36" />
        <path d="M64 22 H72 a6 6 0 0 1 6 6 V36" />
        <path d="M78 64 V72 a6 6 0 0 1-6 6 H64" />
        <path d="M36 78 H28 a6 6 0 0 1-6-6 V64" />
      </g>
      <circle cx="50" cy="50" r="7.5" fill="var(--c-accent)" />
    </svg>
  );
}

export function AppBar() {
  return (
    <header className="appbar-c">
      <span className="brand"><Mark /> Frames of Me</span>
    </header>
  );
}

export function Screen({ children, center, tabbar }: { children: ReactNode; center?: boolean; tabbar?: boolean }) {
  return (
    <>
      <AppBar />
      <main className={"screen" + (center ? " screen-center" : "") + (tabbar ? " screen--tabbar" : "")}>{children}</main>
      {tabbar && <TabBar />}
    </>
  );
}

/* Bottom tabbar for the authenticated pages (Galleria, Cerca, I miei dati).
   aria-current is derived from the active route. */
export function TabBar() {
  const { pathname } = useLocation();
  const current =
    pathname.startsWith("/e/") ? "galleria" :
    pathname.startsWith("/i-miei-dati") ? "dati" :
    pathname.startsWith("/selfie") ? "cerca" : "";
  const cur = (id: string) => (current === id ? "page" : undefined);
  return (
    <nav className="tabbar" aria-label="Navigazione">
      <Link to={`/e/${EVENT_SLUG}`} aria-current={cur("galleria")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.6" /><rect x="14" y="3" width="7" height="7" rx="1.6" /><rect x="3" y="14" width="7" height="7" rx="1.6" /><rect x="14" y="14" width="7" height="7" rx="1.6" /></svg>
        Galleria
      </Link>
      <Link to="/selfie" aria-current={cur("cerca")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
        Cerca
      </Link>
      <Link to="/i-miei-dati" aria-current={cur("dati")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
        I miei dati
      </Link>
    </nav>
  );
}

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
);

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
export const maskEmail = (e: string) => {
  const [u, d] = e.split("@");
  if (!d) return e;
  return (u.length <= 2 ? u[0] + "•" : u.slice(0, 2) + "•••") + "@" + d;
};
