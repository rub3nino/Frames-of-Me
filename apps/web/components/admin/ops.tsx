"use client";

import { useEffect, useState } from "react";
import type { AdminOpsLinksResponse, OpsLink } from "@/lib/types";
import { ApiError, api } from "@/lib/api";

/**
 * v6 D (agent D): operations — a plain page of external links read from the environment
 * (`OPS_LINK_RESEND`, `OPS_LINK_POSTHOG`, `OPS_LINK_SENTRY`, `OPS_LINK_COOLIFY`,
 * `OPS_LINK_AUTHENTIK`, `OPS_LINK_R2`).
 *
 * Links only, by decision (spec section D): no API integration mirrors those dashboards
 * here. Each one is a dashboard with its own alerts and its own access control; a copy of
 * it inside this console would be a second source of truth and a second set of secrets.
 */
export function OpsSection() {
  const [links, setLinks] = useState<OpsLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    api<AdminOpsLinksResponse>("/v1/admin/ops-links")
      .then((data) => {
        if (!cancel) setLinks(data.links);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(cause instanceof ApiError ? cause.message : "Lettura non riuscita.");
      });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <section className="block">
      <h2>Operazioni</h2>
      <p className="fine">
        Collegamenti ai pannelli esterni, presi dalle variabili <code>OPS_LINK_*</code>. Solo
        collegamenti: i dati restano nei rispettivi pannelli.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {links === null && !error ? <p className="status">Caricamento</p> : null}
      {links && links.length === 0 ? (
        <p className="note">
          Nessun collegamento configurato. Imposta <code>OPS_LINK_RESEND</code>,{" "}
          <code>OPS_LINK_POSTHOG</code>, <code>OPS_LINK_SENTRY</code>, <code>OPS_LINK_COOLIFY</code>,{" "}
          <code>OPS_LINK_AUTHENTIK</code>, <code>OPS_LINK_R2</code> nell&apos;ambiente dell&apos;api.
        </p>
      ) : null}
      {links && links.length > 0 ? (
        <ul className="list open-links">
          {links.map((link) => (
            <li key={link.key}>
              <a className="linkish" href={link.url} target="_blank" rel="noreferrer noopener">
                {link.label}
              </a>
              <span className="meta link-text">{link.url}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
