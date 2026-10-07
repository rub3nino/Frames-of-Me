"use client";

import { useState } from "react";
import type { AdminEvent, EventAccess } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { formatWhen } from "@/components/admin/shared";

export function EventsSection({
  events,
  selected,
  onSelect,
  onCreated,
  error,
}: {
  events: AdminEvent[] | null;
  selected: AdminEvent | null;
  onSelect: (event: AdminEvent) => void;
  onCreated: () => void;
  error: string | null;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [retention, setRetention] = useState("90");
  const [access, setAccess] = useState<EventAccess>("open");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setState(null);
    try {
      await api("/v1/admin/events", {
        method: "POST",
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          retentionDays: Number(retention) || 90,
          access,
        }),
      });
      setState(`Evento ${slug.trim()} creato.`);
      setSlug("");
      setName("");
      onCreated();
    } catch (cause) {
      setFormError(cause instanceof ApiError ? cause.message : "Creazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Eventi</h2>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {events === null && !error ? <p className="status">Caricamento</p> : null}
      {events && events.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Nome</th>
                <th>Accesso</th>
                <th>Foto</th>
                <th>Gallerie</th>
                <th>Partecipanti</th>
                <th>Fotografi</th>
                <th>Creato</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} data-selected={selected?.id === event.id ? "true" : "false"}>
                  <td>
                    <code>{event.slug}</code>
                  </td>
                  <td>{event.name}</td>
                  <td>{event.access === "list" ? "lista" : "aperto"}</td>
                  <td>{event.photos}</td>
                  <td>{event.galleries}</td>
                  <td>{event.participants}</td>
                  <td>{event.photographers}</td>
                  <td>{formatWhen(event.createdAt)}</td>
                  <td>
                    {selected?.id === event.id ? (
                      <span className="meta">selezionato</span>
                    ) : (
                      <button type="button" className="linkish" onClick={() => onSelect(event)}>
                        Usa
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {events && events.length === 0 ? <p className="note">Nessun evento.</p> : null}

      <h3>Nuovo evento</h3>
      <form onSubmit={(e) => void create(e)}>
        <label>
          Slug
          <input
            type="text"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            spellCheck={false}
            autoComplete="off"
            placeholder="gara-2026"
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label>
          Nome
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Conservazione (giorni)
          <input
            type="number"
            min={1}
            value={retention}
            inputMode="numeric"
            onChange={(e) => setRetention(e.target.value)}
          />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Accesso">
          <button type="button" role="radio" aria-checked={access === "open"} onClick={() => setAccess("open")}>
            Aperto
          </button>
          <button type="button" role="radio" aria-checked={access === "list"} onClick={() => setAccess("list")}>
            Solo lista
          </button>
        </div>
        {formError ? (
          <p className="alert" role="alert">
            {formError}
          </p>
        ) : null}
        {state ? <p role="status">{state}</p> : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending}>
            {pending ? "Creo…" : "Crea l'evento"}
          </button>
        </div>
      </form>
    </section>
  );
}
