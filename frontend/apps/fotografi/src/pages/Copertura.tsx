import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Shell, Esito, Quota, nf, IconInfo, IconApri, IconCopertura, type EsitoTipo } from "../ui";
import { useActiveEvent } from "../lib/event";

/*
 * Pagina con un buco nel contratto. L'agenda di copertura non esiste ancora:
 *   tabelle: coverage_slots(id,event_id,day,stage,zone,starts_at,ends_at,title)
 *            coverage_assignments(slot_id,photographer_id,status)
 *   endpoint: GET /v1/photographer/coverage?eventId= (G11).
 * Gli slot qui sotto sono di esempio.
 *
 * Le regole che le danno questa forma:
 *
 * 1. «Coperto» è una scelta binaria che resta nella frase: è una CASELLA, non
 *    un interruttore. L'interruttore accende una modalità dell'interfaccia, e
 *    segnare uno slot non accende niente. Il segno della casella è blu: il
 *    significato sta nella parola accanto, non nel colore.
 * 2. Lo stato ha forma e parola. Uno slot scoperto da tutti è AMBRA, non
 *    rosso: è «guarda qui», non un lavoro bloccato. Il rosso resta a ciò che
 *    blocca o non si disfa.
 * 3. La copertura è una proporzione: un numero più dei segni, mai una tinta.
 * 4. Cambiare giorno cambia quale elenco si guarda: sono schede con il filetto
 *    inchiostro e il conteggio in un chip, non un segmentato che sembra un
 *    titolo.
 * 5. Un pulsante con la sola icona ha un aria-label.
 */

type Stato = "coperto" | "da-coprire" | "in-corso" | "assegnato" | "scoperto";
type Slot = { id: string; giorno: 1 | 2 | 3; quando: string; titolo: string; dove: string; stato: Stato };

const SEED: Slot[] = [
  { id: "s11", giorno: 1, quando: "09:00–10:30", titolo: "Apertura e keynote", dove: "Palco Centrale", stato: "coperto" },
  { id: "s12", giorno: 1, quando: "10:30–11:00", titolo: "Caffè e networking", dove: "Area Networking", stato: "coperto" },
  { id: "s13", giorno: 1, quando: "11:00–13:00", titolo: "Panel · Il futuro del lavoro", dove: "Palco Nord", stato: "coperto" },
  { id: "s14", giorno: 1, quando: "14:00–16:00", titolo: "Workshop A · Prodotto", dove: "Sala Workshop", stato: "da-coprire" },
  { id: "s15", giorno: 1, quando: "16:30–18:00", titolo: "Sessione pomeridiana", dove: "Palco Centrale", stato: "in-corso" },
  { id: "s21", giorno: 2, quando: "09:00–11:00", titolo: "Keynote del secondo giorno", dove: "Palco Centrale", stato: "coperto" },
  { id: "s22", giorno: 2, quando: "11:00–13:00", titolo: "Sessioni parallele", dove: "Sala Workshop", stato: "coperto" },
  { id: "s23", giorno: 2, quando: "15:00–17:00", titolo: "Tavola rotonda", dove: "Palco Nord", stato: "da-coprire" },
  { id: "s24", giorno: 2, quando: "20:00–23:00", titolo: "Cena di gala", dove: "Sala Gala · in embargo", stato: "assegnato" },
  { id: "s25", giorno: 2, quando: "17:30–19:00", titolo: "Area espositori", dove: "Area Espositori", stato: "scoperto" },
  { id: "s31", giorno: 3, quando: "09:30–11:30", titolo: "Sessioni finali", dove: "Palco Nord", stato: "coperto" },
  { id: "s32", giorno: 3, quando: "12:00–13:00", titolo: "Pranzo", dove: "Area Networking", stato: "assegnato" },
  { id: "s33", giorno: 3, quando: "17:00–18:30", titolo: "Premiazione e chiusura", dove: "Palco Centrale · in embargo", stato: "assegnato" },
];

const GIORNI = [
  { giorno: 1 as const, label: "Giorno 1", data: "12/03/2026 · Milano" },
  { giorno: 2 as const, label: "Giorno 2", data: "13/03/2026 · Milano" },
  { giorno: 3 as const, label: "Giorno 3", data: "14/03/2026 · Milano" },
];

const STATO: Record<Stato, { forma: EsitoTipo; parola: string }> = {
  coperto: { forma: "fatto", parola: "Coperto" },
  "in-corso": { forma: "corso", parola: "In corso" },
  assegnato: { forma: "spento", parola: "Assegnato" },
  "da-coprire": { forma: "attesa", parola: "Da coprire" },
  scoperto: { forma: "attesa", parola: "Scoperto" },
};

