"use client";

/**
 * v6 E (agent E): the participant's tagging area, in Italian.
 *
 * Tagging makes the same person<->photo link face recognition makes, minus the biometrics, so
 * the UI is written to say that out loud rather than to feel like a social feature:
 *
 *   * the opt-in is off until the participant turns it on, and the copy explains what turning
 *     it on means before they do;
 *   * removal is the same "Non sono io" the gallery already uses, with the same wording, so
 *     there is one gesture to learn and not two;
 *   * the name box exists so the suggestion list can show a chosen name instead of an e-mail.
 *
 * The autocomplete is deliberately dull: nothing is requested below
 * `TAG_SEARCH_MIN_CHARS` characters, and the field says so. The server refuses short queries
 * with a 400 anyway — this is the courtesy, not the control.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Shell } from "@/components/shell";
import { Gate } from "@/components/require-role";
import { useToast } from "@/components/toast";
import { ApiError, api } from "@/lib/api";
import type {
  PhotoTag,
  PhotoTagsResponse,
  TagProfile,
  TagSearchResponse,
  TaggableUser,
  TaggedPhoto,
  TagsMeResponse,
} from "@/lib/types";

/** Mirrors `TAG_SEARCH_MIN_CHARS` in `@rephoto/contracts`: below this, nothing is requested. */
const SEARCH_MIN_CHARS = 3;
/**
 * The tagging consent, mirrored from `TAG_CONSENT_TEXT` / `TAG_CONSENT_TEXT_VERSION` in
 * `@rephoto/contracts` the way `app/selfie/page.tsx` mirrors the recognition one. It is a
 * separate consent from the recognition text on the selfie page, and asking for it here does
 * not require that one: a participant who only ever uses the crowd album never grants
 * recognition consent, and tagging is the only way they can find themselves in those photos.
 * Keep both copies in step; the API rejects any other version.
 */
const TAG_CONSENT_TEXT_VERSION = "2026-10-08";
const TAG_CONSENT_TEXT =
  "Acconsento che gli altri partecipanti associno il nome che ho scelto alle foto dell'evento in cui compaio. Posso rimuovere ogni tag e disattivare i tag in qualsiasi momento: disattivandoli, i tag che ho già vengono rimossi. Questo consenso è separato dal riconoscimento del volto e non lo richiede.";
/** Typing pause before a suggestion request, so one name is one or two calls, not ten. */
const SEARCH_DEBOUNCE_MS = 250;
const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 60;

export function Tagger({ slug, photoId }: { slug: string; photoId?: string }) {
  return (
    <Shell signOut>
      <TaggerBody slug={slug} {...(photoId ? { photoId } : {})} />
    </Shell>
  );
}

