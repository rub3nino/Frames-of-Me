"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AdminEvent,
  Album,
  AlbumKind,
  AlbumModeration,
  AlbumPhotographersResponse,
  AlbumResponse,
  AlbumVisibility,
  AlbumsResponse,
} from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen } from "@/components/admin/shared";
import {
  createBody,
  emptyDraft,
  KIND_LABEL,
  KIND_LOCKED_REASON,
  MODERATION_LABEL,
  patchBody,
  recognitionField,
  VISIBILITY_LABEL,
  withKind,
  type AlbumDraft,
} from "@/lib/album-rules";

/**
 * v6 D (agent D): albums — create, list, edit.
 *
 * The form's job is to make the two frozen rules visible before the api refuses them:
 *
 *  - decision 2: choosing «album di tutti» (`crowd`) disables and greys the recognition
 *    switch and says why;
 *  - decision 3: once the album has its first photo the switch is read-only and says why.
 *
 * Both are enforced by the database (`crowd_never_recognizes` and the `recognition`
 * trigger of migration 009). This screen never works around them: the rule logic is in
 * `lib/album-rules.ts`, proven by `lib/album-rules.test.ts`.
 */

const KINDS: AlbumKind[] = ["official", "crowd"];
const MODERATIONS: AlbumModeration[] = ["post", "pre", "off"];
const VISIBILITIES: AlbumVisibility[] = ["participants", "link", "staff"];

export function AlbumsSection({ event }: { event: AdminEvent | null }) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!event) {
      setAlbums(null);
      return;
    }
    let cancel = false;
    api<AlbumsResponse>(`/v1/admin/events/${event.id}/albums`)
      .then((data) => {
        if (cancel) return;
        setAlbums(data.albums);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setAlbums([]);
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere gli album.");
        }
      });
    return () => {
      cancel = true;
    };
  }, [event, attempt]);

  return (
    <>
      <section className="block">
        <h2>Album</h2>
        <p className="fine">
          Un evento ha più album. Per ciascuno decidi chi carica, se vale il riconoscimento dei
          volti, chi vede, come si modera e quanto si conserva.
        </p>
        <EventNeeded event={event} />
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {event ? (
          <div className="actions inline">
            <button className="button primary" type="button" onClick={() => setCreating((value) => !value)}>
              {creating ? "Annulla" : "Nuovo album"}
            </button>
          </div>
        ) : null}
        {event && creating ? (
          <AlbumForm
            event={event}
            album={null}
            onSaved={() => {
              setCreating(false);
              refresh();
            }}
          />
        ) : null}
      </section>

      {albums === null && event ? <p className="status">Caricamento</p> : null}
      {event && albums
        ? albums.map((album) => (
            <AlbumCard key={album.id} event={event} album={album} onSaved={refresh} />
          ))
        : null}
    </>
  );
}

function AlbumCard({ event, album, onSaved }: { event: AdminEvent; album: Album; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const field = recognitionField(album);

  return (
    <section className="block album-card">
      <div className="face-row">
        <h3>{album.name}</h3>
        <code>{album.slug}</code>
        <span className="badge">{KIND_LABEL[album.kind]}</span>
        <span className="badge" data-on={album.recognition ? "true" : "false"}>
          {album.recognition ? "Riconoscimento attivo" : "Senza riconoscimento"}
        </span>
        <span className="badge" data-on={album.uploadsOpen ? "true" : "false"}>
          {album.uploadsOpen ? "Caricamenti aperti" : "Caricamenti chiusi"}
        </span>
      </div>
      <p className="meta">
        Moderazione: {MODERATION_LABEL[album.moderation]} · Visibilità: {VISIBILITY_LABEL[album.visibility]} ·{" "}
        {album.maxPhotosPerUser === null ? "nessun limite per persona" : `max ${album.maxPhotosPerUser} foto a persona`} ·{" "}
        {album.retentionDays === null ? "conservazione dell'evento" : `conservazione ${album.retentionDays} giorni`}
      </p>
      <p className="meta">
        {album.firstUploadAt
          ? `Prima foto il ${formatWhen(album.firstUploadAt)}`
          : "Nessuna foto ancora caricata"}
      </p>
      {field.reason ? <p className="note locked">{field.reason}</p> : null}
      <div className="actions inline">
        <button className="button" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "Chiudi" : "Modifica"}
        </button>
      </div>
      {open ? (
        <>
          <AlbumForm event={event} album={album} onSaved={onSaved} />
          <PhotographersPanel album={album} />
        </>
      ) : null}
    </section>
  );
}

