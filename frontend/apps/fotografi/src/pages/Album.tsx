import { useMemo, useState } from "react";
import {
  Shell, Pannello, Esito, Quota, Toast, useAvviso, nf, num,
  IconInfo, IconAlbum, type EsitoTipo,
} from "../ui";
import { useActiveEvent } from "../lib/event";

/*
 * Pagina con un buco nel contratto. Album e organizzazione non esistono ancora:
 *   tabelle: albums(id,event_id,name,slug,kind,starts_at,ends_at,…) + photo_albums
 *   endpoint: POST/GET/PATCH/DELETE /v1/photographer/albums[/:id] (G4),
 *             POST /v1/photographer/albums/:id/photos (G5),
 *             uploads/init albumId? (G6), POST /v1/photographer/albums/:id/release (G9).
 * I dati qui sotto sono di esempio, e la pagina lo dichiara in chiaro.
 *
 * Le regole che le danno questa forma:
 *
 * 1. Il dettaglio di una riga sta in un PANNELLO laterale, non in un dialogo e
 *    non in una pagina nuova per quattro campi. La lista dietro resta usabile,
 *    non c'è velo, Esc chiude e il fuoco torna al nome su cui si è premuto.
 * 2. Mentre il pannello è aperto, il primario della pagina perde l'inchiostro:
 *    non ci sono due neri in vista. Quando il pannello si chiude, torna.
 * 3. «Crea l'album» non può funzionare finché l'endpoint non c'è: è
 *    `aria-disabled`, non `disabled`, così resta raggiungibile da tastiera e
 *    può dire perché.
 * 4. Lo stato dell'album ha una forma e una parola. L'embargo non è un bordo
 *    ambra: è una riga che dice da quando le foto si vedono.
 * 5. «È fatto» dopo un gesto già compiuto è un toast a fondo inchiostro, non
 *    un callout permanente e non un toast verde.
 */

type Tipo = "giorno" | "sessione" | "palco" | "zona";
type Stato = "pubblicato" | "in-revisione" | "programmato";
type Album = {
  id: string; nome: string; tipo: Tipo; foto: number; giorno: string;
  stato: Stato; viaLibera?: string; aggiornato: string;
};

const SEED: Album[] = [
  { id: "a1", nome: "Giorno 1 · Palco Centrale", tipo: "palco", foto: 2480, giorno: "12/03/2026", stato: "pubblicato", aggiornato: "12/03/2026 18:40" },
  { id: "a2", nome: "Giorno 1 · Apertura e keynote", tipo: "sessione", foto: 1120, giorno: "12/03/2026", stato: "pubblicato", aggiornato: "12/03/2026 11:05" },
  { id: "a3", nome: "Giorno 1 · Area networking", tipo: "zona", foto: 860, giorno: "12/03/2026", stato: "pubblicato", aggiornato: "12/03/2026 19:20" },
  { id: "a4", nome: "Giorno 2 · Palco Centrale", tipo: "palco", foto: 3210, giorno: "13/03/2026", stato: "pubblicato", aggiornato: "13/03/2026 18:10" },
  { id: "a5", nome: "Giorno 2 · Sessioni parallele", tipo: "sessione", foto: 1940, giorno: "13/03/2026", stato: "in-revisione", aggiornato: "13/03/2026 17:55" },
  { id: "a6", nome: "Giorno 2 · Cena di gala", tipo: "sessione", foto: 1460, giorno: "13/03/2026", stato: "in-revisione", aggiornato: "13/03/2026 23:40" },
  { id: "a7", nome: "Giorno 3 · Palco Nord", tipo: "palco", foto: 2070, giorno: "14/03/2026", stato: "in-revisione", aggiornato: "14/03/2026 12:30" },
  { id: "a8", nome: "Giorno 3 · Premiazione", tipo: "sessione", foto: 980, giorno: "14/03/2026", stato: "programmato", viaLibera: "14/03/2026 18:00", aggiornato: "14/03/2026 17:10" },
];

const NOME_TIPO: Record<Tipo, string> = { giorno: "Giorno", sessione: "Sessione", palco: "Palco", zona: "Zona" };

const STATO: Record<Stato, { forma: EsitoTipo; parola: string }> = {
  pubblicato: { forma: "fatto", parola: "Pubblicato" },
  "in-revisione": { forma: "attesa", parola: "In revisione" },
  programmato: { forma: "corso", parola: "Programmato" },
};