function TaggerBody({ slug, photoId }: { slug: string; photoId?: string }) {
  const toast = useToast();
  const [profile, setProfile] = useState<TagProfile | null>(null);
  const [items, setItems] = useState<TaggedPhoto[] | null>(null);
  const [gate, setGate] = useState<"anon" | "wrong" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) setGate("anon");
    else if (cause instanceof ApiError && cause.status === 403) setGate("wrong");
    else setError(cause instanceof ApiError ? cause.message : "Non riusciamo a caricare i tag.");
  }, []);

  useEffect(() => {
    let cancel = false;
    setError(null);
    api<TagsMeResponse>(`/v1/events/${slug}/tags/me`)
      .then((data) => {
        if (cancel) return;
        setProfile(data.profile);
        setItems(data.items);
        setName(data.profile.displayName ?? "");
      })
      .catch((cause: unknown) => {
        if (!cancel) fail(cause);
      });
    return () => {
      cancel = true;
    };
  }, [slug, reload, fail]);

  const save = useCallback(
    async (taggable: boolean) => {
      const trimmed = name.trim();
      if (taggable && trimmed.length < NAME_MIN_CHARS) {
        setError("Scegli un nome visibile di almeno 2 caratteri.");
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const next = await api<TagProfile>(`/v1/events/${slug}/tags/me`, {
          method: "PUT",
          // `consentTextVersion` is sent only when opting in: it records which words the
          // participant was shown, and the API pins it to the current text.
          body: JSON.stringify({
            taggable,
            displayName: trimmed.length > 0 ? trimmed : null,
            ...(taggable ? { consentTextVersion: TAG_CONSENT_TEXT_VERSION } : {}),
          }),
        });
        setProfile(next);
        setName(next.displayName ?? "");
        // The opt-out also removes the tags already on you, so the list has to be re-read.
        if (!taggable) setReload((value) => value + 1);
        toast(taggable ? "Ora gli altri possono taggarti" : "Tag disattivati e rimossi");
      } catch (cause: unknown) {
        setError(cause instanceof ApiError ? cause.message : "Non riusciamo a salvare.");
      } finally {
        setSaving(false);
      }
    },
    [name, slug, toast],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        // The same verdict the gallery's "Non sono io" writes: one mechanism, not two.
        await api(`/v1/events/${slug}/tags/${id}`, { method: "DELETE" });
        setItems((current) => (current ?? []).filter((row) => row.photoId !== id));
        toast("Tag rimosso");
      } catch (cause: unknown) {
        setError(cause instanceof ApiError ? cause.message : "Non riusciamo a rimuovere il tag.");
      }
    },
    [slug, toast],
  );

  if (gate) return <Gate kind={gate} />;

  return (
    <div className="stack">
      <h1>Tag</h1>
      <p className="lede">
        Un tag collega il tuo nome a una foto. Lo fa una persona, non il riconoscimento del volto.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="block">
        <h2>Possono taggarti?</h2>
        <p className="fine">
          Di norma no. Se lo attivi, chi vede una foto può collegarci il nome che scegli qui, e tu
          ricevi un avviso. Puoi rimuovere ogni tag e disattivarlo quando vuoi: disattivandolo,
          i tag che hai già addosso vengono rimossi.
        </p>
        {/* The consent itself: shown before the control that acts on it. Separate from the
            recognition consent on the selfie page, and it does not require it. */}
        <p className="consent-text">{TAG_CONSENT_TEXT}</p>
        {profile === null ? (
          <p className="status">Caricamento</p>
        ) : (
          <>
            <label htmlFor="tag-name">Nome visibile agli altri partecipanti</label>
            <input
              id="tag-name"
              type="text"
              value={name}
              maxLength={NAME_MAX_CHARS}
              autoComplete="off"
              placeholder="Come vuoi essere chiamato"
              onChange={(nativeEvent) => setName(nativeEvent.target.value)}
            />
            <p className="fine">
              Negli elenchi compare solo questo nome. La tua email non viene mai mostrata.
            </p>
            <div className="actions inline">
              {profile.taggable ? (
                <>
                  <button
                    className="button"
                    type="button"
                    disabled={saving}
                    onClick={() => void save(true)}
                  >
                    Salva il nome
                  </button>
                  <button
                    className="button quiet"
                    type="button"
                    disabled={saving}
                    onClick={() => void save(false)}
                  >
                    Disattiva i tag
                  </button>
                </>
              ) : (
                <button
                  className="button primary"
                  type="button"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  Accetto e attivo i tag
                </button>
              )}
            </div>
            <p className="meta" role="status">
              {profile.taggable
                ? `Tag attivi${profile.consentAt ? ` · consenso del ${new Date(profile.consentAt).toLocaleDateString("it-IT")}` : ""}`
                : "Tag disattivati"}
            </p>
          </>
        )}
      </section>

      {photoId ? <TagPhotoPanel slug={slug} photoId={photoId} /> : null}

      <section className="block">
        <h2>Foto in cui ti hanno taggato</h2>
        {items === null ? (
          <p className="status">Caricamento</p>
        ) : items.length === 0 ? (
          <p className="meta">Nessun tag. Quando qualcuno ti tagga, la foto compare qui.</p>
        ) : (
          <div className="grid">
            {items.map((item) => (
              <div className="cell" key={item.photoId}>
                <a className="cell-hit" href={item.webUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="thumb is-in" src={item.thumbUrl} alt="" loading="lazy" />
                </a>
                <button
                  className="tag-remove"
                  type="button"
                  onClick={() => void remove(item.photoId)}
                >
                  Non sono io
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Tagging someone on one photo. Exported so the viewer can embed it later without this file
 * having to know about the gallery.
 */
export function TagPhotoPanel({ slug, photoId }: { slug: string; photoId: string }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TaggableUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [tags, setTags] = useState<PhotoTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const term = useMemo(() => query.trim(), [query]);
  const tooShort = term.length > 0 && term.length < SEARCH_MIN_CHARS;

  useEffect(() => {
    let cancel = false;
    api<PhotoTagsResponse>(`/v1/events/${slug}/photos/${photoId}/tags`)
      .then((data) => {
        if (!cancel) setTags(data.items);
      })
      .catch(() => {
        if (!cancel) setTags([]);
      });
    return () => {
      cancel = true;
    };
  }, [slug, photoId]);

  useEffect(() => {
    // Nothing is requested below the minimum: an empty or 1-2 character query is not a short
    // search, it is a request for the whole roster, and the server refuses it with a 400.
    if (term.length < SEARCH_MIN_CHARS) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }
    let cancel = false;
    setSearching(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api<TagSearchResponse>(`/v1/events/${slug}/tags/search?q=${encodeURIComponent(term)}`)
        .then((data) => {
          if (!cancel) setSuggestions(data.items);
        })
        .catch((cause: unknown) => {
          if (cancel) return;
          setSuggestions([]);
          if (cause instanceof ApiError && cause.status === 429) {
            setError("Troppe ricerche. Aspetta un momento.");
          }
        })
        .finally(() => {
          if (!cancel) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancel = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [slug, term]);

  const add = useCallback(
    async (user: TaggableUser) => {
      setError(null);
      try {
        const created = await api<PhotoTag>(`/v1/events/${slug}/tags`, {
          method: "POST",
          body: JSON.stringify({ photoId, userId: user.userId }),
        });
        setTags((current) => [...(current ?? []), created]);
        setQuery("");
        setSuggestions([]);
        toast(`${user.displayName} è stato taggato`);
      } catch (cause: unknown) {
        // 409 covers both "already tagged" and "tagged and then refused": the tagger is not
        // told which, and cannot re-create a tag the person removed.
        setError(
          cause instanceof ApiError ? cause.message : "Non riusciamo ad aggiungere il tag.",
        );
      }
    },
    [photoId, slug, toast],
  );

  return (
    <section className="block">
      <h2>Tagga qualcuno in questa foto</h2>
      <p className="fine">
        Compaiono solo le persone che hanno attivato i tag, con il nome che hanno scelto. Chi
        tagghi riceve un avviso e può rimuovere il tag.
      </p>
      <label htmlFor="tag-search">Cerca un nome</label>
      <input
        id="tag-search"
        type="text"
        value={query}
        autoComplete="off"
        maxLength={NAME_MAX_CHARS}
        placeholder="Almeno 3 caratteri"
        onChange={(nativeEvent) => setQuery(nativeEvent.target.value)}
      />
      {tooShort ? (
        <p className="fine" role="status">
          Scrivi almeno 3 caratteri del nome.
        </p>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {searching ? <p className="status">Cerco</p> : null}
      {!searching && term.length >= SEARCH_MIN_CHARS && suggestions.length === 0 ? (
        <p className="meta">Nessuna persona con questo nome ha attivato i tag.</p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul className="list">
          {suggestions.map((user) => (
            <li key={user.userId}>
              <span className="name">{user.displayName}</span>
              <button className="linkish" type="button" onClick={() => void add(user)}>
                Tagga
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Già taggati</h3>
      {tags === null ? (
        <p className="status">Caricamento</p>
      ) : tags.length === 0 ? (
        <p className="meta">Nessuno.</p>
      ) : (
        <ul className="list">
          {tags.map((tag) => (
            <li key={tag.userId}>
              <span className="name">{tag.displayName ?? "Partecipante"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