function AlbumForm({
  event,
  album,
  onSaved,
}: {
  event: AdminEvent;
  album: Album | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<AlbumDraft>(() =>
    album
      ? {
          slug: album.slug,
          name: album.name,
          kind: album.kind,
          recognition: album.recognition,
          moderation: album.moderation,
          visibility: album.visibility,
          maxPhotosPerUser: album.maxPhotosPerUser,
          uploadsOpen: album.uploadsOpen,
          retentionDays: album.retentionDays,
        }
      : emptyDraft(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  // The single source of truth for what the switch shows and may send. For a new album
  // there is no first upload yet, so only the crowd rule can lock it.
  const field = recognitionField({
    kind: draft.kind,
    recognition: draft.recognition,
    firstUploadAt: album?.firstUploadAt ?? null,
  });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setState(null);
    try {
      if (album) {
        const body = patchBody(draft, album);
        if (Object.keys(body).length === 0) {
          setState("Nulla da salvare.");
          return;
        }
        await api<AlbumResponse>(`/v1/admin/albums/${album.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setState("Album aggiornato.");
      } else {
        await api<AlbumResponse>(`/v1/admin/events/${event.id}/albums`, {
          method: "POST",
          body: JSON.stringify(createBody(draft)),
        });
        setState("Album creato.");
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Salvataggio non riuscito.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="form-grid">
        <label>
          Nome
          <input
            type="text"
            required
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        {album ? (
          <label>
            Slug
            <input type="text" value={draft.slug} readOnly disabled />
          </label>
        ) : (
          <label>
            Slug
            <input
              type="text"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={draft.slug}
              spellCheck={false}
              autoComplete="off"
              placeholder="album-di-tutti"
              onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
            />
          </label>
        )}
        <fieldset className="field-row">
          <legend>Tipo</legend>
          <div className="segmented" role="radiogroup" aria-label="Tipo di album">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                disabled={album !== null}
                onClick={() => setDraft(withKind(draft, kind))}
              >
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>
          <p className="fine">{album ? KIND_LOCKED_REASON : "Dopo la creazione il tipo non si cambia."}</p>
        </fieldset>
        <fieldset className="field-row recognition" data-locked={field.lock ?? "none"}>
          <legend>Riconoscimento dei volti</legend>
          <label className="switch">
            <input
              type="checkbox"
              checked={field.value}
              disabled={field.disabled}
              aria-describedby={field.reason ? "recognition-reason" : undefined}
              onChange={(e) => setDraft({ ...draft, recognition: e.target.checked })}
            />
            <span>{field.value ? "Attivo" : "Non attivo"}</span>
          </label>
          {field.reason ? (
            <p className="note locked" id="recognition-reason">
              {field.reason}
            </p>
          ) : (
            <p className="fine">
              Con il riconoscimento ogni foto viene indicizzata e finisce nella galleria personale di
              chi è stato riconosciuto. Dopo la prima foto questa scelta non si cambia più.
            </p>
          )}
        </fieldset>
        <label>
          Moderazione
          <select
            value={draft.moderation}
            onChange={(e) => setDraft({ ...draft, moderation: e.target.value as AlbumModeration })}
          >
            {MODERATIONS.map((value) => (
              <option key={value} value={value}>
                {MODERATION_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Visibilità
          <select
            value={draft.visibility}
            onChange={(e) => setDraft({ ...draft, visibility: e.target.value as AlbumVisibility })}
          >
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {VISIBILITY_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Massimo foto a persona
          <input
            type="number"
            min={1}
            step={1}
            value={draft.maxPhotosPerUser ?? ""}
            placeholder="senza limite"
            onChange={(e) =>
              setDraft({
                ...draft,
                maxPhotosPerUser: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Conservazione (giorni)
          <input
            type="number"
            min={1}
            step={1}
            value={draft.retentionDays ?? ""}
            placeholder="come l'evento"
            onChange={(e) =>
              setDraft({
                ...draft,
                retentionDays: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <fieldset className="field-row">
          <legend>Caricamenti</legend>
          <label className="switch">
            <input
              type="checkbox"
              checked={draft.uploadsOpen}
              onChange={(e) => setDraft({ ...draft, uploadsOpen: e.target.checked })}
            />
            <span>{draft.uploadsOpen ? "Aperti" : "Chiusi"}</span>
          </label>
          <p className="fine">
            Chiusi è l&apos;interruttore d&apos;emergenza: ogni caricamento viene rifiutato con un
            messaggio, le foto già caricate restano.
          </p>
        </fieldset>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {state ? <p role="status">{state}</p> : null}
      <div className="actions inline">
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Salvo…" : album ? "Salva l'album" : "Crea l'album"}
        </button>
      </div>
    </form>
  );
}

/**
 * Per-album photographer authorization (migration 017). An album with nobody on the list is
 * open to every photographer of the event — that is the v5 behaviour and the default.
 */
function PhotographersPanel({ album }: { album: Album }) {
  const [data, setData] = useState<AlbumPhotographersResponse | null>(null);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancel = false;
    api<AlbumPhotographersResponse>(`/v1/admin/albums/${album.id}/photographers`)
      .then((loaded) => {
        if (!cancel) setData(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(cause instanceof ApiError ? cause.message : "Lettura non riuscita.");
      });
    return () => {
      cancel = true;
    };
  }, [album.id, attempt]);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/albums/${album.id}/photographers`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      setEmail("");
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.status === 404
            ? "Nessun fotografo con questa email: invitalo prima dalla sezione Gestione."
            : cause.message
          : "Aggiunta non riuscita.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(userId: string) {
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/albums/${album.id}/photographers/${userId}`, { method: "DELETE" });
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Rimozione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="album-photographers">
      <h4>Chi può caricare in questo album</h4>
      <p className="fine">
        {data?.restricted
          ? "Solo i fotografi elencati qui. Togliendoli tutti l'album torna aperto a tutti i fotografi dell'evento."
          : "Nessuna restrizione: ogni fotografo dell'evento può caricare in questo album."}
      </p>
      {data && data.photographers.length > 0 ? (
        <ul className="list">
          {data.photographers.map((row) => (
            <li key={row.userId}>
              <span className="name">{row.email}</span>
              <button className="linkish" type="button" disabled={pending} onClick={() => void remove(row.userId)}>
                Togli
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={(e) => void add(e)}>
        <label>
          Email del fotografo
          <input type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions inline">
          <button className="button" type="submit" disabled={pending || email.trim() === ""}>
            Autorizza
          </button>
        </div>
      </form>
    </div>
  );
}
