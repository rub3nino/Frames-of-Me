"use client";

import { useEffect, useState } from "react";
import type { AdminMetrics, EventAccess, EventInfo, ParticipantsImportResponse } from "@/lib/types";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { eventSlug } from "@/lib/event";

const IMPORT_MAX = 5000;

export default function AdminPage() {
  return (
    <Shell signOut>
      <RequireRole role="admin" probe="/v1/admin/metrics">
        <AdminHome />
      </RequireRole>
    </Shell>
  );
}

function AdminHome() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState("");
  const [slug, setSlug] = useState(eventSlug);
  const [inviteState, setInviteState] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitePending, setInvitePending] = useState(false);
  const [photoId, setPhotoId] = useState("");
  const [deleteState, setDeleteState] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [participantId, setParticipantId] = useState("");
  const [participantState, setParticipantState] = useState<string | null>(null);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [participantPending, setParticipantPending] = useState(false);

  useEffect(() => {
    let cancel = false;
    api<AdminMetrics>("/v1/admin/metrics")
      .then((data) => {
        if (!cancel) {
          setMetrics(data);
          setMetricsError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setMetricsError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere i numeri.");
        }
      });
    return () => {
      cancel = true;
    };
  }, [attempt]);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvitePending(true);
    setInviteError(null);
    setInviteState(null);
    try {
      const event = await api<EventInfo>(`/v1/events/${slug.trim()}`);
      await api("/v1/admin/photographers/invite", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), eventId: event.id }),
      });
      setInviteState("Invito inviato.");
      setEmail("");
    } catch (cause) {
      setInviteError(cause instanceof ApiError ? cause.message : "Invito non riuscito.");
    } finally {
      setInvitePending(false);
    }
  }

  async function remove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = photoId.trim();
    if (!id) {
      setDeleteError("Inserisci l'identificativo.");
      return;
    }
    setDeletePending(true);
    setDeleteError(null);
    setDeleteState(null);
    try {
      await api(`/v1/admin/photos/${id}`, { method: "DELETE" });
      setDeleteState("Foto eliminata.");
      setPhotoId("");
      setAttempt((value) => value + 1);
    } catch (cause) {
      setDeleteError(cause instanceof ApiError ? cause.message : "Eliminazione non riuscita.");
    } finally {
      setDeletePending(false);
    }
  }

  async function removeParticipant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = participantId.trim();
    if (!id) {
      setParticipantError("Inserisci l'identificativo.");
      return;
    }
    setParticipantPending(true);
    setParticipantError(null);
    setParticipantState(null);
    try {
      await api(`/v1/admin/participants/${id}`, { method: "DELETE" });
      setParticipantState("Partecipante eliminato.");
      setParticipantId("");
      setAttempt((value) => value + 1);
    } catch (cause) {
      setParticipantError(cause instanceof ApiError ? cause.message : "Eliminazione non riuscita.");
    } finally {
      setParticipantPending(false);
    }
  }

  return (
    <div>
      <h1>Amministrazione</h1>
      {metricsError ? (
        <div>
          <p className="alert" role="alert">
            {metricsError}
          </p>
          <button className="button quiet" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Riprova
          </button>
        </div>
      ) : (
        <dl className="metrics">
          <div>
            <dt>Eventi</dt>
            <dd>{metrics ? metrics.events : "…"}</dd>
          </div>
          <div>
            <dt>Foto</dt>
            <dd>{metrics ? metrics.photos : "…"}</dd>
          </div>
          <div>
            <dt>Foto ricevute</dt>
            <dd>{metrics ? metrics.photosByStatus.uploaded : "…"}</dd>
          </div>
          <div>
            <dt>Foto in elaborazione</dt>
            <dd>{metrics ? metrics.photosByStatus.processing : "…"}</dd>
          </div>
          <div>
            <dt>Foto indicizzate</dt>
            <dd>{metrics ? metrics.photosByStatus.indexed : "…"}</dd>
          </div>
          <div>
            <dt>Foto con errori</dt>
            <dd>{metrics ? metrics.photosByStatus.error : "…"}</dd>
          </div>
          <div>
            <dt>Volti</dt>
            <dd>{metrics ? metrics.faces : "…"}</dd>
          </div>
          <div>
            <dt>Utenti</dt>
            <dd>{metrics ? metrics.users : "…"}</dd>
          </div>
          <div>
            <dt>Gallerie</dt>
            <dd>{metrics ? metrics.galleries : "…"}</dd>
          </div>
          <div>
            <dt>Lavori in coda</dt>
            <dd>{metrics ? metrics.jobsQueued : "…"}</dd>
          </div>
          <div>
            <dt>Lavori in corso</dt>
            <dd>{metrics ? metrics.jobsRunning : "…"}</dd>
          </div>
          <div>
            <dt>Lavori in errore</dt>
            <dd>{metrics ? metrics.jobsError : "…"}</dd>
          </div>
        </dl>
      )}

      <EventAccessPanel />

      <section className="block">
        <h2>Invita un fotografo</h2>
        <form onSubmit={(event) => void invite(event)}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Evento
            <input
              type="text"
              required
              value={slug}
              spellCheck={false}
              onChange={(event) => setSlug(event.target.value)}
            />
          </label>
          {inviteError ? (
            <p className="alert" role="alert">
              {inviteError}
            </p>
          ) : null}
          {inviteState ? <p role="status">{inviteState}</p> : null}
          <div className="actions inline">
            <button className="button primary" type="submit" disabled={invitePending}>
              {invitePending ? "Invio…" : "Invia l'invito"}
            </button>
          </div>
        </form>
      </section>

      <ParticipantsImport />

      <section className="block">
        <h2>Elimina una foto</h2>
        <form onSubmit={(event) => void remove(event)}>
          <label>
            Identificativo della foto
            <input
              type="text"
              value={photoId}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setPhotoId(event.target.value)}
            />
          </label>
          {deleteError ? (
            <p className="alert" role="alert">
              {deleteError}
            </p>
          ) : null}
          {deleteState ? <p role="status">{deleteState}</p> : null}
          <div className="actions inline">
            <button className="button quiet" type="submit" disabled={deletePending}>
              {deletePending ? "Elimino…" : "Elimina"}
            </button>
          </div>
        </form>
      </section>

      <section className="block">
        <h2>Elimina un partecipante</h2>
        <form onSubmit={(event) => void removeParticipant(event)}>
          <label>
            Identificativo del partecipante
            <input
              type="text"
              value={participantId}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setParticipantId(event.target.value)}
            />
          </label>
          {participantError ? (
            <p className="alert" role="alert">
              {participantError}
            </p>
          ) : null}
          {participantState ? <p role="status">{participantState}</p> : null}
          <div className="actions inline">
            <button className="button quiet" type="submit" disabled={participantPending}>
              {participantPending ? "Elimino…" : "Elimina"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Loads the event by slug and lets the admin switch between open access and the participant list. */
function EventAccessPanel() {
  const [slug, setSlug] = useState(eventSlug);
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<string | null>(null);

  async function load(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setState(null);
    try {
      setEvent(await api<EventInfo>(`/v1/events/${slug.trim()}`));
    } catch (cause) {
      setEvent(null);
      setError(cause instanceof ApiError ? cause.message : "Evento non trovato.");
    } finally {
      setPending(false);
    }
  }

  async function setAccess(access: EventAccess) {
    if (!event || event.access === access) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      const updated = await api<EventInfo>(`/v1/admin/events/${event.id}`, {
        method: "PATCH",
        body: JSON.stringify({ access }),
      });
      setEvent(updated);
      setState(access === "list" ? "Accesso limitato alla lista." : "Accesso aperto a tutti.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Modifica non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Accesso all&apos;evento</h2>
      <form onSubmit={(e) => void load(e)}>
        <label>
          Evento
          <input
            type="text"
            required
            value={slug}
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <div className="actions inline">
          <button className="button quiet" type="submit" disabled={pending}>
            {pending && !event ? "Carico…" : "Carica l'evento"}
          </button>
        </div>
      </form>
      {event ? (
        <div className="access">
          <p className="note">
            {event.name} · conservazione {event.retentionDays} giorni
          </p>
          <div className="segmented" role="radiogroup" aria-label="Accesso">
            <button
              type="button"
              role="radio"
              aria-checked={event.access === "open"}
              disabled={pending}
              onClick={() => void setAccess("open")}
            >
              Aperto
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={event.access === "list"}
              disabled={pending}
              onClick={() => void setAccess("list")}
            >
              Solo lista
            </button>
          </div>
          <p className="fine">
            {event.access === "list"
              ? "Possono cercarsi solo le email importate nella lista."
              : "Chiunque con un link di accesso può cercarsi."}
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {state ? <p role="status">{state}</p> : null}
    </section>
  );
}

function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  for (const line of raw.split(/[\n,;]+/)) {
    const value = line.trim().toLowerCase();
    if (value) seen.add(value);
  }
  return [...seen];
}

function ParticipantsImport() {
  const [slug, setSlug] = useState(eventSlug);
  const [raw, setRaw] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  const emails = parseEmails(raw);
  const tooMany = emails.length > IMPORT_MAX;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (emails.length === 0 || tooMany) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      const event = await api<EventInfo>(`/v1/events/${slug.trim()}`);
      const data = await api<ParticipantsImportResponse>("/v1/admin/participants/import", {
        method: "POST",
        body: JSON.stringify({ eventId: event.id, emails }),
      });
      setState(data.inserted === 1 ? "1 indirizzo aggiunto." : `${data.inserted} indirizzi aggiunti.`);
      setRaw("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Importazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Importa i partecipanti</h2>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Evento
          <input
            type="text"
            required
            value={slug}
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label>
          Email, una per riga
          <textarea
            rows={8}
            value={raw}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>
        <p className="meta">
          {emails.length === 1 ? "1 indirizzo" : `${emails.length} indirizzi`}
          {tooMany ? ` · massimo ${IMPORT_MAX}` : ""}
        </p>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {state ? <p role="status">{state}</p> : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending || emails.length === 0 || tooMany}>
            {pending ? "Importo…" : "Importa"}
          </button>
        </div>
      </form>
    </section>
  );
}
