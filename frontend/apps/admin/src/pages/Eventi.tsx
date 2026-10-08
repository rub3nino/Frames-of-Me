import { useEffect, useState } from "react";
import { Testa } from "../guscio";
import {
  Callout, Esito, Finestra, Pannello, Primario, PrimarioPannello, RigheFinte, Vuoto, usaAvvisi,
} from "../parti";
import { correggi, invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { emailValida, numero, quando } from "../lib/formato";
import type { Evento } from "../lib/tipi";

/**
 * Eventi — l'elenco, e per ognuno il pannello delle sue impostazioni.
 *
 * Le impostazioni dell'evento stavano in una schermata a parte («Gestione»),
 * che era un elenco di riquadri senza un soggetto: si leggeva «accesso» senza
 * sapere di cosa. Ora sono il dettaglio di una riga, dove il soggetto è il
 * titolo del pannello (REGOLE §4: dettaglio senza lasciare la lista).
 *
 * Lo svuotamento dell'evento invece non è un'impostazione: è un dialogo, e
 * chiede di scrivere l'identificativo. Una spunta basta per cancellare una
 * foto; per cancellare un evento intero serve digitare il suo nome.
 */

const IMPORT_MAX = 5000;

type Nuovo = { name: string; slug: string; retentionDays: string; access: "open" | "list" };
const NUOVO: Nuovo = { name: "", slug: "", retentionDays: "90", access: "open" };

export default function Eventi() {
  const { eventi, evento: scelto, ricarica, errore: erroreElenco, scegli } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [pannello, setPannello] = useState<"nuovo" | Evento | null>(null);
  const [nuovo, setNuovo] = useState<Nuovo>(NUOVO);
  const [creando, setCreando] = useState(false);
  const [erroreModulo, setErroreModulo] = useState("");

  // Impostazioni dell'evento aperto
  const [accesso, setAccesso] = useState<"open" | "list">("open");
  const [retention, setRetention] = useState("90");
  const [salvando, setSalvando] = useState(false);

  // Inviti e importazioni
  const [emailFotografo, setEmailFotografo] = useState("");
  const [invitando, setInvitando] = useState(false);
  const [indirizzi, setIndirizzi] = useState("");
  const [importando, setImportando] = useState(false);

  // Svuotamento
  const [daSvuotare, setDaSvuotare] = useState<Evento | null>(null);
  const [digitato, setDigitato] = useState("");
  const [svuotando, setSvuotando] = useState(false);

  const inModifica = pannello !== null && pannello !== "nuovo" ? pannello : null;

  useEffect(() => {
    if (!inModifica) return;
    setAccesso(inModifica.access);
    setRetention(String(inModifica.retentionDays));
    setEmailFotografo("");
    setIndirizzi("");
  }, [inModifica]);

  async function crea() {
    if (creando) return;
    setCreando(true);
    setErroreModulo("");
    try {
      await invia("/admin/events", {
        name: nuovo.name.trim(),
        slug: nuovo.slug.trim(),
        retentionDays: Number(nuovo.retentionDays) || 90,
        access: nuovo.access,
      });
      setNuovo(NUOVO);
      setPannello(null);
      ricarica();
      avvisa(`Evento «${nuovo.name.trim()}» creato.`, "success", "Ora serve un codice d'ingresso.");
    } catch (e: unknown) {
      if (guardia(e)) return;
      setErroreModulo(
        stato(e) === 409
          ? "C'è già un evento con questo identificativo: cambialo."
          : messaggio(e, "Creazione non riuscita."),
      );
    } finally { setCreando(false); }
  }

  async function salvaImpostazioni() {
    if (!inModifica || salvando) return;
    const giorni = Number(retention);
    setSalvando(true);
    try {
      await correggi(`/admin/events/${inModifica.id}`, { access: accesso, retentionDays: giorni });
      ricarica();
      avvisa(`Impostazioni di «${inModifica.name}» salvate.`, "success");
      setPannello(null);
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Salvataggio non riuscito."), "error"); }
    finally { setSalvando(false); }
  }

  async function invita() {
    if (!inModifica || !emailValida(emailFotografo) || invitando) return;
    setInvitando(true);
    try {
      await invia("/admin/photographers/invite", {
        email: emailFotografo.trim().toLowerCase(),
        eventId: inModifica.id,
      });
      setEmailFotografo("");
      avvisa("Invito inviato.", "success", "Scade dopo sette giorni.");
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Invito non riuscito."), "error"); }
    finally { setInvitando(false); }
  }

  const righeImport = indirizzi.split("\n").map((s) => s.trim()).filter(Boolean);
  const troppi = righeImport.length > IMPORT_MAX;

  async function importa() {
    if (!inModifica || righeImport.length === 0 || troppi || importando) return;
    setImportando(true);
    try {
      const d = await invia<{ inserted: number }>("/admin/participants/import", {
        eventId: inModifica.id,
        emails: righeImport,
      });
      setIndirizzi("");
      avvisa(`${numero(d.inserted)} indirizzi importati.`, "success", "Gli indirizzi già presenti sono stati ignorati.");
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Importazione non riuscita."), "error"); }
    finally { setImportando(false); }
  }

  async function svuota() {
    if (!daSvuotare || digitato.trim() !== daSvuotare.slug || svuotando) return;
    setSvuotando(true);
    try {
      await invia(`/admin/events/${daSvuotare.id}/reset`, { confirm: daSvuotare.slug });
      avvisa(`Svuotamento di «${daSvuotare.name}» avviato.`, "warning", "Il lavoro gira in sottofondo.");
      setDaSvuotare(null);
      setDigitato("");
      setPannello(null);
      ricarica();
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Svuotamento non riuscito."), "error"); }
    finally { setSvuotando(false); }
  }

  const vuoto = eventi !== null && eventi.length === 0;

  return (
    <>
      <Testa
        titolo="Eventi"
        dek="Un evento è il contenitore di tutto: album, codici, partecipanti, foto e la loro scadenza."
        azioni={vuoto ? undefined : <Primario onClick={() => { setErroreModulo(""); setNuovo(NUOVO); setPannello("nuovo"); }}>Crea un evento</Primario>}
      />

      {erroreElenco && <Callout genere="errore" ruolo="alert">{erroreElenco}</Callout>}

      {vuoto ? (
        <Vuoto
          titolo="Nessun evento"
          azione={<Primario onClick={() => setPannello("nuovo")}>Crea un evento</Primario>}
        >
          Tutto il resto della console lavora su un evento: album, codici, foto e gallerie stanno
          dentro uno. Creane uno e la barra in alto comincerà a dire su cosa stai lavorando.
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th>Evento</th><th>Accesso</th><th className="num">Conservazione</th>
                <th className="num">Foto</th><th className="num">Gallerie</th>
                <th className="num">Partecipanti</th><th className="num">Fotografi</th>
                <th className="tbl__azioni"><span className="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              {!eventi && <RigheFinte righe={3} colonne={8} />}
              {eventi?.map((e) => (
                <tr key={e.id} aria-selected={inModifica?.id === e.id ? true : undefined}>
                  <td data-et="Evento">
                    <button className="btn btn--link" type="button" onClick={() => setPannello(e)}>{e.name}</button>
                    <span className="cell-sub mono">{e.slug}</span>
                  </td>
                  <td data-et="Accesso">
                    <Esito forma={e.access === "list" ? "in-esame" : "chiarita"}>
                      {e.access === "list" ? "Solo chi è in elenco" : "Aperto a chi ha il codice"}
                    </Esito>
                  </td>
                  <td className="num" data-et="Conservazione">{numero(e.retentionDays)} gg</td>
                  <td className="num" data-et="Foto">{numero(e.photos)}</td>
                  <td className="num" data-et="Gallerie">{numero(e.galleries)}</td>
                  <td className="num" data-et="Partecipanti">{numero(e.participants)}</td>
                  <td className="num" data-et="Fotografi">{numero(e.photographers)}</td>
                  <td className="tbl__azioni" data-et="Azioni">
                    {scelto?.id !== e.id && (
                      <button className="btn btn--sm" type="button" onClick={() => scegli(e.id)} title="Porta tutta la console su questo evento">
                        Lavora su questo
                      </button>
                    )}{" "}
                    <button className="btn btn--sm" type="button" onClick={() => setPannello(e)}>Impostazioni</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Creazione ----------------------------------------------------- */}
      <Pannello
        aperto={pannello === "nuovo"}
        titolo="Crea un evento"
        onChiudi={() => setPannello(null)}
        primario={
          <PrimarioPannello
            onClick={() => void crea()}
            attesa={creando}
            disabled={nuovo.name.trim() === "" || nuovo.slug.trim() === ""}
            perche="Servono un nome e un identificativo."
          >
            Crea l'evento
          </PrimarioPannello>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor="evento-nome">Nome</label>
          <input id="evento-nome" className="input" value={nuovo.name} onChange={(e) => setNuovo({ ...nuovo, name: e.target.value })} placeholder="Conferenza Europea 2026" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="evento-slug">Identificativo</label>
          <input
            id="evento-slug"
            className="input mono"
            value={nuovo.slug}
            onChange={(e) => setNuovo({ ...nuovo, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
            placeholder="conferenza-2026"
          />
          <span className="field__hint">Finisce negli indirizzi pubblici dell'evento.</span>
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="field__label" htmlFor="evento-retention">Giorni di conservazione</label>
            <input id="evento-retention" className="input" type="number" min={1} value={nuovo.retentionDays} onChange={(e) => setNuovo({ ...nuovo, retentionDays: e.target.value })} />
            <span className="field__hint">Dopo questi giorni le foto vengono cancellate.</span>
          </div>
          <div className="field">
            <span className="field__label" id="evento-accesso-et">Accesso</span>
            <div className="segmented" role="group" aria-labelledby="evento-accesso-et">
              <button type="button" aria-pressed={nuovo.access === "open"} onClick={() => setNuovo({ ...nuovo, access: "open" })}>Aperto</button>
              <button type="button" aria-pressed={nuovo.access === "list"} onClick={() => setNuovo({ ...nuovo, access: "list" })}>Solo in elenco</button>
            </div>
          </div>
        </div>
        {erroreModulo && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Callout genere="errore" ruolo="alert">{erroreModulo}</Callout>
          </div>
        )}
      </Pannello>

      {/* --- Impostazioni di un evento ------------------------------------- */}
      <Pannello
        aperto={inModifica !== null}
        titolo={inModifica?.name ?? ""}
        dek={inModifica?.slug}
        onChiudi={() => setPannello(null)}
        primario={
          <PrimarioPannello
            onClick={() => void salvaImpostazioni()}
            attesa={salvando}
            disabled={!(Number(retention) >= 1)}
            perche="La conservazione è almeno un giorno."
          >
            Salva le impostazioni
          </PrimarioPannello>
        }
      >
        <div className="field">
          <span className="field__label" id="imp-accesso-et">Chi può iscriversi</span>
          <div className="segmented" role="group" aria-labelledby="imp-accesso-et">
            <button type="button" aria-pressed={accesso === "open"} onClick={() => setAccesso("open")}>Chi ha il codice</button>
            <button type="button" aria-pressed={accesso === "list"} onClick={() => setAccesso("list")}>Solo chi è in elenco</button>
          </div>
          <span className="field__hint">
            {accesso === "list"
              ? "Solo gli indirizzi importati qui sotto possono fare il selfie."
              : "Chiunque abbia un codice d'ingresso valido può registrarsi."}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="imp-retention">Giorni di conservazione</label>
          <input id="imp-retention" className="input" type="number" min={1} style={{ maxWidth: 140 }} value={retention} onChange={(e) => setRetention(e.target.value)} />
          <span className="field__hint">
            Abbassarla anticipa la cancellazione: le foto più vecchie della nuova soglia vengono
            cancellate alla prima pulizia.
          </span>
        </div>

        <hr />

        <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", marginBottom: "var(--space-1)" }}>Invita un fotografo</h3>
        <p className="motivo" style={{ marginBottom: "var(--space-3)" }}>
          Riceve un invito per questo evento, valido sette giorni. Per limitarlo a un solo album,
          dopo l'invito vai in «Album».
        </p>
        <div className="field">
          <label className="field__label" htmlFor="imp-fotografo">Indirizzo</label>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <input id="imp-fotografo" className="input" type="email" value={emailFotografo} onChange={(e) => setEmailFotografo(e.target.value)} placeholder="nome@studio.it" />
            <button
              className="btn"
              type="button"
              onClick={() => void invita()}
              disabled={!emailValida(emailFotografo) || invitando}
              title={emailValida(emailFotografo) ? undefined : "Scrivi un indirizzo valido"}
            >
              {invitando && <span className="btn-spin" aria-hidden="true" />}
              Invia l'invito
            </button>
          </div>
        </div>

        <hr />

        <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", marginBottom: "var(--space-1)" }}>Importa i partecipanti</h3>
        <p className="motivo" style={{ marginBottom: "var(--space-3)" }}>
          Un indirizzo per riga, al massimo {numero(IMPORT_MAX)} per volta. Serve solo quando
          l'accesso è «solo chi è in elenco»: gli indirizzi già presenti vengono ignorati.
        </p>
        <div className="field">
          <label className="field__label" htmlFor="imp-indirizzi">Indirizzi</label>
          <textarea
            id="imp-indirizzi"
            className="textarea"
            rows={6}
            value={indirizzi}
            onChange={(e) => setIndirizzi(e.target.value)}
            placeholder={"laura.bianchi@gmail.com\nm.rossi@outlook.it"}
            aria-describedby="imp-conteggio"
          />
          <span className="field__hint" id="imp-conteggio">
            {numero(righeImport.length)} su {numero(IMPORT_MAX)}
            {troppi ? " — troppi: dividi l'elenco in due importazioni." : ""}
          </span>
          <div>
            <button
              className="btn"
              type="button"
              onClick={() => void importa()}
              disabled={righeImport.length === 0 || troppi || importando}
              title={righeImport.length === 0 ? "Incolla prima gli indirizzi" : troppi ? `Massimo ${numero(IMPORT_MAX)} per importazione` : undefined}
            >
              {importando && <span className="btn-spin" aria-hidden="true" />}
              Importa gli indirizzi
            </button>
          </div>
        </div>

        <hr />

        <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", marginBottom: "var(--space-1)" }}>Svuota l'evento</h3>
        <p className="motivo" style={{ marginBottom: "var(--space-3)" }}>
          Cancella foto, copie, volti, gallerie e consensi di questo evento. L'evento resta, con i
          suoi album vuoti. È il modo di ripulire una prova prima della giornata vera.
        </p>
        <button
          className="btn btn--danger"
          type="button"
          onClick={() => { setDigitato(""); setDaSvuotare(inModifica); }}
        >
          Svuota l'evento…
        </button>
      </Pannello>

      <Finestra
        aperta={daSvuotare !== null}
        titolo={daSvuotare ? `Svuotare «${daSvuotare.name}»?` : ""}
        onChiudi={() => { setDaSvuotare(null); setDigitato(""); }}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!daSvuotare || digitato.trim() !== daSvuotare.slug || svuotando}
            data-loading={svuotando || undefined}
            title={daSvuotare && digitato.trim() !== daSvuotare.slug ? `Scrivi «${daSvuotare.slug}» per confermare` : undefined}
            onClick={() => void svuota()}
          >
            {svuotando && <span className="btn-spin" aria-hidden="true" />}
            Svuota l'evento
          </button>
        }
      >
        <p>
          Vengono cancellati in modo <strong>irreversibile</strong> tutte le foto e i loro originali,
          i volti rilevati, le gallerie personali e i consensi raccolti. Il lavoro gira in sottofondo
          e non si può fermare a metà.
        </p>
        <ul className="finestra__cosa">
          <li><span>Foto</span><span className="num">{numero(daSvuotare?.photos)}</span></li>
          <li><span>Gallerie</span><span className="num">{numero(daSvuotare?.galleries)}</span></li>
          <li><span>Partecipanti</span><span className="num">{numero(daSvuotare?.participants)}</span></li>
          <li><span>Creato</span><span>{quando(daSvuotare?.createdAt)}</span></li>
        </ul>
        <div className="field">
          <label className="field__label" htmlFor="svuota-conferma">
            Scrivi <span className="mono">{daSvuotare?.slug}</span> per confermare
          </label>
          <input
            id="svuota-conferma"
            className="input mono"
            value={digitato}
            onChange={(e) => setDigitato(e.target.value)}
            placeholder={daSvuotare?.slug}
            autoComplete="off"
          />
          <span className="field__hint">
            Una spunta basta per una foto. Per un evento intero serve scriverne il nome.
          </span>
        </div>
      </Finestra>
    </>
  );
}
