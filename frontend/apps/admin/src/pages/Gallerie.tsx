import { useCallback, useEffect, useState } from "react";
import { ServeUnEvento, Testa } from "../guscio";
import {
  Callout, Esito, Finestra, Pannello, Primario, PrimarioPannello, RigheFinte, Vuoto, usaAvvisi,
} from "../parti";
import { Ico } from "../icone";
import { cancella, invia, leggi, messaggio, stato } from "../lib/api";
import { usaEventi, usaGuardia } from "../lib/eventi";
import { emailValida, numero, quando } from "../lib/formato";
import type { GalleriaDiUno, RigaGalleria } from "../lib/tipi";

/**
 * Gallerie — la galleria personale di ogni partecipante: quante foto, quando
 * si è formata, perché no.
 *
 * Il motivo del mancato match è il dato che conta quando qualcuno al banco
 * dice «non trovo le mie foto»: `no_face`, `face_too_small`, `low_quality`
 * non sono errori del sistema, sono istruzioni per il partecipante, e qui
 * sono tradotti in quelle istruzioni.
 *
 * Cancellare una galleria non è reversibile e non è ovvio perché: insieme
 * alla galleria viene cancellato il SELFIE conservato, quindi «Rifai il
 * match» dopo non ha più niente con cui cercare. Lo dice la conferma.
 */

const PAGINA = 50;

const MOTIVO: Record<string, string> = {
  no_face: "Nel selfie non si vede un volto",
  face_too_small: "Il volto nel selfie è troppo piccolo",
  low_quality: "Selfie sfocato o troppo scuro",
  multiple_faces: "Nel selfie ci sono più persone",
  no_photos_yet: "Non c'erano ancora foto: il match si rifà da sé",
  liveness: "Il controllo di autenticità del selfie non è passato",
};

