"use client";

import { useState } from "react";
import type { AdminEvent, AdminGalleryByEmail, AdminParticipantLookup } from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen, reasonText } from "@/components/admin/shared";

/**
 * v6 D (agent D): participants — lookup by email, personal gallery, consent state, delete.
 *
 * The gallery is read through the v5 route `GET /v1/admin/galleries?email=` on purpose:
 * `galleries` / `gallery_items` are the personal match galleries and they must keep working
 * byte-for-byte (spec section G). This screen adds no second read of them.
 *
 * SEAM — consent revocation belongs to agent G. The control is rendered disabled with the
 * reason, because withdrawing a consent is not a UI toggle: it has to drop the selfie
 * vector, the anchors and the gallery items derived from them, and that decision is G's.
 * Deleting the participant (which does all of it) is the action offered here.
 */
export function ParticipantsSection({ event }: { event: AdminEvent | null }) {
  const [email, setEmail] = useState("");
  const [lookup, setLookup] = useState<AdminParticipantLookup | null>(null);
  const [gallery, setGallery] = useState<AdminGalleryByEmail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);

  async function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event) return;
    const value = email.trim().toLowerCase();
    if (!value) return;
    setPending(true);
    setError(null);
    setState(null);
    setLookup(null);
    setGallery(null);
    try {
      const found = await api<AdminParticipantLookup>(
        `/v1/admin/participants/lookup?eventId=${event.id}&email=${encodeURIComponent(value)}`,
      );
      setLookup(found);
      try {
        setGallery(
          await api<AdminGalleryByEmail>(
            `/v1/admin/galleries?eventId=${event.id}&email=${encodeURIComponent(value)}`,
          ),
        );
      } catch {
        // No gallery yet (404 before the first match): the lookup above is the answer.
        setGallery(null);
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.status === 404
            ? "Nessun partecipante con questa email."
            : cause.message
          : "Ricerca non riuscita.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!lookup) return;
    if (
      !window.confirm(
        `Eliminare ${lookup.user.email}? Vengono rimossi l'utente, la sua galleria personale, il selfie conservato e i suoi vettori. L'operazione non si annulla.`,
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/participants/${lookup.user.id}`, { method: "DELETE" });
      setState("Partecipante eliminato.");
      setLookup(null);
      setGallery(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Eliminazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="block">
      <h2>Partecipanti</h2>
      <EventNeeded event={event} />
      <form onSubmit={(e) => void search(e)}>
        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        {state ? <p role="status">{state}</p> : null}
        <div className="actions inline">
          <button className="button primary" type="submit" disabled={pending || !event}>
            {pending ? "Cerco…" : "Cerca"}
          </button>
        </div>
      </form>

      {lookup ? (
        <>
          <dl className="metrics">
            <div>
              <dt>Email</dt>
              <dd>{lookup.user.email}</dd>
            </div>
            <div>
              <dt>Iscritto il</dt>
              <dd>{formatWhen(lookup.user.createdAt)}</dd>
            </div>
            <div>
              <dt>Email verificata</dt>
              <dd>{lookup.emailVerifiedAt ? formatWhen(lookup.emailVerifiedAt) : "no (verifica differita)"}</dd>
            </div>
            <div>
              <dt>Consenso biometrico</dt>
              <dd data-ok={lookup.consent.active ? "true" : "false"}>
                {lookup.consent.active ? "attivo" : "assente"}
              </dd>
            </div>
            <div>
              <dt>Nell&apos;elenco partecipanti</dt>
              <dd>{lookup.onParticipantList ? "sì" : "no"}</dd>
            </div>
            <div>
              <dt>Galleria personale</dt>
              <dd>
                {lookup.gallery
                  ? `${gallery?.gallery?.total ?? 0} foto · match ${
                      lookup.gallery.matchedAt ? formatWhen(lookup.gallery.matchedAt) : "mai"
                    }`
                  : "nessuna"}
              </dd>
            </div>
            {lookup.gallery?.reason ? (
              <div>
                <dt>Ultimo esito del match</dt>
                <dd>{reasonText[lookup.gallery.reason] ?? lookup.gallery.reason}</dd>
              </div>
            ) : null}
            <div>
              <dt>Selfie conservato (vettore)</dt>
              <dd>{lookup.gallery?.hasQueryVector ? "sì" : "no"}</dd>
            </div>
          </dl>

          {gallery && gallery.items.length > 0 ? (
            <div className="admin-gallery">
              {gallery.items.slice(0, 24).map((item) => (
                <a key={item.photoId} className="thumb-link" href={item.webUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="thumb" src={item.thumbUrl} alt="" decoding="async" />
                </a>
              ))}
            </div>
          ) : null}

          <div className="block danger">
            <h3>Consenso e cancellazione</h3>
            <p className="fine">
              La revoca del consenso è dell&apos;area G (privacy): deve togliere il vettore del
              selfie, le ancore e le foto arrivate in galleria grazie a quelle ancore, non solo
              marcare una riga. Finché non c&apos;è, l&apos;unica azione completa è la
              cancellazione del partecipante.
            </p>
            <div className="actions inline">
              <button
                className="button"
                type="button"
                disabled
                title="Area G (privacy): revoca del consenso non ancora disponibile"
              >
                Revoca il consenso
              </button>
              <button className="button quiet" type="button" disabled={pending} onClick={() => void remove()}>
                Elimina il partecipante
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
