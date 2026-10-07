"use client";

/**
 * v6 G (agent G) — "I miei dati": the page the DPIA asked for (§10, "Revoca self-service del
 * partecipante": «Oggi cancella solo un admin; `consents.withdrawn_at` non viene mai scritto;
 * non c'è una pagina "I miei dati"»).
 *
 * It shows the participant what of theirs is stored and lets them withdraw the consent
 * themselves. The copy says exactly what the withdrawal deletes and what stays, in the same
 * words as docs/DPIA.md §3 bis — no promise the code does not keep.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireRole } from "@/components/require-role";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { useEventSlug } from "@/lib/event";
import type { ConsentWithdrawResponse, PrivacyState } from "@/lib/types";

export default function MyDataPage() {
  const slug = useEventSlug();
  return (
    <Shell signOut>
      <RequireRole role="participant" probe={`/v1/events/${slug}/privacy`}>
        <MyData slug={slug} />
      </RequireRole>
    </Shell>
  );
}

function MyData({ slug }: { slug: string }) {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<ConsentWithdrawResponse | null>(null);

  const load = useCallback(() => {
    let cancel = false;
    api<PrivacyState>(`/v1/events/${slug}/privacy`)
      .then((data) => {
        if (!cancel) setState(data);
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere i tuoi dati.");
        }
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  useEffect(() => load(), [load]);

  async function withdraw(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirm) return;
    setPending(true);
    setError(null);
    try {
      const result = await api<ConsentWithdrawResponse>(`/v1/events/${slug}/consent/withdraw`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setDone(result);
      setConfirm(false);
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Non riusciamo a ritirare il consenso.");
    } finally {
      setPending(false);
    }
  }

  const active = state?.consent !== null && state?.consent !== undefined;

  return (
    <div className="stack">
      <div>
        <h1>I miei dati</h1>
        <p className="lede">
          Qui vedi cosa conserviamo di te per questo evento e puoi ritirare il consenso al
          riconoscimento quando vuoi.
        </p>
      </div>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {!state && !error ? <p className="status">Caricamento</p> : null}

      {state ? (
        <>
          <dl className="metrics">
            <div>
              <dt>Consenso al riconoscimento</dt>
              <dd>
                {active
                  ? `attivo dal ${formatWhen(state.consent?.grantedAt ?? null)}`
                  : state.withdrawnAt
                    ? `ritirato il ${formatWhen(state.withdrawnAt)}`
                    : "non dato"}
              </dd>
            </div>
            <div>
              <dt>Foto nella tua galleria personale</dt>
              <dd>{state.gallery ? state.gallery.photos : 0}</dd>
            </div>
            <div>
              <dt>Modello numerico del tuo volto (dal selfie)</dt>
              <dd>{state.gallery?.selfieVector ? "conservato" : "nessuno"}</dd>
            </div>
            <div>
              <dt>Volti collegati alla tua galleria</dt>
              <dd>{state.gallery ? state.gallery.anchors : 0}</dd>
            </div>
            <div>
              <dt>Foto che hai caricato tu</dt>
              <dd>{state.uploads}</dd>
            </div>
          </dl>

          {done ? (
            <div className="block">
              <h2>Consenso ritirato</h2>
              <p className="lede">
                Abbiamo cancellato la tua galleria personale ({done.deleted.galleryItems}{" "}
                {done.deleted.galleryItems === 1 ? "foto collegata" : "foto collegate"}), il modello
                numerico del tuo volto ricavato dal selfie e i modelli dei tuoi volti riconosciuti
                nelle foto dell&apos;evento. Non ti cercheremo più nelle foto nuove.
              </p>
              <p className="note">
                Restano le foto dell&apos;album ufficiale in cui compari: sono scatti
                dell&apos;organizzatore, in cui ci sono anche altre persone, e il ritiro del
                consenso riguarda il riconoscimento del volto, non la fotografia. Se vuoi che una
                foto venga rimossa, scrivi all&apos;organizzatore indicando quale: la cancella un
                amministratore. Restano anche le foto che hai caricato tu
                {state.uploads > 0 ? ` (${state.uploads})` : ""} e la registrazione del consenso con
                la data del ritiro, che ci serve per dimostrare di averlo rispettato.
              </p>
            </div>
          ) : null}

          {active ? (
            <form className="block danger" onSubmit={(event) => void withdraw(event)}>
              <h2>Ritira il consenso</h2>
              <p className="fine">
                Ritirando il consenso cancelliamo subito: la tua galleria personale e i collegamenti
                alle foto, il modello numerico del tuo volto ricavato dal selfie, i modelli dei
                volti che abbiamo riconosciuto come te nelle foto dell&apos;evento, le tue
                segnalazioni «Non sono io» e il registro dei confronti. Non potremo più cercarti
                nelle foto. Le foto dell&apos;album ufficiale in cui compari restano
                all&apos;organizzatore, come le fotografie di qualsiasi evento; se vuoi la
                cancellazione di uno scatto, chiedila all&apos;organizzatore. Puoi dare di nuovo il
                consenso in qualsiasi momento, ma serve un nuovo selfie: quello che abbiamo
                cancellato non torna.
              </p>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(event) => setConfirm(event.target.checked)}
                />
                <span>Ho capito e voglio ritirare il consenso.</span>
              </label>
              <div className="actions">
                <button className="button primary" type="submit" disabled={!confirm || pending}>
                  {pending ? "Ritiro…" : "Ritira il consenso"}
                </button>
              </div>
            </form>
          ) : (
            <div className="block">
              <h2>Vuoi cercarti nelle foto?</h2>
              <p className="fine">
                Serve un nuovo consenso e un nuovo selfie. Quello che abbiamo cancellato con il
                ritiro non viene ripristinato: la galleria si ricostruisce da zero.
              </p>
              <div className="actions">
                <Link className="button primary" href="/selfie">
                  Dai il consenso e fai un selfie
                </Link>
              </div>
            </div>
          )}

          <p className="note">
            Per la cancellazione completa dell&apos;account, per una copia dei tuoi dati o per
            rimuovere una foto, scrivi all&apos;organizzatore dell&apos;evento: sono operazioni che
            esegue un amministratore e restano tracciate.
          </p>
        </>
      ) : null}
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}
