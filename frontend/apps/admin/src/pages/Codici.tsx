import { useEffect, useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import {
  Callout, Esito, Finestra, Pannello, Primario, PrimarioPannello, RigheFinte, Vuoto, usaAvvisi,
} from "../parti";
import { Ico } from "../icone";
import { cancella, correggi, invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { numero, quando } from "../lib/formato";
import type { CodiceEvento } from "../lib/tipi";

/**
 * Codici d'ingresso.
 *
 * È la schermata che sblocca il giorno dell'evento: il codice stampato sul
 * badge è il cancello anti-bot di `POST /v1/auth/register`, e senza un codice
 * attivo nessuno può iscriversi. Per questo lo stato vuoto non dice «nessun
 * codice» e si ferma lì: dice che senza codice le iscrizioni sono chiuse.
 *
 * L'alfabeto di un codice generato non contiene I, O, 0 e 1, così un codice
 * letto da un badge non diventa un altro codice. Quello scritto a mano viene
 * confrontato in maiuscolo, quindi il campo lo alza da sé.
 */

const STATO: Record<CodiceEvento["status"], [string, string]> = {
  // Attivo: pieno. Esaurito: ambra, perché è il momento di guardare — chi
  // arriva adesso non entra. Scaduto: trattino, non è più pertinente.
  active: ["chiarita", "Attivo"],
  exhausted: ["da-esaminare", "Esaurito"],
  expired: ["non-pertinente", "Scaduto"],
};

type Modulo = { code: string; label: string; maxUses: string; expiresAt: string };
const VUOTO: Modulo = { code: "", label: "", maxUses: "", expiresAt: "" };

export default function Codici() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [codici, setCodici] = useState<CodiceEvento[] | null>(null);
  const [errore, setErrore] = useState("");
  const [aperto, setAperto] = useState(false);
  const [modulo, setModulo] = useState<Modulo>(VUOTO);
  const [creando, setCreando] = useState(false);
  const [erroreModulo, setErroreModulo] = useState("");
  const [daRevocare, setDaRevocare] = useState<CodiceEvento | null>(null);
  const [revocando, setRevocando] = useState(false);
  const [ultimo, setUltimo] = useState<string>("");

  const eventoId = evento?.id ?? "";

  function carica(id: string) {
    leggi<{ codes: CodiceEvento[] }>(`/admin/events/${id}/codes`)
      .then((d) => { setCodici(d.codes || []); setErrore(""); })
      .catch((e: unknown) => {
        if (guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere i codici."));
        setCodici([]);
      });
  }

  useEffect(() => {
    if (!eventoId) return;
    setCodici(null);
    carica(eventoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventoId]);

  async function crea() {
    if (!eventoId || creando) return;
    setCreando(true);
    setErroreModulo("");
    const corpo: Record<string, unknown> = {
      label: modulo.label.trim() === "" ? null : modulo.label.trim(),
      maxUses: modulo.maxUses.trim() === "" ? null : Number(modulo.maxUses),
      expiresAt: modulo.expiresAt === "" ? null : new Date(modulo.expiresAt).toISOString(),
    };
    if (modulo.code.trim() !== "") corpo.code = modulo.code.trim().toUpperCase();
    try {
      const d = await invia<{ code: CodiceEvento }>(`/admin/events/${eventoId}/codes`, corpo);
      setUltimo(d.code.code);
      setModulo(VUOTO);
      setAperto(false);
      carica(eventoId);
      avvisa(`Codice ${d.code.code} creato.`, "success", "Si può stampare sul badge.");
    } catch (e: unknown) {
      if (guardia(e)) return;
      setErroreModulo(
        stato(e) === 409
          ? "Questo codice esiste già in un altro evento: scegline un altro o lascia il campo vuoto e lo generiamo noi."
          : messaggio(e, "Creazione non riuscita."),
      );
    } finally {
      setCreando(false);
    }
  }

  async function limita(c: CodiceEvento) {
    if (!eventoId) return;
    try {
      await correggi(`/admin/events/${eventoId}/codes/${encodeURIComponent(c.code)}`, { maxUses: Math.max(1, c.uses) });
      carica(eventoId);
      avvisa(`Codice ${c.code} chiuso a ${numero(Math.max(1, c.uses))} usi.`, "success", "Chi lo digita adesso non entra più.");
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Modifica non riuscita."), "error"); }
  }

  async function revoca() {
    if (!daRevocare || !eventoId || revocando) return;
    setRevocando(true);
    try {
      await cancella(`/admin/events/${eventoId}/codes/${encodeURIComponent(daRevocare.code)}`);
      avvisa(`Codice ${daRevocare.code} revocato.`, "warning", "Chi ce l'ha stampato non può più iscriversi.");
      setDaRevocare(null);
      carica(eventoId);
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Revoca non riuscita."), "error"); }
    finally { setRevocando(false); }
  }

  async function copia(codice: string) {
    try {
      await navigator.clipboard?.writeText(codice);
      avvisa(`Codice ${codice} copiato.`, "success");
    } catch {
      avvisa("Il browser non ci lascia copiare: selezionalo a mano.", "error");
    }
  }

  if (!evento) return (<><Testa titolo="Codici d'ingresso" /><ServeUnEvento /></>);

  const attivi = (codici ?? []).filter((c) => c.status === "active").length;

  return (
    <>
      <Testa
        titolo="Codici d'ingresso"
        dek="Il codice stampato sul badge è il cancello delle iscrizioni: senza un codice attivo nessuno può registrarsi."
        /* Quando la tabella è vuota il primario è quello dello stato vuoto, e
           questo non si disegna: un solo inchiostro in vista (REGOLE §3). */
        azioni={
          codici && codici.length === 0 ? undefined : (
            <Primario onClick={() => { setErroreModulo(""); setAperto(true); }}>Crea un codice</Primario>
          )
        }
      />

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {codici && codici.length > 0 && attivi === 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Callout
            genere="attention"
            ruolo="status"
            azione={<button className="btn btn--sm" type="button" onClick={() => setAperto(true)}>Crea un codice</button>}
          >
            <strong>Nessun codice attivo.</strong> I codici qui sotto sono scaduti o esauriti: in
            questo momento chi arriva al banco non riesce a iscriversi.
          </Callout>
        </div>
      )}

      {ultimo && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Callout
            genere="ok"
            ruolo="status"
            azione={
              <button className="btn btn--sm" type="button" onClick={() => void copia(ultimo)}>Copia</button>
            }
          >
            Ultimo codice creato: <strong className="mono">{ultimo}</strong>. È l'unica volta che lo
            vedi evidenziato — resta comunque nella tabella qui sotto.
          </Callout>
        </div>
      )}

      {codici && codici.length === 0 ? (
        <Vuoto
          titolo="Nessun codice: le iscrizioni sono chiuse"
          azione={<Primario onClick={() => setAperto(true)}>Crea un codice</Primario>}
        >
          Il codice è quello che i partecipanti digitano per registrarsi, e lo si stampa sul badge
          o sotto il QR. Finché non ce n'è uno attivo, la pagina di iscrizione rifiuta tutti.
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th>Codice</th><th>Etichetta</th><th className="num">Usi</th><th>Stato</th>
                <th>Scade</th><th>Creato</th><th className="tbl__azioni"><span className="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              {!codici && <RigheFinte righe={4} colonne={7} />}
              {codici?.map((c) => {
                const [forma, parola] = STATO[c.status];
                return (
                  <tr key={c.code}>
                    <td data-et="Codice">
                      <span className="mono" style={{ fontWeight: "var(--weight-semibold)" }}>{c.code}</span>
                      <button
                        className="btn btn--ghost btn--icon btn--sm"
                        type="button"
                        onClick={() => void copia(c.code)}
                        aria-label={`Copia il codice ${c.code}`}
                        title="Copia"
                      >
                        {Ico.copia}
                      </button>
                    </td>
                    <td data-et="Etichetta">{c.label ?? "—"}</td>
                    <td className="num" data-et="Usi">
                      {numero(c.uses)}{c.maxUses === null ? "" : ` / ${numero(c.maxUses)}`}
                      {c.maxUses === null && <span className="cell-sub">senza limite</span>}
                    </td>
                    <td data-et="Stato"><Esito forma={forma}>{parola}</Esito></td>
                    <td data-et="Scade">{quando(c.expiresAt)}</td>
                    <td data-et="Creato">{quando(c.createdAt)}</td>
                    <td className="tbl__azioni" data-et="Azioni">
                      {c.status === "active" && (
                        <button className="btn btn--sm" type="button" onClick={() => void limita(c)} title="Mette il limite a quanti l'hanno già usato: da adesso non entra più nessuno con questo codice">
                          Chiudi qui
                        </button>
                      )}{" "}
                      <button className="btn btn--sm" type="button" onClick={() => setDaRevocare(c)} title="Chiede conferma: da revocato nessuno può più iscriversi con questo codice">
                        Revoca…
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pannello
        aperto={aperto}
        titolo="Crea un codice d'ingresso"
        dek={evento.name}
        onChiudi={() => setAperto(false)}
        primario={
          <PrimarioPannello
            onClick={() => void crea()}
            attesa={creando}
            disabled={modulo.maxUses.trim() !== "" && !(Number(modulo.maxUses) > 0)}
            perche="Il numero massimo di usi deve essere almeno 1, oppure lascia il campo vuoto."
          >
            Crea il codice
          </PrimarioPannello>
        }
      >
        <p className="motivo" style={{ marginBottom: "var(--space-4)" }}>
          Lasciando il codice vuoto lo generiamo noi, con un alfabeto senza I, O, 0 e 1: un codice
          letto da un badge non può diventare un altro codice.
        </p>

        <div className="field">
          <label className="field__label" htmlFor="codice-valore">
            Codice <span className="opt">facoltativo</span>
          </label>
          <input
            id="codice-valore"
            className="input mono"
            value={modulo.code}
            onChange={(e) => setModulo({ ...modulo, code: e.target.value.toUpperCase() })}
            placeholder="ABCD-EFGH"
            autoComplete="off"
          />
          <span className="field__hint">Si confronta in maiuscolo, quindi lo scriviamo in maiuscolo.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="codice-etichetta">
            Etichetta <span className="opt">facoltativa</span>
          </label>
          <input
            id="codice-etichetta"
            className="input"
            value={modulo.label}
            onChange={(e) => setModulo({ ...modulo, label: e.target.value })}
            placeholder="Banco ingresso · giovedì"
          />
          <span className="field__hint">Serve a te, per sapere dove è finito questo codice. Non la vede chi si iscrive.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="codice-usi">
            Usi massimi <span className="opt">facoltativo</span>
          </label>
          <input
            id="codice-usi"
            className="input"
            type="number"
            min={1}
            value={modulo.maxUses}
            onChange={(e) => setModulo({ ...modulo, maxUses: e.target.value })}
            placeholder="senza limite"
          />
          <span className="field__hint">Vuoto: nessun limite. Con un numero, al raggiungimento il codice risulta esaurito.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="codice-scadenza">
            Scadenza <span className="opt">facoltativa</span>
          </label>
          <input
            id="codice-scadenza"
            className="input"
            type="datetime-local"
            value={modulo.expiresAt}
            onChange={(e) => setModulo({ ...modulo, expiresAt: e.target.value })}
          />
          <span className="field__hint">Dopo questo momento il codice non vale più. Vuoto: non scade.</span>
        </div>

        {erroreModulo && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Callout genere="errore" ruolo="alert">{erroreModulo}</Callout>
          </div>
        )}
      </Pannello>

      <Finestra
        aperta={daRevocare !== null}
        titolo={daRevocare ? `Revocare il codice ${daRevocare.code}?` : ""}
        onChiudi={() => setDaRevocare(null)}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={revocando}
            data-loading={revocando || undefined}
            onClick={() => void revoca()}
          >
            {revocando && <span className="btn-spin" aria-hidden="true" />}
            Revoca il codice
          </button>
        }
      >
        <p>
          Da subito chi digita questo codice non riesce a registrarsi. Chi l'ha già usato resta
          iscritto: la revoca non toglie nessuno. Se il codice è stampato su dei badge già
          consegnati, quelle persone resteranno fuori.
        </p>
        {daRevocare && daRevocare.uses > 0 && (
          <p className="motivo">L'hanno già usato {numero(daRevocare.uses)} persone.</p>
        )}
      </Finestra>
    </>
  );
}
