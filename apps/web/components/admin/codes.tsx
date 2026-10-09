"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import type {
  AdminEvent,
  AdminEventCode,
  AdminEventCodeResponse,
  AdminEventCodesResponse,
} from "@/lib/types";
import { ApiError, api } from "@/lib/api";
import { EventNeeded, formatWhen } from "@/components/admin/shared";

/**
 * v6 D (agent D): event codes — the blocking screen.
 *
 * `POST /v1/auth/register` is gated by a code from `event_codes` and until now there was no
 * way to create one outside of psql: on the event day nobody could register. This screen
 * mints, lists, labels, caps, expires and revokes them.
 *
 * The minted value is shown ONCE, in a printable panel with the QR of
 * `/registrati?codice=…`, because that is what goes on the badge. Afterwards the list keeps
 * it hidden behind a per-row "Mostra": the console is often on a shared screen and a code
 * is a credential, not a label.
 *
 * Revoking is an expiry in the past (the api does that), so a revoked code is refused by
 * the same statement that claims one and the row keeps how many people had already used it.
 */

const STATUS_LABEL: Record<AdminEventCode["status"], string> = {
  active: "Attivo",
  expired: "Scaduto o revocato",
  exhausted: "Esaurito",
};

function registrationUrl(code: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/registrati?codice=${encodeURIComponent(code)}`;
}

export function CodesSection({ event }: { event: AdminEvent | null }) {
  const [codes, setCodes] = useState<AdminEventCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<AdminEventCode | null>(null);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!event) {
      setCodes(null);
      return;
    }
    let cancel = false;
    api<AdminEventCodesResponse>(`/v1/admin/events/${event.id}/codes`)
      .then((data) => {
        if (cancel) return;
        setCodes(data.codes);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancel) {
          setCodes([]);
          setError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere i codici.");
        }
      });
    return () => {
      cancel = true;
    };
  }, [event, attempt]);

  return (
    <>
      <section className="block">
        <h2>Codici evento</h2>
        <p className="fine">
          Il codice è la porta della registrazione: chi si iscrive da <code>/registrati</code> deve
          digitarlo. Stampalo sul badge o mostralo come QR. Un codice senza limite d&apos;uso vale per
          tutto l&apos;evento; un codice con limite si esaurisce da solo.
        </p>
        <EventNeeded event={event} />
        {event ? <MintForm event={event} onMinted={(code) => { setMinted(code); refresh(); }} /> : null}
      </section>

      {minted ? <PrintablePanel code={minted} onClose={() => setMinted(null)} /> : null}

      {event ? (
        <section className="block">
          <h3>Codici dell&apos;evento</h3>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          {codes === null ? <p className="status">Caricamento</p> : null}
          {codes && codes.length === 0 && !error ? (
            <p className="note">Nessun codice: creane uno prima dell&apos;evento.</p>
          ) : null}
          {codes && codes.length > 0 ? (
            <ul className="list codes">
              {codes.map((code) => (
                <CodeRow key={code.code} event={event} code={code} onChanged={refresh} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function MintForm({ event, onMinted }: { event: AdminEvent; onMinted: (code: AdminEventCode) => void }) {
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        label: label.trim() === "" ? null : label.trim(),
        maxUses: maxUses.trim() === "" ? null : Number(maxUses),
        expiresAt: expiresAt === "" ? null : new Date(expiresAt).toISOString(),
      };
      if (custom.trim() !== "") body.code = custom.trim().toUpperCase();
      const data = await api<AdminEventCodeResponse>(`/v1/admin/events/${event.id}/codes`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onMinted(data.code);
      setLabel("");
      setMaxUses("");
      setExpiresAt("");
      setCustom("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Creazione non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="form-grid">
        <label>
          Etichetta
          <input
            type="text"
            value={label}
            placeholder="Badge ingresso"
            autoComplete="off"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Usi massimi
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maxUses}
            placeholder="senza limite"
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </label>
        <label>
          Scadenza
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
        <label>
          Codice scelto da te
          <input
            type="text"
            value={custom}
            placeholder="generato"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
      </div>
      <p className="fine">
        Senza &quot;codice scelto da te&quot; ne generiamo uno leggibile, senza caratteri che si
        confondono (niente I, O, 0, 1).
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions inline">
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Creo…" : "Crea il codice"}
        </button>
      </div>
    </form>
  );
}

/** Shown once, right after minting: the value, the QR and a print button. */
function PrintablePanel({ code, onClose }: { code: AdminEventCode; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = registrationUrl(code.code);

  useEffect(() => {
    let cancel = false;
    QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((data) => {
        if (!cancel) setQr(data);
      })
      .catch(() => {
        if (!cancel) setQr(null);
      });
    return () => {
      cancel = true;
    };
  }, [url]);

  return (
    <section className="block code-print" aria-label="Codice appena creato">
      <h3>Codice creato</h3>
      <p className="note">
        Questo è l&apos;unico momento in cui il codice è mostrato per intero. Stampalo o copialo
        adesso; dopo resta nell&apos;elenco ma coperto.
      </p>
      <p className="code-value">
        <code>{code.code}</code>
      </p>
      <div className="qr-card">
        {qr ? <img className="qr" src={qr} alt={`QR di registrazione con il codice ${code.code}`} /> : null}
        <p className="link-text">{url}</p>
      </div>
      <p className="meta">
        {code.label ? `${code.label} · ` : ""}
        {code.maxUses === null ? "senza limite d'uso" : `${code.maxUses} usi`}
        {code.expiresAt ? ` · scade il ${formatWhen(code.expiresAt)}` : " · senza scadenza"}
      </p>
      <div className="actions inline no-print">
        <button className="button" type="button" onClick={() => void navigator.clipboard?.writeText(code.code)}>
          Copia il codice
        </button>
        <button className="button" type="button" onClick={() => window.print()}>
          Stampa
        </button>
        <button className="button quiet" type="button" onClick={onClose}>
          Ho finito
        </button>
      </div>
    </section>
  );
}

function CodeRow({
  event,
  code,
  onChanged,
}: {
  event: AdminEvent;
  code: AdminEventCode;
  onChanged: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [label, setLabel] = useState(code.label ?? "");
  const [cap, setCap] = useState(code.maxUses === null ? "" : String(code.maxUses));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      await api<AdminEventCodeResponse>(
        `/v1/admin/events/${event.id}/codes/${encodeURIComponent(code.code)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Modifica non riuscita.");
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revocare il codice ${code.code}? Chi lo ha già usato resta registrato.`)) return;
    setPending(true);
    setError(null);
    try {
      await api(`/v1/admin/events/${event.id}/codes/${encodeURIComponent(code.code)}`, {
        method: "DELETE",
      });
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Revoca non riuscita.");
    } finally {
      setPending(false);
    }
  }

  return (
    <li data-status={code.status}>
      <div className="face-row">
        <span className="name">
          <code>{shown ? code.code : `${code.code.slice(0, 2)}••••••`}</code>{" "}
          <button className="linkish" type="button" onClick={() => setShown((value) => !value)}>
            {shown ? "Nascondi" : "Mostra"}
          </button>
        </span>
        <span className="badge">{STATUS_LABEL[code.status]}</span>
        <span className="meta">
          {code.uses} {code.uses === 1 ? "uso" : "usi"}
          {code.maxUses === null ? " · senza limite" : ` su ${code.maxUses}`}
          {code.expiresAt ? ` · scadenza ${formatWhen(code.expiresAt)}` : " · senza scadenza"}
        </span>
      </div>
      <div className="form-grid">
        <label>
          Etichetta
          <input type="text" value={label} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Usi massimi
          <input
            type="number"
            min={1}
            step={1}
            value={cap}
            placeholder="senza limite"
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions inline">
        <button
          className="button"
          type="button"
          disabled={pending}
          onClick={() =>
            void patch({
              label: label.trim() === "" ? null : label.trim(),
              maxUses: cap.trim() === "" ? null : Number(cap),
            })
          }
        >
          Salva
        </button>
        <button
          className="button"
          type="button"
          disabled={pending || code.uses === 0}
          title="Blocca il codice al numero di usi già fatti"
          onClick={() => void patch({ maxUses: code.uses })}
        >
          Chiudi agli usi fatti
        </button>
        <button className="button quiet" type="button" disabled={pending} onClick={() => void revoke()}>
          Revoca
        </button>
      </div>
    </li>
  );
}
