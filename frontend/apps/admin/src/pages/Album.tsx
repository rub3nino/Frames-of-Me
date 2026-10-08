import { useCallback, useEffect, useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import {
  Callout, Esito, Pannello, Primario, PrimarioPannello, RigheFinte, Vuoto, usaAvvisi,
} from "../parti";
import { cancella, correggi, invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { emailValida, numero, quando } from "../lib/formato";
import type { Album as RigaAlbum, FotografoAlbum, GenereAlbum, ModerazioneAlbum, VisibilitaAlbum } from "../lib/tipi";

/**
 * Album.
 *
 * Due regole del modello dati sono visibili qui, e sono l'unica ragione per
 * cui questa schermata non è un modulo qualunque:
 *
 * 1. un album «dei partecipanti» NON può usare il riconoscimento (decisione 2
 *    della specifica v6, congelata). L'interruttore non è solo spento: è
 *    spento con scritto perché, e scegliendo quel genere si spegne da sé;
 * 2. dopo la prima foto il riconoscimento non si cambia più, perché i vettori
 *    sono isolati per album e accenderlo a metà strada lascerebbe metà
 *    dell'album fuori da ogni ricerca. Anche questo è scritto nel modulo,
 *    accanto all'interruttore bloccato.
 *
 * «Caricamenti aperti» è un interruttore e non una casella: accende una
 * modalità con effetto immediato e reversibile (REGOLE §2). È il tasto del
 * giorno dell'evento — da chiuso nessuno carica più in quell'album.
 */

const GENERE: Record<GenereAlbum, string> = { official: "Ufficiale", crowd: "Dei partecipanti" };
const MODERAZIONE: Record<ModerazioneAlbum, string> = {
  pre: "Prima della pubblicazione", post: "Dopo, su segnalazione", off: "Nessuna",
};
const VISIBILITA: Record<VisibilitaAlbum, string> = {
  participants: "Tutti i partecipanti", link: "Chi ha il link", staff: "Solo lo staff",
};

type Modulo = {
  slug: string; name: string; kind: GenereAlbum; recognition: boolean;
  moderation: ModerazioneAlbum; visibility: VisibilitaAlbum;
  maxPhotosPerUser: string; retentionDays: string; uploadsOpen: boolean;
};

const VUOTO: Modulo = {
  slug: "", name: "", kind: "official", recognition: true,
  moderation: "post", visibility: "participants",
  maxPhotosPerUser: "", retentionDays: "", uploadsOpen: true,
};

const daAlbum = (a: RigaAlbum): Modulo => ({
  slug: a.slug, name: a.name, kind: a.kind, recognition: a.recognition,
  moderation: a.moderation, visibility: a.visibility,
  maxPhotosPerUser: a.maxPhotosPerUser === null ? "" : String(a.maxPhotosPerUser),
  retentionDays: a.retentionDays === null ? "" : String(a.retentionDays),
  uploadsOpen: a.uploadsOpen,
});

export default function Album() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [album, setAlbum] = useState<RigaAlbum[] | null>(null);
  const [errore, setErrore] = useState("");
  /** `null` = chiuso, `"nuovo"` = creazione, altrimenti l'album in modifica. */
  const [pannello, setPannello] = useState<"nuovo" | RigaAlbum | null>(null);
  const [modulo, setModulo] = useState<Modulo>(VUOTO);
  const [salvando, setSalvando] = useState(false);
  const [erroreModulo, setErroreModulo] = useState("");

  const [fotografi, setFotografi] = useState<FotografoAlbum[] | null>(null);
  const [soloQuesti, setSoloQuesti] = useState(false);
  const [nuovoFotografo, setNuovoFotografo] = useState("");
  const [aggiungendo, setAggiungendo] = useState(false);

  const eventoId = evento?.id ?? "";

  const carica = useCallback(() => {
    if (!eventoId) return;
    leggi<{ albums: RigaAlbum[] }>(`/admin/events/${eventoId}/albums`)
      .then((d) => { setAlbum(d.albums || []); setErrore(""); })
      .catch((e: unknown) => {
        if (guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere gli album."));
        setAlbum([]);
      });
  }, [eventoId, guardia]);

  useEffect(() => { setAlbum(null); carica(); }, [carica]);

  const inModifica = pannello !== null && pannello !== "nuovo" ? pannello : null;

  useEffect(() => {
    if (!inModifica) { setFotografi(null); return; }
    let annullato = false;
    setFotografi(null);
    leggi<{ photographers: FotografoAlbum[]; restricted: boolean }>(`/admin/albums/${inModifica.id}/photographers`)
      .then((d) => { if (annullato) return; setFotografi(d.photographers || []); setSoloQuesti(d.restricted); })
      .catch(() => { if (!annullato) setFotografi([]); });
    return () => { annullato = true; };
  }, [inModifica]);

  function apriNuovo() {
    setModulo(VUOTO);
    setErroreModulo("");
    setPannello("nuovo");
  }

  function apriModifica(a: RigaAlbum) {
    setModulo(daAlbum(a));
    setErroreModulo("");
    setPannello(a);
  }

  /** Scegliere «dei partecipanti» spegne il riconoscimento: non è una
      preferenza, è un vincolo dell'api, e lo si vede subito invece di
      scoprirlo con un 400 al salvataggio. */
  function cambiaGenere(kind: GenereAlbum) {
    setModulo((m) => ({ ...m, kind, recognition: kind === "crowd" ? false : m.recognition }));
  }

  const bloccatoRiconoscimento = Boolean(inModifica?.firstUploadAt) || modulo.kind === "crowd";
  const perCheBloccato = modulo.kind === "crowd"
    ? "Un album dei partecipanti non usa il riconoscimento: le foto le carica la folla e nessuno ha dato un consenso biometrico per quelle."
    : inModifica?.firstUploadAt
      ? `Non si cambia più: la prima foto è arrivata il ${quando(inModifica.firstUploadAt)}. I vettori sono isolati per album, e accenderlo adesso lascerebbe fuori tutto quello che è già dentro.`
      : "";

  async function salva() {
    if (!eventoId || salvando) return;
    setSalvando(true);
    setErroreModulo("");
    const comune = {
      name: modulo.name.trim(),
      moderation: modulo.moderation,
      visibility: modulo.visibility,
      maxPhotosPerUser: modulo.maxPhotosPerUser.trim() === "" ? null : Number(modulo.maxPhotosPerUser),
      retentionDays: modulo.retentionDays.trim() === "" ? null : Number(modulo.retentionDays),
      uploadsOpen: modulo.uploadsOpen,
    };
    try {
      if (inModifica) {
        // `recognition` si manda solo se si può ancora cambiare: l'api rifiuta
        // il campo dopo la prima foto, e mandarlo uguale a se stesso sarebbe
        // comunque un 400.
        const corpo = inModifica.firstUploadAt ? comune : { ...comune, recognition: modulo.recognition };
        await correggi(`/admin/albums/${inModifica.id}`, corpo);
        avvisa(`Album «${comune.name}» salvato.`, "success");
      } else {
        await invia(`/admin/events/${eventoId}/albums`, {
          ...comune,
          slug: modulo.slug.trim(),
          kind: modulo.kind,
          recognition: modulo.kind === "crowd" ? false : modulo.recognition,
        });
        avvisa(`Album «${comune.name}» creato.`, "success");
      }
      setPannello(null);
      carica();
    } catch (e: unknown) {
      if (guardia(e)) return;
      setErroreModulo(
        stato(e) === 409
          ? "C'è già un album con questo identificativo in questo evento: cambia l'identificativo."
          : messaggio(e, "Salvataggio non riuscito."),
      );
    } finally {
      setSalvando(false);
    }
  }

  /** L'interruttore dei caricamenti agisce subito, dalla riga della tabella:
      il giorno dell'evento non si apre un pannello per chiudere i
      caricamenti. */
  async function cambiaCaricamenti(a: RigaAlbum, aperti: boolean) {
    setAlbum((righe) => (righe || []).map((x) => (x.id === a.id ? { ...x, uploadsOpen: aperti } : x)));
    try {
      await correggi(`/admin/albums/${a.id}`, { uploadsOpen: aperti });
      avvisa(
        aperti ? `Caricamenti aperti su «${a.name}».` : `Caricamenti chiusi su «${a.name}».`,
        "success",
      );
    } catch (e) {
      setAlbum((righe) => (righe || []).map((x) => (x.id === a.id ? { ...x, uploadsOpen: !aperti } : x)));
      if (!guardia(e)) avvisa(messaggio(e, "Non riusciamo a cambiare i caricamenti."), "error");
    }
  }

  async function aggiungiFotografo() {
    if (!inModifica || !emailValida(nuovoFotografo) || aggiungendo) return;
    setAggiungendo(true);
    try {
      await invia(`/admin/albums/${inModifica.id}/photographers`, { email: nuovoFotografo.trim().toLowerCase() });
      const d = await leggi<{ photographers: FotografoAlbum[]; restricted: boolean }>(`/admin/albums/${inModifica.id}/photographers`);
      setFotografi(d.photographers || []);
      setSoloQuesti(d.restricted);
      setNuovoFotografo("");
      avvisa("Fotografo autorizzato su questo album.", "success");
    } catch (e) {
      if (!guardia(e)) {
        avvisa(
          stato(e) === 404
            ? "Quell'indirizzo non è un fotografo di questo evento: invitalo prima da «Eventi»."
            : messaggio(e, "Autorizzazione non riuscita."),
          "error",
        );
      }
    } finally { setAggiungendo(false); }
  }

  async function togliFotografo(f: FotografoAlbum) {
    if (!inModifica) return;
    try {
      await cancella(`/admin/albums/${inModifica.id}/photographers/${f.userId}`);
      const d = await leggi<{ photographers: FotografoAlbum[]; restricted: boolean }>(`/admin/albums/${inModifica.id}/photographers`);
      setFotografi(d.photographers || []);
      setSoloQuesti(d.restricted);
      avvisa(`${f.email} non carica più su questo album.`, "success");
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Rimozione non riuscita."), "error"); }
  }

  if (!evento) return (<><Testa titolo="Album" /><ServeUnEvento /></>);

  return (
    <>
      <Testa
        titolo="Album"
        dek="Un album è dove arrivano le foto: decide chi carica, chi guarda, se si riconoscono i volti e quanto si conserva."
        azioni={album && album.length === 0 ? undefined : <Primario onClick={apriNuovo}>Crea un album</Primario>}
      />

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {album && album.length === 0 ? (
        <Vuoto titolo="Nessun album: le foto non hanno dove arrivare" azione={<Primario onClick={apriNuovo}>Crea un album</Primario>}>
          Ogni foto appartiene a un album. Finché non ce n'è uno, i fotografi non possono caricare e
          i partecipanti non trovano niente.
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th>Album</th><th>Genere</th><th>Riconoscimento</th><th>Moderazione</th>
                <th>Chi guarda</th><th>Caricamenti</th><th className="tbl__azioni"><span className="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              {!album && <RigheFinte righe={3} colonne={7} />}
              {album?.map((a) => (
                <tr key={a.id} aria-selected={inModifica?.id === a.id ? true : undefined}>
                  <td data-et="Album">
                    <button className="btn btn--link" type="button" onClick={() => apriModifica(a)}>{a.name}</button>
                    <span className="cell-sub mono">{a.slug}</span>
                  </td>
                  <td data-et="Genere">{GENERE[a.kind]}</td>
                  <td data-et="Riconoscimento">
                    <Esito forma={a.recognition ? "chiarita" : "non-pertinente"}>
                      {a.recognition ? "Acceso" : "Spento"}
                    </Esito>
                  </td>
                  <td data-et="Moderazione">{MODERAZIONE[a.moderation]}</td>
                  <td data-et="Chi guarda">{VISIBILITA[a.visibility]}</td>
                  <td data-et="Caricamenti">
                    <span className="switch-row">
                      <span className="switch">
                        <input
                          type="checkbox"
                          checked={a.uploadsOpen}
                          onChange={(e) => void cambiaCaricamenti(a, e.target.checked)}
                          aria-label={`Caricamenti aperti su ${a.name}`}
                        />
                        <span className="switch__track" />
                      </span>
                      {a.uploadsOpen ? "Aperti" : "Chiusi"}
                    </span>
                  </td>
                  <td className="tbl__azioni" data-et="Azioni">
                    <button className="btn btn--sm" type="button" onClick={() => apriModifica(a)}>Apri</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pannello
        aperto={pannello !== null}
        titolo={inModifica ? inModifica.name : "Crea un album"}
        dek={inModifica ? inModifica.slug : evento.name}
        onChiudi={() => setPannello(null)}
        primario={
          <PrimarioPannello
            onClick={() => void salva()}
            attesa={salvando}
            disabled={modulo.name.trim() === "" || (!inModifica && modulo.slug.trim() === "")}
            perche={modulo.name.trim() === "" ? "Serve un nome: è quello che leggono i partecipanti." : "Serve un identificativo: è quello che finisce nell'indirizzo."}
          >
            {inModifica ? "Salva l'album" : "Crea l'album"}
          </PrimarioPannello>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor="album-nome">Nome</label>
          <input
            id="album-nome"
            className="input"
            value={modulo.name}
            onChange={(e) => setModulo({ ...modulo, name: e.target.value })}
            placeholder="Serata di gala"
          />
          <span className="field__hint">È il nome che vedono i partecipanti.</span>
        </div>

        {!inModifica && (
          <div className="field">
            <label className="field__label" htmlFor="album-slug">Identificativo</label>
            <input
              id="album-slug"
              className="input mono"
              value={modulo.slug}
              onChange={(e) => setModulo({ ...modulo, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
              placeholder="serata-di-gala"
            />
            <span className="field__hint">Finisce nell'indirizzo dell'album e non si cambia più dopo la creazione.</span>
          </div>
        )}

        <div className="field">
          <span className="field__label" id="album-genere-et">Genere</span>
          {inModifica ? (
            <p>{GENERE[inModifica.kind]} <span className="motivo">— il genere si decide alla creazione.</span></p>
          ) : (
            <div className="segmented" role="group" aria-labelledby="album-genere-et">
              <button type="button" aria-pressed={modulo.kind === "official"} onClick={() => cambiaGenere("official")}>Ufficiale</button>
              <button type="button" aria-pressed={modulo.kind === "crowd"} onClick={() => cambiaGenere("crowd")}>Dei partecipanti</button>
            </div>
          )}
          <span className="field__hint">
            Ufficiale: caricano i fotografi. Dei partecipanti: carica la folla dal telefono.
          </span>
        </div>

        <div className="field">
          <span className="field__label">Riconoscimento dei volti</span>
          <span className="switch-row">
            <span className="switch">
              <input
                type="checkbox"
                checked={modulo.recognition}
                disabled={bloccatoRiconoscimento}
                onChange={(e) => setModulo({ ...modulo, recognition: e.target.checked })}
                aria-label="Riconoscimento dei volti su questo album"
                aria-describedby={bloccatoRiconoscimento ? "album-riconoscimento-perche" : undefined}
              />
              <span className="switch__track" />
            </span>
            {modulo.recognition ? "Acceso" : "Spento"}
          </span>
          {bloccatoRiconoscimento && (
            <span className="motivo" id="album-riconoscimento-perche">{perCheBloccato}</span>
          )}
        </div>

        <hr />

        <div className="field">
          <span className="field__label" id="album-moderazione-et">Moderazione</span>
          <div className="segmented" role="group" aria-labelledby="album-moderazione-et">
            {(Object.keys(MODERAZIONE) as ModerazioneAlbum[]).map((m) => (
              <button key={m} type="button" aria-pressed={modulo.moderation === m} onClick={() => setModulo({ ...modulo, moderation: m })}>
                {m === "pre" ? "Prima" : m === "post" ? "Dopo" : "Nessuna"}
              </button>
            ))}
          </div>
          <span className="field__hint">{MODERAZIONE[modulo.moderation]}. «Dopo» è il modo normale: la foto si vede subito e finisce in coda solo se qualcuno la segnala.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="album-visibilita">Chi guarda</label>
          <select
            id="album-visibilita"
            className="select"
            value={modulo.visibility}
            onChange={(e) => setModulo({ ...modulo, visibility: e.target.value as VisibilitaAlbum })}
          >
            {(Object.keys(VISIBILITA) as VisibilitaAlbum[]).map((v) => (
              <option key={v} value={v}>{VISIBILITA[v]}</option>
            ))}
          </select>
        </div>

        <div className="grid-2">
          <div className="field">
            <label className="field__label" htmlFor="album-cap">
              Foto per persona <span className="opt">facoltativo</span>
            </label>
            <input
              id="album-cap"
              className="input"
              type="number"
              min={1}
              value={modulo.maxPhotosPerUser}
              onChange={(e) => setModulo({ ...modulo, maxPhotosPerUser: e.target.value })}
              placeholder="senza limite"
            />
            <span className="field__hint">Vale per gli album dei partecipanti.</span>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="album-retention">
              Giorni di conservazione <span className="opt">facoltativo</span>
            </label>
            <input
              id="album-retention"
              className="input"
              type="number"
              min={1}
              value={modulo.retentionDays}
              onChange={(e) => setModulo({ ...modulo, retentionDays: e.target.value })}
              placeholder={`come l'evento (${numero(evento.retentionDays)})`}
            />
            <span className="field__hint">Vuoto: vale quella dell'evento.</span>
          </div>
        </div>

        <div className="field">
          <span className="field__label">Caricamenti</span>
          <span className="switch-row">
            <span className="switch">
              <input
                type="checkbox"
                checked={modulo.uploadsOpen}
                onChange={(e) => setModulo({ ...modulo, uploadsOpen: e.target.checked })}
                aria-label="Caricamenti aperti"
              />
              <span className="switch__track" />
            </span>
            {modulo.uploadsOpen ? "Aperti" : "Chiusi"}
          </span>
          <span className="field__hint">Da chiusi ogni caricamento su questo album risponde «chiuso», senza riavviare niente.</span>
        </div>

        {inModifica && (
          <>
            <hr />
            <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-semibold)", marginBottom: "var(--space-1)" }}>
              Chi può caricare
            </h3>
            <p className="motivo" style={{ marginBottom: "var(--space-3)" }}>
              {soloQuesti
                ? "Solo i fotografi elencati qui caricano su questo album."
                : "Nessun elenco: caricano tutti i fotografi dell'evento. Il primo nome che aggiungi qui restringe l'album a quell'elenco."}
            </p>
            {fotografi === null ? (
              <span className="skel" style={{ display: "block", width: "70%" }} />
            ) : fotografi.length === 0 ? (
              <p className="motivo">Nessun fotografo elencato.</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>Fotografo</th><th>Dal</th><th className="tbl__azioni"><span className="sr-only">Azioni</span></th></tr></thead>
                <tbody>
                  {fotografi.map((f) => (
                    <tr key={f.userId}>
                      <td>{f.email}</td>
                      <td>{quando(f.createdAt)}</td>
                      <td className="tbl__azioni">
                        <button className="btn btn--sm" type="button" onClick={() => void togliFotografo(f)}>Togli</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="field" style={{ marginTop: "var(--space-3)" }}>
              <label className="field__label" htmlFor="album-fotografo">Autorizza un fotografo</label>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <input
                  id="album-fotografo"
                  className="input"
                  type="email"
                  value={nuovoFotografo}
                  onChange={(e) => setNuovoFotografo(e.target.value)}
                  placeholder="nome@studio.it"
                />
                <button
                  className="btn"
                  type="button"
                  onClick={() => void aggiungiFotografo()}
                  disabled={!emailValida(nuovoFotografo) || aggiungendo}
                  title={emailValida(nuovoFotografo) ? undefined : "Scrivi l'indirizzo del fotografo, già invitato all'evento"}
                >
                  Autorizza
                </button>
              </div>
            </div>
          </>
        )}

        {erroreModulo && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Callout genere="errore" ruolo="alert">{erroreModulo}</Callout>
          </div>
        )}
      </Pannello>
    </>
  );
}
