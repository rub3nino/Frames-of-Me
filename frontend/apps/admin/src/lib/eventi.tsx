import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { leggi, stato } from "./api";
import type { Evento } from "./tipi";

/**
 * L'evento scelto è l'AMBITO della console: quasi ogni rotta di servizio
 * vuole un `eventId`, e la scelta sta nella topbar perché è una cosa sola per
 * tutta la sessione, non un filtro per schermata.
 *
 * Sta in un contesto e non in un hook per pagina: con un hook per pagina ogni
 * cambio di schermata rileggeva l'elenco degli eventi e, per un istante,
 * l'ambito era vuoto e la tabella sotto si svuotava con lui.
 *
 * La scelta resta in `sessionStorage` così sopravvive alla navigazione e non
 * al logout.
 */
const CHIAVE = "rephoto.admin.eventId";

type Ambito = {
  eventi: Evento[] | null;
  eventoId: string;
  evento: Evento | null;
  scegli: (id: string) => void;
  /** Rilegge l'elenco: dopo una creazione o una modifica dei conteggi. */
  ricarica: () => void;
  errore: string;
};

const AmbitoCtx = createContext<Ambito>({
  eventi: null, eventoId: "", evento: null, scegli: () => {}, ricarica: () => {}, errore: "",
});

export function ProviderEventi({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const [eventi, setEventi] = useState<Evento[] | null>(null);
  const [errore, setErrore] = useState("");
  const [tentativo, setTentativo] = useState(0);
  const [eventoId, setEventoId] = useState<string>(() => {
    try { return sessionStorage.getItem(CHIAVE) || ""; } catch { return ""; }
  });

  useEffect(() => {
    let annullato = false;
    leggi<{ events: Evento[] }>("/admin/events")
      .then((d) => {
        if (annullato) return;
        const elenco = d.events || [];
        setEventi(elenco);
        setErrore("");
        setEventoId((corrente) => {
          if (corrente && elenco.some((e) => e.id === corrente)) return corrente;
          const primo = elenco[0]?.id || "";
          try { if (primo) sessionStorage.setItem(CHIAVE, primo); } catch { /* sessione non scrivibile */ }
          return primo;
        });
      })
      .catch((e: unknown) => {
        if (annullato) return;
        const s = stato(e);
        if (s === 401 || s === 403) nav("/");
        else setErrore("Non riusciamo a leggere gli eventi: la console non sa su cosa stai lavorando. Ricarica la pagina.");
      });
    return () => { annullato = true; };
  }, [nav, tentativo]);

  const scegli = useCallback((id: string) => {
    setEventoId(id);
    try { sessionStorage.setItem(CHIAVE, id); } catch { /* sessione non scrivibile */ }
  }, []);
  const ricarica = useCallback(() => setTentativo((n) => n + 1), []);

  const valore = useMemo<Ambito>(() => ({
    eventi,
    eventoId,
    evento: eventi?.find((e) => e.id === eventoId) ?? null,
    scegli,
    ricarica,
    errore,
  }), [eventi, eventoId, scegli, ricarica, errore]);

  return <AmbitoCtx.Provider value={valore}>{children}</AmbitoCtx.Provider>;
}

export const usaEventi = () => useContext(AmbitoCtx);

/**
 * Il guardiano delle schermate: una 401 o 403 su una lettura qualunque vuol
 * dire che la sessione è scaduta, e la console torna all'accesso invece di
 * mostrare una tabella vuota senza dire perché.
 */
export function usaGuardia() {
  const nav = useNavigate();
  return useCallback((e: unknown) => {
    const s = stato(e);
    if (s === 401 || s === 403) { nav("/"); return true; }
    return false;
  }, [nav]);
}
