"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminEvent,
  Album,
  AlbumsResponse,
  ModerationQueueItem,
  ModerationQueueResponse,
  ModerationState,
} from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen, shortId } from "@/components/admin/shared";

/**
 * v6 D (agent D): the moderation queue.
 *
 * Two people sit on this screen for hours, so it is built around latency and the keyboard,
 * not around looks:
 *
 *  - one large photo at a time, the next ones decoded in advance, so a verdict never waits
 *    for a network round-trip;
 *  - every verdict is applied optimistically and the request flies in the background; a
 *    failure comes back as a line in "Da rifare", it never blocks the queue;
 *  - A approve, → next, ← back, X select, shift+A on the selection: one keystroke each,
 *    because approving is the common verdict and it is harmless.
 *
 * REJECTION IS NOT THE MIRROR OF APPROVAL, and this screen must not let anyone believe it
 * is. `rejected` runs `purgePhoto` on the api side: the faces, the derivatives AND the
 * original bytes are destroyed, with no undo and no copy left anywhere. The word is a trap
 * for anyone arriving from the previous console, where the negative verdict was `blocked` —
 * a reversible hide. So R (and shift+R) only ASK: they open a confirmation that spells the
 * consequence out, and while it is open every queue shortcut is inert, so nothing can be
 * confirmed by a keystroke. Destroying takes two deliberate acts on that dialog: tick the
 * acknowledgement, then press the one destructive button.
 *
 * THE API IS AGENT C'S (spec section C2) and is not in this branch. This screen is written
 * against the documented shapes:
 *
 *    GET  /v1/admin/moderation?albumId=&state=&cursor=  -> { photos | items, nextCursor }
 *    POST /v1/admin/photos/:id/moderate { state }
 *
 * and reads every field but `id` defensively, so a different field name degrades one detail
 * instead of the screen. While the routes are absent the screen says so and stays usable
 * for nothing else — no fallback writes anywhere.
 */

const PAGE = 24;
/** How many photos ahead are decoded before they are needed. */
const PREFETCH = 4;

type Verdict = "approved" | "rejected";

type Failed = { id: string; state: Verdict; message: string };

/**
 * A rejection waiting to be confirmed. `ids` is captured when the dialog opens, so what the
 * dialog names is exactly what gets destroyed even if the queue moves underneath it.
 */
type PendingReject = {
  ids: string[];
  /** Where it came from, so the queue advances the way the direct path would have. */
  origin: "current" | "selection" | "retry";
};

/** What the Stato select offers. "reported" is this screen's word, not a `moderation_state`. */
type QueueFilter = ModerationState | "reported";

/**
 * The query for one page.
 *
 * "reported" must NOT be sent as `state`: the api's enum is
 * pending/approved/rejected/auto_rejected and anything else answers 400, which this screen
 * reads as "the routes are not deployed" — so the Segnalate filter used to show the
 * "area C is not in this environment" notice on a perfectly healthy deployment.
 *
 * With no `state` the queue is already "everything a moderator still has to look at",
 * approved photos with open counting reports included, so Segnalate asks for exactly that
 * plus `includeNotMe`, the `not_me` reports the api leaves out by default.
 */
