import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppBar } from "../ui";
import { useActiveEvent } from "../lib/event";

/*
 * GAP page. Coverage / agenda does not exist in the contract yet:
 *   tables: coverage_slots(id,event_id,day,stage,zone,starts_at,ends_at,title)
 *           coverage_assignments(slot_id,photographer_id,status assigned|covered|skipped)
 *   endpoint: GET /v1/photographer/coverage?eventId= (G11, spec 03 §3.6 / §5.2).
 * The slots below are realistic placeholder data.
 */

type Status = "covered" | "todo" | "live" | "assigned" | "gap";
type Slot = { id: string; day: 1 | 2 | 3; when: string; title: string; place: string; status: Status };

const SEED: Slot[] = [
  { id: "s11", day: 1, when: "09:00–10:30", title: "Apertura & Keynote", place: "Palco Centrale", status: "covered" },
  { id: "s12", day: 1, when: "10:30–11:00", title: "Coffee & Networking", place: "Area Networking", status: "covered" },
  { id: "s13", day: 1, when: "11:00–13:00", title: "Panel · Il futuro del lavoro", place: "Palco Nord", status: "covered" },
  { id: "s14", day: 1, when: "14:00–16:00", title: "Workshop A · Prodotto", place: "Sala Workshop", status: "todo" },
  { id: "s15", day: 1, when: "16:30–18:00", title: "Sessione pomeridiana", place: "Palco Centrale", status: "live" },
  { id: "s21", day: 2, when: "09:00–11:00", title: "Keynote · Giorno 2", place: "Palco Centrale", status: "covered" },
  { id: "s22", day: 2, when: "11:00–13:00", title: "Sessioni parallele", place: "Sala Workshop", status: "covered" },
  { id: "s23", day: 2, when: "15:00–17:00", title: "Tavola rotonda", place: "Palco Nord", status: "todo" },
  { id: "s24", day: 2, when: "20:00–23:00", title: "Cena di Gala", place: "Sala Gala · in embargo", status: "assigned" },
  { id: "s25", day: 2, when: "17:30–19:00", title: "Demo area · nessun fotografo", place: "Area Espositori · scoperto per tutti", status: "gap" },
  { id: "s31", day: 3, when: "09:30–11:30", title: "Sessioni finali", place: "Palco Nord", status: "covered" },
  { id: "s32", day: 3, when: "12:00–13:00", title: "Pranzo", place: "Area Networking", status: "assigned" },
  { id: "s33", day: 3, when: "17:00–18:30", title: "Premiazione & Chiusura", place: "Palco Centrale · in embargo", status: "assigned" },
];

const DAYS = [
  { day: 1 as const, label: "Giorno 1", date: "12 marzo 2026 · Milano" },
  { day: 2 as const, label: "Giorno 2", date: "13 marzo 2026 · Milano" },
  { day: 3 as const, label: "Giorno 3", date: "14 marzo 2026 · Milano" },
];

const StatusBadge = ({ s }: { s: Status }) => {
  if (s === "covered") return <span className="badge badge-success">Coperto</span>;
  if (s === "todo") return <span className="badge badge-warning">Da coprire</span>;
  if (s === "live") return <span className="badge badge-info cv-live">In corso</span>;
  if (s === "gap") return <span className="badge badge-danger">Scoperto</span>;
  return <span className="badge badge-neutral">Assegnato</span>;
};

export default function Copertura() {
  const { event } = useActiveEvent();
  const [slots, setSlots] = useState<Slot[]>(SEED);
  const [day, setDay] = useState<"all" | 1 | 2 | 3>("all");

  const counts = useMemo(() => {
    const mine = slots.filter((s) => s.status !== "gap");
    return {
      assigned: mine.length,
      covered: mine.filter((s) => s.status === "covered").length,
      live: mine.filter((s) => s.status === "live").length,
      todo: mine.filter((s) => s.status === "todo").length,
    };
  }, [slots]);

  // Instant toggle covered <-> todo on the checklist (own assignments only).
  const toggle = (id: string) =>
    setSlots((ss) => ss.map((s) => {
      if (s.id !== id || s.status === "gap" || s.status === "live") return s;
      return { ...s, status: s.status === "covered" ? "todo" : "covered" };
    }));

  const shownDays = day === "all" ? DAYS : DAYS.filter((d) => d.day === day);

  return (
    <>
      <AppBar />
      <main className="fz-page">
        <div className="fz-head">
          <div>
            <h1>Copertura</h1>
            <p className="muted">Gli slot assegnati a te sui 3 giorni. Segna «coperto» mano a mano, così nessuna sessione resta senza foto.</p>
          </div>
          <span className="agg">{event ? event.name : "—"}</span>
        </div>

        {/* GAP flag. */}
        <div className="banner banner-info" style={{ marginBottom: "var(--s-5)" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" /></svg>
          <span>Funzione in arrivo: endpoint da aggiungere. L'agenda di copertura richiede le tabelle <code>coverage_slots</code> / <code>coverage_assignments</code> e <code>GET /v1/photographer/coverage?eventId=</code> (spec 03 §3.6 / §5.2, G11). Gli slot qui sotto sono di esempio.</span>
        </div>

        <div className="fz-stats st-4">
          <div className="stat"><div className="num">{counts.assigned}</div><div className="cap">Slot assegnati</div></div>
          <div className="stat"><div className="num" style={{ color: "var(--c-success-ink)" }}>{counts.covered}</div><div className="cap">Coperti</div></div>
          <div className="stat"><div className="num" style={{ color: "var(--c-accent-ink)" }}>{counts.live}</div><div className="cap">In corso</div></div>
          <div className="stat"><div className="num" style={{ color: "var(--c-warning-ink)" }}>{counts.todo}</div><div className="cap">Da coprire</div></div>
        </div>

        <div className="segmented cv-dayfilter" role="tablist" aria-label="Filtra per giorno" style={{ margin: "var(--s-5) 0 var(--s-6)" }}>
          {(["all", 1, 2, 3] as const).map((d) => (
            <button key={String(d)} role="tab" aria-selected={day === d} onClick={() => setDay(d)}>{d === "all" ? "Tutti" : "Giorno " + d}</button>
          ))}
        </div>

        {shownDays.map((d) => (
          <section className="cv-daysec" key={d.day}>
            <h2>{d.label}</h2>
            <div className="cv-daydate">{d.date}</div>
            <div className="cv-slots">
              {slots.filter((s) => s.day === d.day).map((s) => {
                const isGap = s.status === "gap";
                const covered = s.status === "covered";
                return (
                  <div className={"cv-slot" + (covered ? " covered" : "") + (isGap ? " gap-slot" : "")} key={s.id}>
                    {isGap ? (
                      <span className="tick" aria-hidden="true" />
                    ) : (
                      <button className="tick" type="button" aria-pressed={covered} aria-label="Segna come coperto" disabled={s.status === "live"} onClick={() => toggle(s.id)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      </button>
                    )}
                    <span className="when">{s.when}</span>
                    <div className="what"><div className="ttl">{s.title}</div><div className="place">{s.place}</div></div>
                    <div className="status"><StatusBadge s={s.status} /></div>
                    {isGap ? <span className="go" /> : (
                      <Link className="icon-btn go" to="/upload" aria-label="Apri nel caricamento" title="Apri nel caricamento">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