const FILTRI: { key: "tutti" | Tipo; label: string }[] = [
  { key: "tutti", label: "Tutti" },
  { key: "giorno", label: "Giorno" },
  { key: "sessione", label: "Sessione" },
  { key: "palco", label: "Palco" },
  { key: "zona", label: "Zona" },
];

export default function Album() {
  const { event } = useActiveEvent();
  const [album, setAlbum] = useState<Album[]>(SEED);
  const [filtro, setFiltro] = useState<"tutti" | Tipo>("tutti");
  const [apertoId, setApertoId] = useState<string | null>(null);
  const { avviso, mostra } = useAvviso();

  const mostrati = useMemo(
    () => (filtro === "tutti" ? album : album.filter((a) => a.tipo === filtro)),
    [album, filtro],
  );
  const totali = useMemo(() => {
    const foto = album.reduce((s, a) => s + a.foto, 0);
    const pubblicati = album.filter((a) => a.stato === "pubblicato").length;
    return { foto, pubblicati };
  }, [album]);

  const aperto = album.find((a) => a.id === apertoId) ?? null;

  function pubblica(id: string) {
    const a = album.find((x) => x.id === id);
    setAlbum((as) => as.map((x) => (x.id === id ? { ...x, stato: "pubblicato", viaLibera: undefined } : x)));
    setApertoId(null);
    mostra({ variante: "success", testo: `«${a?.nome ?? "Album"}» è pubblicato: le foto sono cercabili.` });
  }

  return (
    <Shell
      titolo="Album"
      dove={`${nf(album.length)} album`}
      evento={event ? event.name : null}
      azioni={
        // Mentre il pannello è aperto questo pulsante non è più il nero della
        // pagina. aria-disabled, non disabled: così si raggiunge e si spiega.
        <button
          className={"btn" + (aperto ? "" : " btn--primary")}
          type="button"
          aria-disabled="true"
          title="Creare un album richiede l'endpoint POST /v1/photographer/albums, che non esiste ancora."
          onClick={(e) => e.preventDefault()}
        >
          Crea l'album
        </button>
      }
    >
      <div className="callout callout--info" role="note">
        <IconInfo />
        <span className="callout__text">
          <strong>Funzione in arrivo.</strong> Album, assegnazione delle foto ed embargo
          richiedono le tabelle <code>albums</code> e <code>photo_albums</code>
          {" "}(<code>photos.embargo_until</code>) e gli endpoint{" "}
          <code>GET/POST /v1/photographer/albums</code> e{" "}
          <code>POST /v1/photographer/albums/:id/release</code> (G4–G6, G9). Gli album elencati
          qui sotto sono di esempio: pubblicarli non cambia niente sul server.
        </span>
      </div>

      <div className="summary">
        <span><b className="dato">{nf(album.length)}</b> album</span>
        <span><b className="dato">{nf(totali.foto)}</b> foto organizzate</span>
        <span><b className="dato">{nf(totali.pubblicati)}</b> pubblicati</span>
        <Quota n={totali.pubblicati} su={album.length} suffisso="degli album pubblicato" />
      </div>

      {/* Le schede cambiano quale elenco si guarda; il conteggio è un chip. */}
      <div className="tabs" role="tablist" aria-label="Filtra gli album per tipo">
        {FILTRI.map((f) => {
          const n = f.key === "tutti" ? album.length : album.filter((a) => a.tipo === f.key).length;
          return (
            <button
              key={f.key} className="tab" type="button" role="tab"
              aria-selected={filtro === f.key} onClick={() => setFiltro(f.key)}
            >
              {f.label} <span className="chip"><b>{nf(n)}</b></span>
            </button>
          );
        })}
      </div>

      {mostrati.length === 0 ? (
        <div className="empty">
          <IconAlbum />
          <h2>Nessun album di questo tipo</h2>
          <p>Cambia filtro per vedere gli altri album dell'evento.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl--schede">
            <thead>
              <tr>
                <th scope="col">Album</th>
                <th scope="col">Tipo</th>
                <th scope="col" className="num">Foto</th>
                <th scope="col">Giorno</th>
                <th scope="col">Stato</th>
              </tr>
            </thead>
            <tbody>
              {mostrati.map((a) => (
                <tr key={a.id} aria-selected={a.id === apertoId || undefined}>
                  <td>
                    {/* Il nome apre il pannello: è un'azione che è una frase,
                        ed è il controllo a cui il fuoco deve tornare. */}
                    <button className="btn btn--link" type="button" onClick={() => setApertoId(a.id)}>
                      {a.nome}
                    </button>
                    {a.viaLibera && (
                      <span className="cell-sub">In embargo: le foto si vedono dal {a.viaLibera}.</span>
                    )}
                  </td>
                  <td data-etichetta="Tipo">{NOME_TIPO[a.tipo]}</td>
                  <td className="num" data-etichetta="Foto">{nf(a.foto)}</td>
                  <td data-etichetta="Giorno">{a.giorno}</td>
                  <td data-etichetta="Stato">
                    <Esito tipo={STATO[a.stato].forma}>{STATO[a.stato].parola}</Esito>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pannello
        aperto={aperto != null}
        titolo={aperto?.nome ?? "Album"}
        sotto={aperto ? `${NOME_TIPO[aperto.tipo]} · ${aperto.giorno}` : undefined}
        onChiudi={() => setApertoId(null)}
        piede={
          aperto && aperto.stato !== "pubblicato" ? (
            <>
              {/* Primario a sinistra, Annulla subito dopo. Pubblicare non è
                  irreversibile (si può tornare in revisione), quindi non è un
                  primario pericolo. */}
              <button className="btn btn--primary" type="button" onClick={() => pubblica(aperto.id)}>
                {aperto.stato === "programmato" ? "Pubblica adesso l'album" : "Pubblica l'album"}
              </button>
              <button className="btn btn--ghost" type="button" onClick={() => setApertoId(null)}>Annulla</button>
            </>
          ) : (
            <button className="btn" type="button" onClick={() => setApertoId(null)}>Chiudi il pannello</button>
          )
        }
      >
        {aperto && (
          <>
            {/* Dentro il pannello si separa con una linea, non con un altro
                riquadro: niente riquadro dentro un riquadro. */}
            <section className="panel__sez">
              <h3>Com'è fatto</h3>
              <dl className="dl">
                <dt>Foto</dt><dd>{nf(aperto.foto)}</dd>
                <dt>Tipo</dt><dd>{NOME_TIPO[aperto.tipo]}</dd>
                <dt>Giorno</dt><dd>{aperto.giorno}</dd>
                <dt>Ultima aggiunta</dt><dd>{aperto.aggiornato}</dd>
                <dt>Stato</dt><dd><Esito tipo={STATO[aperto.stato].forma}>{STATO[aperto.stato].parola}</Esito></dd>
                <dt>Via libera</dt><dd>{aperto.viaLibera ?? "—"}</dd>
              </dl>
            </section>

            <section className="panel__sez">
              <h3>Chi vedrà queste foto</h3>
              <p className="nota">
                {aperto.stato === "pubblicato"
                  ? "L'album è pubblicato: chi compare in una di queste foto la trova nella sua galleria."
                  : aperto.stato === "programmato"
                    ? `L'album è in embargo fino al ${aperto.viaLibera ?? "—"}. Fino a quel momento nessun partecipante vede queste foto, nemmeno chi compare dentro.`
                    : "L'album è in revisione: le foto sono caricate e indicizzate, ma nessuno le vede ancora."}
              </p>
            </section>

            <section className="panel__sez">
              <h3>Quanto manca</h3>
              <p className="nota">
                Le foto di questo album sono <b className="dato">{nf(aperto.foto)}</b> su{" "}
                <b className="dato">{nf(totali.foto)}</b> dell'evento.
              </p>
              <Quota n={aperto.foto} su={totali.foto} suffisso="delle foto dell'evento" />
              <p className="nota-min sp-sopra">
                Quante foto hanno già un volto riconosciuto non è un dato che l'API espone oggi:
                serve <code>GET /v1/photographer/stats?eventId=</code> (G3). Finché non c'è, qui
                sta <span className="dato">—</span> e non uno zero.
              </p>
              <dl className="dl sp-sopra">
                <dt>Volti riconosciuti</dt><dd>{num(null)}</dd>
                <dt>Foto scaricate</dt><dd>{num(null)}</dd>
              </dl>
            </section>
          </>
        )}
      </Pannello>

      <Toast avviso={avviso} />
    </Shell>
  );
}