export default function Gallerie() {
  const { evento } = usaEventi();
  const guardia = usaGuardia();
  const avvisa = usaAvvisi();

  const [righe, setRighe] = useState<RigaGalleria[] | null>(null);
  const [cursore, setCursore] = useState<string | null>(null);
  const [errore, setErrore] = useState("");
  const [cerca, setCerca] = useState("");

  const [aperta, setAperta] = useState<GalleriaDiUno | null>(null);
  const [apertoPannello, setApertoPannello] = useState(false);
  const [caricoUna, setCaricoUna] = useState(false);
  const [erroreUna, setErroreUna] = useState("");
  const [rifacendo, setRifacendo] = useState(false);

  const [daCancellare, setDaCancellare] = useState<GalleriaDiUno | null>(null);
  const [presaDatto, setPresaDatto] = useState(false);
  const [cancellando, setCancellando] = useState(false);

  const eventoId = evento?.id ?? "";

  const caricaElenco = useCallback(() => {
    if (!eventoId) return;
    setRighe(null); setErrore(""); setCursore(null);
    leggi<{ galleries: RigaGalleria[]; nextCursor: string | null }>(`/admin/galleries?eventId=${eventoId}&limit=${PAGINA}`)
      .then((d) => { setRighe(d.galleries || []); setCursore(d.nextCursor || null); })
      .catch((e: unknown) => {
        if (guardia(e)) return;
        setErrore(messaggio(e, "Non riusciamo a leggere le gallerie."));
        setRighe([]);
      });
  }, [eventoId, guardia]);

  useEffect(() => { caricaElenco(); }, [caricaElenco]);

  async function altre() {
    if (!cursore) return;
    try {
      const d = await leggi<{ galleries: RigaGalleria[]; nextCursor: string | null }>(
        `/admin/galleries?eventId=${eventoId}&limit=${PAGINA}&cursor=${encodeURIComponent(cursore)}`,
      );
      setRighe((r) => [...(r || []), ...(d.galleries || [])]);
      setCursore(d.nextCursor || null);
    } catch (e) { guardia(e); }
  }

  async function apri(email: string) {
    if (!eventoId || !emailValida(email)) return;
    setApertoPannello(true);
    setAperta(null);
    setErroreUna("");
    setCaricoUna(true);
    try {
      setAperta(await leggi<GalleriaDiUno>(`/admin/galleries?eventId=${eventoId}&email=${encodeURIComponent(email.trim().toLowerCase())}`));
    } catch (e: unknown) {
      if (guardia(e)) return;
      setErroreUna(
        stato(e) === 404
          ? "Nessuna galleria per questo indirizzo in questo evento. Può essere che la persona non si sia ancora iscritta, o che non abbia fatto il selfie."
          : messaggio(e, "Ricerca non riuscita."),
      );
    } finally { setCaricoUna(false); }
  }

  async function rifaiMatch() {
    if (!aperta || !eventoId || rifacendo) return;
    setRifacendo(true);
    try {
      await invia(`/admin/galleries/${aperta.user.id}/${eventoId}/rematch`);
      avvisa("Match rimesso in coda.", "success", "La galleria si aggiorna da sé quando il lavoro finisce.");
    } catch (e: unknown) {
      if (guardia(e)) return;
      avvisa(
        stato(e) === 409
          ? "Non si può rifare: serve un consenso attivo e il selfie conservato. Se la persona ha revocato il consenso, o se la conservazione dei selfie è spenta, deve rifare il selfie."
          : messaggio(e, "Non riusciamo a rimettere il match in coda."),
        "error",
      );
    } finally { setRifacendo(false); }
  }

  async function cancellaDavvero() {
    if (!daCancellare || !presaDatto || cancellando || !eventoId) return;
    setCancellando(true);
    try {
      await cancella(`/admin/galleries/${daCancellare.user.id}/${eventoId}`);
      avvisa("Galleria cancellata.", "warning", "Con lei il selfie conservato.");
      setDaCancellare(null);
      setApertoPannello(false);
      setAperta(null);
      caricaElenco();
    } catch (e) { if (!guardia(e)) avvisa(messaggio(e, "Cancellazione non riuscita."), "error"); }
    finally { setCancellando(false); }
  }

  if (!evento) return (<><Testa titolo="Gallerie" /><ServeUnEvento /></>);

  return (
    <>
      <Testa
        titolo="Gallerie"
        dek="Una galleria per partecipante: le foto in cui il riconoscimento l'ha trovato. Se è vuota, il motivo dice cosa fare."
        azioni={
          <form
            className="strumenti__fine"
            onSubmit={(e) => { e.preventDefault(); void apri(cerca); }}
          >
            <div className="input-group">
              {Ico.cerca}
              <input
                className="input"
                style={{ minWidth: 240 }}
                type="email"
                value={cerca}
                onChange={(e) => setCerca(e.target.value)}
                placeholder="partecipante@email.it"
                aria-label="Apri la galleria di un indirizzo"
              />
            </div>
            <Primario
              type="submit"
              disabled={!emailValida(cerca)}
              perche="Scrivi l'indirizzo del partecipante."
            >
              Apri la galleria
            </Primario>
          </form>
        }
      />

      {errore && <Callout genere="errore" ruolo="alert">{errore}</Callout>}

      {righe && righe.length === 0 ? (
        <Vuoto titolo="Nessuna galleria ancora">
          Una galleria nasce quando un partecipante fa il selfie e il riconoscimento gira. Finché
          nessuno ha fatto il selfie questa lista resta vuota, anche se le foto ci sono.
        </Vuoto>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th>Partecipante</th><th className="num">Foto</th><th>Match</th><th>Esito</th>
                <th className="tbl__azioni"><span className="sr-only">Azioni</span></th>
              </tr>
            </thead>
            <tbody>
              {!righe && <RigheFinte righe={6} colonne={5} />}
              {righe?.map((r) => (
                <tr key={r.userId} aria-selected={aperta?.user.id === r.userId && apertoPannello ? true : undefined}>
                  <td data-et="Partecipante">
                    <button className="btn btn--link" type="button" onClick={() => { setCerca(r.email); void apri(r.email); }}>
                      {r.email}
                    </button>
                  </td>
                  <td className="num" data-et="Foto">{numero(r.total)}</td>
                  <td data-et="Match">{quando(r.matchedAt)}</td>
                  <td data-et="Esito">
                    {r.matchedAt && !r.reason
                      ? <Esito forma="chiarita">Fatto</Esito>
                      : r.reason
                        ? <Esito forma="da-esaminare">{MOTIVO[r.reason] ?? r.reason}</Esito>
                        : <Esito forma="attesa">In attesa del match</Esito>}
                  </td>
                  <td className="tbl__azioni" data-et="Azioni">
                    <button className="btn btn--sm" type="button" onClick={() => { setCerca(r.email); void apri(r.email); }}>Apri</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursore && (
            <div className="tbl__fine">
              <button className="btn" type="button" onClick={() => void altre()}>Carica altre {numero(PAGINA)}</button>
            </div>
          )}
        </div>
      )}

      <Pannello
        aperto={apertoPannello}
        titolo={aperta?.user.email ?? (caricoUna ? "Carico…" : "Galleria")}
        dek={aperta ? `${numero(aperta.gallery?.total ?? aperta.items.length)} foto` : undefined}
        onChiudi={() => setApertoPannello(false)}
        primario={
          aperta ? (
            <PrimarioPannello onClick={() => void rifaiMatch()} attesa={rifacendo}>
              Rifai il match
            </PrimarioPannello>
          ) : undefined
        }
        secondarie={
          aperta ? (
            <button
              className="btn btn--danger"
              type="button"
              onClick={() => { setPresaDatto(false); setDaCancellare(aperta); }}
              style={{ marginLeft: "auto" }}
            >
              Cancella la galleria…
            </button>
          ) : undefined
        }
      >
        {erroreUna && <Callout genere="attention" ruolo="status">{erroreUna}</Callout>}
        {caricoUna && !aperta && <span className="skel" style={{ display: "block", width: "70%" }} />}
        {aperta && (
          <>
            <dl className="dati">
              <dt>Persona</dt><dd>{aperta.user.email}</dd>
              <dt>Identificativo</dt><dd className="mono--id">{aperta.user.id}</dd>
              <dt>Match</dt><dd>{quando(aperta.gallery?.matchedAt ?? null)}</dd>
              <dt>Foto</dt><dd>{numero(aperta.gallery?.total ?? aperta.items.length)}</dd>
              <dt>Esito</dt>
              <dd>
                {aperta.gallery?.reason
                  ? (MOTIVO[aperta.gallery.reason] ?? aperta.gallery.reason)
                  : aperta.gallery?.matchedAt ? "Fatto" : "Non ancora"}
              </dd>
              <dt>Volti di riferimento</dt>
              <dd>{aperta.gallery ? numero(aperta.gallery.anchorFaceIds.length) : "—"}</dd>
            </dl>

            <hr />

            {aperta.items.length === 0 ? (
              <p className="motivo">
                La galleria non contiene foto. Se l'esito è «Fatto», il riconoscimento ha girato e
                non ha trovato questa persona in nessuna foto: non è un errore da correggere qui.
              </p>
            ) : (
              <div className="provini">
                {aperta.items.slice(0, 36).map((it) => (
                  <a key={it.photoId} href={it.webUrl} target="_blank" rel="noreferrer" title={`Punteggio ${it.score.toFixed(2)} · ${it.source === "match" ? "riconoscimento" : "aggiunta a mano"}`}>
                    <img src={it.thumbUrl} alt={it.photo.filename ?? ""} loading="lazy" decoding="async" />
                    {it.feedback === "not_me" && <span className="chip chip--attention">non sono io</span>}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </Pannello>

      <Finestra
        aperta={daCancellare !== null}
        titolo="Cancellare questa galleria?"
        onChiudi={() => { setDaCancellare(null); setPresaDatto(false); }}
        azione={
          <button
            className="btn btn--primary btn--danger"
            type="button"
            disabled={!presaDatto || cancellando}
            data-loading={cancellando || undefined}
            title={presaDatto ? undefined : "Spunta prima la presa d'atto"}
            onClick={() => void cancellaDavvero()}
          >
            {cancellando ? <span className="btn-spin" aria-hidden="true" /> : Ico.cestino}
            Cancella la galleria
          </button>
        }
      >
        <p>
          Le foto dell'evento <strong>non</strong> vengono toccate: si cancella il collegamento tra
          questa persona e le sue foto. Insieme alla galleria viene però cancellato anche il{" "}
          <strong>selfie conservato</strong>, quindi «Rifai il match» non avrà più niente con cui
          cercare: per riavere le sue foto la persona dovrà rifare il selfie.
        </p>
        <ul className="finestra__cosa">
          <li><span>Persona</span><span>{daCancellare?.user.email}</span></li>
          <li><span>Foto nella galleria</span><span className="num">{numero(daCancellare?.gallery?.total ?? daCancellare?.items.length)}</span></li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={presaDatto} onChange={(e) => setPresaDatto(e.target.checked)} />
          <span>Ho capito: il selfie conservato viene cancellato e la persona dovrà rifarlo.</span>
        </label>
      </Finestra>
    </>
  );
}