export default function Copertura() {
  const { event } = useActiveEvent();
  const [slot, setSlot] = useState<Slot[]>(SEED);
  const [giorno, setGiorno] = useState<"tutti" | 1 | 2 | 3>("tutti");

  const miei = useMemo(() => slot.filter((s) => s.stato !== "scoperto"), [slot]);
  const c = useMemo(() => ({
    assegnati: miei.length,
    coperti: miei.filter((s) => s.stato === "coperto").length,
    inCorso: miei.filter((s) => s.stato === "in-corso").length,
    daCoprire: miei.filter((s) => s.stato === "da-coprire").length,
    scoperti: slot.filter((s) => s.stato === "scoperto").length,
  }), [miei, slot]);

  /* Il cambio è immediato e non si anima: una riga non si anima. */
  const segna = (id: string, coperto: boolean) =>
    setSlot((ss) => ss.map((s) => {
      if (s.id !== id || s.stato === "scoperto") return s;
      return { ...s, stato: coperto ? "coperto" : s.stato === "coperto" ? "da-coprire" : s.stato };
    }));

  const giorniMostrati = giorno === "tutti" ? GIORNI : GIORNI.filter((d) => d.giorno === giorno);

  return (
    <Shell
      titolo="Copertura"
      dove={`${nf(c.coperti)} di ${nf(c.assegnati)} slot coperti`}
      evento={event ? event.name : null}
    >
      <div className="callout callout--info" role="note">
        <IconInfo />
        <span className="callout__text">
          <strong>Funzione in arrivo.</strong> L'agenda di copertura richiede le tabelle{" "}
          <code>coverage_slots</code> e <code>coverage_assignments</code> e l'endpoint{" "}
          <code>GET /v1/photographer/coverage?eventId=</code> (G11). Gli slot qui sotto sono di
          esempio: la spunta resta su questo computer e non arriva allo staff.
        </span>
      </div>

      <div className="summary">
        <span><b className="dato">{nf(c.assegnati)}</b> slot assegnati a te</span>
        <span><b className="dato">{nf(c.coperti)}</b> coperti</span>
        <span><b className="dato">{nf(c.inCorso)}</b> in corso</span>
        <span><b className="dato">{nf(c.daCoprire)}</b> da coprire</span>
        <Quota n={c.coperti} su={c.assegnati} attenzione={c.daCoprire > 0} suffisso="dei tuoi slot coperto" />
      </div>

      {/* Scoperto per tutti: «guarda qui», e il callout porta con sé che fare. */}
      {c.scoperti > 0 && (
        <div className="callout callout--attention" role="status">
          <IconCopertura />
          <span className="callout__text">
            <strong>
              {c.scoperti === 1
                ? "Una sessione non ha nessun fotografo."
                : `${nf(c.scoperti)} sessioni non hanno nessun fotografo.`}
            </strong>{" "}
            Non è un tuo slot, ma se sei libero puoi coprirla: avvisa lo staff e la troverai
            assegnata. Nelle tabelle è segnata «Scoperto».
          </span>
        </div>
      )}

      {/* Cambiare giorno cambia quale elenco si guarda: schede, non segmentato. */}
      <div className="tabs" role="tablist" aria-label="Filtra per giorno">
        {(["tutti", 1, 2, 3] as const).map((d) => {
          const n = d === "tutti" ? slot.length : slot.filter((s) => s.giorno === d).length;
          return (
            <button
              key={String(d)} className="tab" type="button" role="tab"
              aria-selected={giorno === d} onClick={() => setGiorno(d)}
            >
              {d === "tutti" ? "Tutti i giorni" : `Giorno ${d}`} <span className="chip"><b>{nf(n)}</b></span>
            </button>
          );
        })}
      </div>

      {giorniMostrati.map((d) => {
        const righe = slot.filter((s) => s.giorno === d.giorno);
        const mieiDelGiorno = righe.filter((s) => s.stato !== "scoperto");
        const copertiDelGiorno = mieiDelGiorno.filter((s) => s.stato === "coperto").length;
        return (
          <section className="giorno" key={d.giorno}>
            <div className="giorno__testa">
              <h2>{d.label}</h2>
              <span className="giorno__data">{d.data}</span>
              <span className="giorno__quota">
                <Quota
                  n={copertiDelGiorno}
                  su={mieiDelGiorno.length}
                  attenzione={mieiDelGiorno.length > copertiDelGiorno}
                  suffisso={`dei tuoi slot del ${d.label.toLowerCase()} coperto`}
                />
              </span>
            </div>

            <div className="tbl-wrap">
              <table className="tbl tbl--schede">
                <thead>
                  <tr>
                    <th scope="col" className="tbl__check">Fatto</th>
                    <th scope="col">Orario</th>
                    <th scope="col">Sessione</th>
                    <th scope="col">Stato</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {righe.map((s) => {
                    const mio = s.stato !== "scoperto";
                    const coperto = s.stato === "coperto";
                    return (
                      <tr key={s.id}>
                        <td className="tbl__check" data-etichetta="Fatto">
                          {mio ? (
                            // La casella sta nella frase: l'etichetta nomina la
                            // sessione, così da tastiera si sa cosa si segna.
                            <span className="check">
                              <input
                                type="checkbox"
                                checked={coperto}
                                aria-label={`Segna come coperto: ${s.titolo}, ${s.quando}`}
                                onChange={(e) => segna(s.id, e.target.checked)}
                              />
                            </span>
                          ) : (
                            <span className="nota-min">—</span>
                          )}
                        </td>
                        <td data-etichetta="Orario" className="dato">{s.quando}</td>
                        <td data-etichetta="Sessione">
                          {s.titolo}
                          <span className="cell-sub">
                            {s.dove}
                            {s.stato === "scoperto" ? " · nessun fotografo assegnato" : ""}
                          </span>
                        </td>
                        <td data-etichetta="Stato">
                          <Esito tipo={STATO[s.stato].forma}>{STATO[s.stato].parola}</Esito>
                        </td>
                        <td className="tbl__fine">
                          {mio && (
                            <Link
                              className="btn btn--sm btn--ghost btn--icon"
                              to="/upload"
                              aria-label={`Apri il caricamento per ${s.titolo}`}
                              title="Apri il caricamento"
                            >
                              <IconApri />
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </Shell>
  );
}
