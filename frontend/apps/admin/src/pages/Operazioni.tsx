import { useEffect, useState } from "react";
import { Testa } from "../guscio";
import { Callout, RigheFinte, Vuoto } from "../parti";
import { Ico } from "../icone";
import { leggi, messaggio } from "../lib/api";
import { usaGuardia } from "../lib/eventi";
import type { CollegamentoOps } from "../lib/tipi";

/**
 * Operazioni — i pannelli esterni, presi dalle variabili `OPS_LINK_*`
 * dell'ambiente dell'api.
 *
 * Solo collegamenti, per decisione (specifica v6, sezione D): nessuna
 * integrazione rispecchia quei pannelli qui dentro. Ognuno ha i suoi allarmi
 * e il suo controllo degli accessi; una copia dentro questa console sarebbe
 * una seconda verità da tenere in pari e un secondo posto da cui rubare le
 * chiavi.
 */

export default function Operazioni() {
  const guardia = usaGuardia();
  const [collegamenti, setCollegamenti] = useState<CollegamentoOps[] | null>(null);
  const [errore, setErrore] = useState("");

  useEffect(() => {
    let annullato = false;
    leggi<{ links: CollegamentoOps[] }>("/admin/ops-links")
      .then((d) => { if (!annullato) setCollegamenti(d.links || []); })
      .catch((e: unknown) => {
        if (annullato || guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere i collegamenti."));
        setCollegamenti([]);
      });
    return () => { annullato = true; };
  }, [guardia]);

  return (
    <>
      <Testa
        titolo="Operazioni"
        dek="I pannelli esterni su cui gira il servizio. Solo collegamenti: i dati restano dove sono."
      />

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {collegamenti && collegamenti.length === 0 ? (
        <Vuoto titolo="Nessun collegamento configurato">
          I collegamenti arrivano dall'ambiente dell'api:{" "}
          <span className="mono">OPS_LINK_RESEND</span>, <span className="mono">OPS_LINK_POSTHOG</span>,{" "}
          <span className="mono">OPS_LINK_SENTRY</span>, <span className="mono">OPS_LINK_COOLIFY</span>,{" "}
          <span className="mono">OPS_LINK_AUTHENTIK</span>, <span className="mono">OPS_LINK_R2</span>.
          Finché non sono impostati, questa schermata non ha niente da mostrare — e non è un errore.
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead><tr><th>Pannello</th><th>Indirizzo</th><th className="tbl__azioni"><span className="sr-only">Apri</span></th></tr></thead>
            <tbody>
              {!collegamenti && <RigheFinte righe={4} colonne={3} />}
              {collegamenti?.map((c) => (
                <tr key={c.key}>
                  <td data-et="Pannello">{c.label}</td>
                  <td data-et="Indirizzo" className="mono--id">{c.url}</td>
                  <td className="tbl__azioni" data-et="Apri">
                    <a className="btn btn--sm" href={c.url} target="_blank" rel="noreferrer noopener">
                      {Ico.esterno}
                      Apri
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