function queryFor(state: QueueFilter, albumId: string, cursor?: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (state === "reported") params.set("includeNotMe", "true");
  else params.set("state", state);
  if (albumId) params.set("albumId", albumId);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/**
 * The rows of a page, keyed however the api spells the id: the shipped route sends
 * `photoId`, this screen was written against `id`, and the mismatch meant every row was
 * dropped and the queue looked permanently empty. Normalised to `id` once, here, so the
 * rest of the screen has one shape to read.
 */
function itemsOf(data: ModerationQueueResponse): ModerationQueueItem[] {
  const list = data.photos ?? data.items ?? [];
  const rows: ModerationQueueItem[] = [];
  for (const row of list) {
    const id =
      typeof row?.id === "string" ? row.id : typeof row?.photoId === "string" ? row.photoId : null;
    if (id) rows.push({ ...row, id });
  }
  return rows;
}

function imageOf(item: ModerationQueueItem): string | null {
  return item.webUrl ?? item.thumbUrl ?? null;
}

function reportsOf(item: ModerationQueueItem): number {
  return item.reportCount ?? item.openReports ?? item.reports?.length ?? 0;
}

export function ModerationSection({ event }: { event: AdminEvent | null }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumId, setAlbumId] = useState<string>("");
  const [state, setState] = useState<QueueFilter>("pending");
  const [queue, setQueue] = useState<ModerationQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [pendingReject, setPendingReject] = useState<PendingReject | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!event) return;
    let cancel = false;
    api<AlbumsResponse>(`/v1/admin/events/${event.id}/albums`)
      .then((data) => {
        if (!cancel) setAlbums(data.albums);
      })
      .catch(() => {
        if (!cancel) setAlbums([]);
      });
    return () => {
      cancel = true;
    };
  }, [event]);

  const load = useCallback(
    async (reset: boolean) => {
      if (!event) return;
      setLoading(true);
      setError(null);
      try {
        const query = queryFor(state, albumId, reset ? null : cursor);
        const data = await api<ModerationQueueResponse>(`/v1/admin/moderation?${query}`);
        const rows = itemsOf(data);
        setUnavailable(false);
        setQueue((current) => (reset ? rows : [...current, ...rows]));
        setCursor(data.nextCursor ?? null);
        if (reset) {
          setIndex(0);
          setSelected(new Set());
        }
      } catch (cause) {
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) {
          // Agent C's routes are not deployed yet (or the query shape moved).
          setUnavailable(true);
          setQueue([]);
        } else {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere la coda.");
        }
      } finally {
        setLoading(false);
      }
    },
    [event, state, albumId, cursor],
  );

  // Reload from scratch whenever the filters change. `load` is intentionally not a
  // dependency: it changes with `cursor`, which would re-trigger the reset on every page.
  useEffect(() => {
    if (!event) return;
    setCursor(null);
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<ModerationQueueResponse>(
          `/v1/admin/moderation?${queryFor(state, albumId)}`,
        );
        setUnavailable(false);
        setQueue(itemsOf(data));
        setCursor(data.nextCursor ?? null);
        setIndex(0);
        setSelected(new Set());
      } catch (cause) {
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) {
          setUnavailable(true);
          setQueue([]);
        } else {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere la coda.");
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id, state, albumId]);

  // A decided photo leaves `queue` immediately (optimistic), so the queue IS what is left.
  const pending = queue;
  const current = pending[index] ?? null;

  // Decode the next few photos while the moderator looks at this one.
  useEffect(() => {
    for (let ahead = 1; ahead <= PREFETCH; ahead += 1) {
      const next = pending[index + ahead];
      const url = next ? imageOf(next) : null;
      if (!url) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }, [pending, index]);

  /** Fire and forget: the queue advances now, the request lands when it lands. */
  const send = useCallback((id: string, verdict: Verdict) => {
    void api(`/v1/admin/photos/${id}/moderate`, {
      method: "POST",
      body: JSON.stringify({ state: verdict }),
    }).catch((cause: unknown) => {
      setFailed((rows) => [
        { id, state: verdict, message: cause instanceof ApiError ? cause.message : "Invio non riuscito." },
        ...rows.slice(0, 19),
      ]);
    });
  }, []);

  /** Opens the confirmation. Nothing is sent and nothing leaves the queue yet. */
  const askReject = useCallback((ids: string[], origin: PendingReject["origin"]) => {
    if (ids.length === 0) return;
    // The acknowledgement always starts untouched: it is per rejection, not per session.
    setAcknowledged(false);
    setPendingReject({ ids, origin });
  }, []);

  const cancelReject = useCallback(() => {
    setPendingReject(null);
    setAcknowledged(false);
  }, []);

  /** The photo on screen. Only ever called with "rejected" from the confirmation. */
  const applyToCurrent = useCallback(
    (verdict: Verdict, id: string) => {
      send(id, verdict);
      setQueue((rows) => rows.filter((row) => row.id !== id));
      setDone((value) => value + 1);
      setIndex((value) => Math.min(value, Math.max(0, pending.length - 2)));
    },
    [pending.length, send],
  );

  /** The selection. Only ever called with "rejected" from the confirmation. */
  const applyToSelection = useCallback(
    (verdict: Verdict, ids: string[]) => {
      const judged = new Set(ids);
      for (const id of ids) send(id, verdict);
      setQueue((rows) => rows.filter((row) => !judged.has(row.id)));
      setDone((value) => value + ids.length);
      setSelected((rows) => {
        const next = new Set(rows);
        for (const id of ids) next.delete(id);
        return next;
      });
      setIndex(0);
    },
    [send],
  );

  const judge = useCallback(
    (verdict: Verdict) => {
      if (!current) return;
      // Approving is immediate; rejecting is irreversible, so it only asks.
      if (verdict === "rejected") {
        askReject([current.id], "current");
        return;
      }
      applyToCurrent("approved", current.id);
    },
    [applyToCurrent, askReject, current],
  );

  const judgeSelection = useCallback(
    (verdict: Verdict) => {
      if (selected.size === 0) return;
      const ids = [...selected];
      if (verdict === "rejected") {
        askReject(ids, "selection");
        return;
      }
      applyToSelection("approved", ids);
    },
    [applyToSelection, askReject, selected],
  );

  /**
   * The only path that ever sends `rejected`. Both gates must be satisfied: an open
   * confirmation and a ticked acknowledgement.
   */
  const confirmReject = useCallback(() => {
    if (!pendingReject || !acknowledged) return;
    const { ids, origin } = pendingReject;
    setPendingReject(null);
    setAcknowledged(false);
    if (origin === "retry") {
      for (const id of ids) send(id, "rejected");
      return;
    }
    if (origin === "current") {
      const id = ids[0];
      if (id) applyToCurrent("rejected", id);
      return;
    }
    applyToSelection("rejected", ids);
  }, [acknowledged, applyToCurrent, applyToSelection, pendingReject, send]);

  const toggle = useCallback(() => {
    if (!current) return;
    setSelected((rows) => {
      const next = new Set(rows);
      if (next.has(current.id)) next.delete(current.id);
      else next.add(current.id);
      return next;
    });
    setIndex((value) => Math.min(value + 1, Math.max(0, pending.length - 1)));
  }, [current, pending.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (pendingReject) {
        // A confirmation is open. Escape withdraws it; every other key is inert, so no
        // keystroke can confirm a purge and no stray A/R flies past a question the
        // moderator has not answered yet. This is checked before the form-field guard
        // below, so Escape still works while the acknowledgement checkbox has focus.
        if (e.key === "Escape") {
          e.preventDefault();
          cancelReject();
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === "a" && e.shiftKey) {
        e.preventDefault();
        judgeSelection("approved");
        return;
      }
      if (key === "r" && e.shiftKey) {
        e.preventDefault();
        judgeSelection("rejected");
        return;
      }
      if (key === "a") {
        e.preventDefault();
        judge("approved");
        return;
      }
      if (key === "r") {
        e.preventDefault();
        judge("rejected");
        return;
      }
      if (key === "x") {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((value) => Math.min(value + 1, Math.max(0, pending.length - 1)));
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [judge, judgeSelection, toggle, pending.length, pendingReject, cancelReject]);

  // Keep a page ahead: at four photos from the end, ask for the next page.
  useEffect(() => {
    if (cursor && !loading && pending.length - index <= 4) void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, pending.length, cursor, loading]);

  return (
    <section className="block moderation" ref={surface}>
      <h2>Moderazione</h2>
      <EventNeeded event={event} />
      <p className="fine">
        <kbd>A</kbd> approva · <kbd>R</kbd> chiede conferma per rifiutare · <kbd>→</kbd> avanti ·{" "}
        <kbd>←</kbd> indietro · <kbd>X</kbd> seleziona · <kbd>shift</kbd>+<kbd>A</kbd>/<kbd>R</kbd>{" "}
        sulla selezione. L&apos;approvazione parte subito: la coda non aspetta la rete.
      </p>
      <p className="fine warn">
        <strong>Rifiutare cancella la foto per sempre</strong>: originale, copie e volti vengono
        eliminati e non si possono recuperare. Non è «nascondi». Per questo nessun tasto da solo
        rifiuta: <kbd>R</kbd> apre una conferma.
      </p>
      <div className="form-grid">
        <label>
          Album
          <select value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
            <option value="">Tutti gli album</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stato
          <select value={state} onChange={(e) => setState(e.target.value as QueueFilter)}>
            <option value="pending">In attesa</option>
            <option value="reported">Segnalate</option>
            <option value="auto_rejected">Scartate dallo screening</option>
            <option value="rejected">Rifiutate</option>
          </select>
        </label>
      </div>

      {unavailable ? (
        <p className="note" role="status">
          La coda di moderazione risponderà quando l&apos;area C (caricamenti e moderazione,
          migrazione 010) sarà in questo ambiente: questa schermata interroga{" "}
          <code>GET /v1/admin/moderation</code> e <code>POST /v1/admin/photos/:id/moderate</code>.
          Nessun altro percorso scrive al posto loro.
        </p>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <p className="meta">
        {pending.length} in coda · {done} decise in questa sessione
        {selected.size > 0 ? ` · ${selected.size} selezionate` : ""}
        {loading ? " · carico…" : ""}
      </p>

      {pendingReject ? (
        <div className="moderation-confirm" role="alertdialog" aria-labelledby="reject-title">
          <h3 id="reject-title">
            {pendingReject.ids.length === 1
              ? "Cancellare questa foto per sempre?"
              : `Cancellare ${pendingReject.ids.length} foto per sempre?`}
          </h3>
          <p>
            Rifiutare non nasconde: <strong>cancella</strong>. Vengono eliminati il file
            originale, le copie (anteprima e versione web) e i volti rilevati.{" "}
            <strong>L&apos;operazione non si può annullare</strong> e non resta nessuna copia da
            cui recuperare la foto.
          </p>
          <p className="fine">
            Annulla non cambia nulla: la foto resta nello stato in cui è adesso. Una foto «in
            attesa» è già fuori dall&apos;album mentre aspetta un verdetto — rifiutare non serve
            a nasconderla, serve a cancellarla.
          </p>
          <ul className="list">
            {pendingReject.ids.map((id) => (
              <li key={id}>
                <code>{shortId(id)}</code>
              </li>
            ))}
          </ul>
          <label className="consent">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            Ho capito: i file originali vengono cancellati e non si possono recuperare.
          </label>
          <div className="actions inline">
            {/*
              The only control in the app that sends `rejected`. Disabled until the
              acknowledgement above is ticked, and no keyboard shortcut reaches it: while this
              panel is open the queue keys do nothing but Escape (see the keydown handler).
            */}
            <button
              className="button danger"
              type="button"
              disabled={!acknowledged}
              onClick={confirmReject}
            >
              {pendingReject.ids.length === 1
                ? "Cancella definitivamente"
                : `Cancella definitivamente ${pendingReject.ids.length} foto`}
            </button>
            <button className="button primary" type="button" onClick={cancelReject}>
              Annulla (Esc)
            </button>
          </div>
        </div>
      ) : null}

      {current ? (
        <div className="moderation-stage">
          {imageOf(current) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="moderation-photo"
              src={imageOf(current) ?? ""}
              alt={current.filename ?? `Foto ${shortId(current.id)}`}
              decoding="async"
            />
          ) : (
            <div className="moderation-photo empty">Nessuna anteprima disponibile</div>
          )}
          <div className="moderation-meta">
            <p className="name">
              <code>{shortId(current.id)}</code> {current.filename ?? ""}
            </p>
            <p className="meta">
              {current.createdAt ? formatWhen(current.createdAt) : "—"}
              {current.moderationState ? ` · ${current.moderationState}` : ""}
              {reportsOf(current) > 0 ? ` · ${reportsOf(current)} segnalazioni` : ""}
            </p>
            {current.reports && current.reports.length > 0 ? (
              <ul className="list">
                {current.reports.map((report, position) => (
                  <li key={`${current.id}-${position}`}>
                    <span className="name">{report.reason}</span>
                    {report.note ? <span className="meta">{report.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : current.reasons && current.reasons.length > 0 ? (
              // The shipped route sends the distinct reasons, not the individual reports.
              <ul className="list">
                {current.reasons.map((reason) => (
                  <li key={`${current.id}-${reason}`}>
                    <span className="name">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {current.notMeReports ? (
              <p className="fine">
                {current.notMeReports} segnalazioni «non sono io»: non contano verso la soglia.
              </p>
            ) : null}
            <div className="actions inline">
              <button className="button primary" type="button" onClick={() => judge("approved")}>
                Approva (A)
              </button>
              <button
                className="button quiet"
                type="button"
                onClick={() => judge("rejected")}
                title="Chiede conferma: rifiutare cancella la foto per sempre"
              >
                Rifiuta… (R)
              </button>
              <button className="button" type="button" onClick={toggle}>
                {selected.has(current.id) ? "Deseleziona (X)" : "Seleziona (X)"}
              </button>
            </div>
            {selected.size > 0 ? (
              <div className="actions inline">
                <button className="button primary" type="button" onClick={() => judgeSelection("approved")}>
                  Approva {selected.size} (shift+A)
                </button>
                <button
                  className="button quiet"
                  type="button"
                  onClick={() => judgeSelection("rejected")}
                  title="Chiede conferma: rifiutare cancella le foto per sempre"
                >
                  Rifiuta… {selected.size} (shift+R)
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        !unavailable && !loading && <p className="note">Niente da moderare con questi filtri.</p>
      )}

      {pending.length > 1 ? (
        <div className="moderation-strip" aria-label="Prossime foto">
          {pending.slice(index, index + 10).map((item, position) => (
            <button
              key={item.id}
              type="button"
              className="thumb-link"
              aria-current={position === 0 ? "true" : undefined}
              data-selected={selected.has(item.id) ? "true" : undefined}
              onClick={() => setIndex(index + position)}
            >
              {item.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="thumb" src={item.thumbUrl} alt="" decoding="async" />
              ) : (
                <span className="thumb empty" />
              )}
            </button>
          ))}
        </div>
      ) : null}

      {failed.length > 0 ? (
        <>
          <h3>Da rifare</h3>
          <ul className="list errors">
            {failed.map((row) => (
              <li key={`${row.id}-${row.state}`}>
                <span className="name">
                  <code>{shortId(row.id)}</code> {row.state === "approved" ? "approva" : "rifiuta"}
                </span>
                <span className="error-text">{row.message}</span>
                {/*
                  A rejection that failed destroyed nothing, so retrying it is a fresh
                  irreversible act and goes through the same confirmation.
                */}
                <button
                  className="linkish"
                  type="button"
                  onClick={() =>
                    row.state === "rejected"
                      ? askReject([row.id], "retry")
                      : send(row.id, row.state)
                  }
                >
                  {row.state === "rejected" ? "Riprova…" : "Riprova"}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
