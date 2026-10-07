"use client";

import { useState } from "react";
import type { AdminEvent, EventAccess, EventInfo, ParticipantsImportResponse } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded } from "@/components/admin/shared";

const IMPORT_MAX = 5000;

/** The v4 management panels, now bound to the selected event: access, invites, import, deletions. */
export function ManageSection({ event, onChanged }: { event: AdminEvent | null; onChanged: () => void }) {
  return (
    <>
      <EventAccessPanel event={event} onChanged={onChanged} />
      <InvitePanel event={event} />
      <ParticipantsImport event={event} />
      <DeletePanel
        title="Elimina una foto"
        label="Identificativo della foto"
        path={(id) => `/v1/admin/photos/${id}`}
        done="Foto eliminata."
        onDone={onChanged}
      />
      <DeletePanel
        title="Elimina un partecipante"
        label="Identificativo del partecipante"
        path={(id) => `/v1/admin/participants/${id}`}
        done="Partecipante eliminato."
        onDone={onChanged}
      />
    </>
  );
}

function EventAccessPanel({ event, onChanged }: { event: AdminEvent | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<string | null>(null);

  async function setAccess(access: EventAccess) {
    if (!event || event.access === access) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      await api<EventInfo>(`/v1/admin/events/${event.id}`, {
        method: "PATCH",
        body: JSON.stringify({ access }),
      });
      setState(access === "list" ? "Accesso limitato alla lista." : "Accesso aperto a tutti.");
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Modifica non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Accesso all&apos;evento</h2>
      <EventNeeded event={event} />
      {event ? (
        <div className="access">
          <p className="note">
            {event.name} · conservazione {event.retentionDays} giorni
          </p>
          <div className="segmented" role="radiogroup" aria-label="Accesso">
            <button type="button" role="radio" aria-checked={event.access === "open"} disabled={pending} onClick={() => void setAccess("open")}>
              Aperto
            </button>
            <button type="button" role="radio" aria-checked={event.access === "list"} disabled={pending} onClick={() => void setAccess("list")}>
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

function InvitePanel({ event }: { event: AdminEvent | null }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
      await api("/v1/admin/photographers/invite", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), eventId: event.id }),
      });
      setState("Invito inviato.");
      setEmail("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Invito non riuscito.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Invita un fotografo</h2>
      <p className="note">Via email. Per un link immediato usa la sezione Link di accesso.</p>
      <EventNeeded event={event} />
      <form onSubmit={(e) => void invite(e)}>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {state ? <p role="status">{state}</p> : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending || !event}>
            {pending ? "Invio…" : "Invia l'invito"}
          </button>
        </div>
      </form>
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

function ParticipantsImport({ event }: { event: AdminEvent | null }) {
  const [raw, setRaw] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  const emails = parseEmails(raw);
  const tooMany = emails.length > IMPORT_MAX;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event || emails.length === 0 || tooMany) return;
    setPending(true);
    setError(null);
    setState(null);
    try {
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
      <EventNeeded event={event} />
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Email, una per riga
          <textarea rows={8} value={raw} spellCheck={false} autoComplete="off" onChange={(e) => setRaw(e.target.value)} />
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
          <button className="button primary" type="submit" disabled={pending || emails.length === 0 || tooMany || !event}>
            {pending ? "Importo…" : "Importa"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DeletePanel({
  title,
  label,
  path,
  done,
  onDone,
}: {
  title: string;
  label: string;
  path: (id: string) => string;
  done: string;
  onDone: () => void;
}) {
  const [id, setId] = useState("");
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function remove(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = id.trim();
    if (!value) {
      setError("Inserisci l'identificativo.");
      return;
    }
    setPending(true);
    setError(null);
    setState(null);
    try {
      await api(path(value), { method: "DELETE" });
      setState(done);
      setId("");
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Eliminazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>{title}</h2>
      <form onSubmit={(e) => void remove(e)}>
        <label>
          {label}
          <input type="text" value={id} spellCheck={false} autoComplete="off" onChange={(e) => setId(e.target.value)} />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {state ? <p role="status">{state}</p> : null}
        <div className="actions inline">
          <button className="button quiet" type="submit" disabled={pending}>
            {pending ? "Elimino…" : "Elimina"}
          </button>
        </div>
      </form>
    </section>
  );
}
