# Frames of Me — Frontend

The front-end of Frames of Me, organized as **four independently deployable apps** that share one
design system and one API client, all talking to the existing backend (`../apps/api`).

> This replaces the old `design/` folder. The visual system (the Apple→Notion look, the
> Instrument-Serif landing) now lives in `packages/ui`; each surface is its own app.

## Why this shape (the architecture decision)

We separate by **surface**, not by git branch. Branches track *time* (versions in progress);
they are the wrong tool for separating *space* (surfaces that ship on their own cadence). Four
long-lived branches would duplicate the design system + API client and force a merge on every
shared change. Instead:

- **One repo, one `main`.** All four apps live here and share `packages/ui` + `packages/api-client`.
- **Independent deploys.** CI deploys only the app whose files changed (path filter), each to its
  own subdomain. See [`DEPLOY.md`](DEPLOY.md).
- **The landing stays "frozen"** by being a separate, static deploy target you simply don't
  re-trigger — not a frozen branch.

## Layout

```
frontend/
├─ packages/
│  ├─ ui/            ← design system: tokens, base, components, motion, landing.css,
│  │                   logo/mark, assets (ph-* + real photos), DESIGN.md, styleguide
│  └─ api-client/    ← one typed fetch client for ../../apps/api (auth, event, selfie,
│                      gallery, uploads, admin). Every app imports this.
├─ apps/
│  ├─ landing/       → framesofme.com        · static marketing page (serif + pastel). DONE, deploy-ready.
│  ├─ partecipanti/  → app.framesofme.com     · guest flow (iscrizione·selfie·galleria·consenso minori)
│  ├─ fotografi/     → foto.framesofme.com    · photographer portal (upload·album·copertura·…)
│  └─ admin/         → admin.framesofme.com   · staff console (dashboard·gdpr·cms·…)
├─ emails/           ← transactional email templates (sent by the API/worker)
└─ _reference/       ← kept for reference, not shipped (old conference "vetrina" pages)
```

Today `apps/landing` is a real static app wired to the backend (email → `requestLink`). The other
three folders currently hold the **design prototype** (static HTML) as the visual contract; they
are being ported to real apps that **reuse the working logic of `../apps/web`** (magic-link auth,
selfie + liveness, gallery, resumable upload, admin) under the new design system. See the roadmap
below.

## How a surface talks to the backend

Each app is served behind a reverse proxy that routes `/v1/*` to the API, so from the browser the
API is **same-origin** (cookies just work). `packages/api-client` defaults to `/v1`. Locally you
either run the app behind the Next dev proxy or set `globalThis.REPHOTO_API_BASE`. Details and the
CORS note are in [`DEPLOY.md`](DEPLOY.md).

## Roadmap

- **Phase 1 — foundation (done):** rename + workspace, `packages/ui`, `packages/api-client`,
  `apps/landing` wired & deploy-ready, docs.
- **Phase 2 — partecipanti:** port the guest flow to a real app (reuse `apps/web` logic), wired end
  to end (request-link → verify → consent → selfie → gallery → download), incl. the minors path.
- **Phase 3 — fotografi:** port the photographer portal (resumable upload, albums, coverage, stats).
- **Phase 4 — admin:** port the admin console (metrics, events CMS, GDPR/minors, …).

Target state and the new endpoints these need are in [`../docs/analysis/`](../docs/analysis/README.md).

## Local preview (design prototype)

```bash
cd frontend && python3 -m http.server 4599
```
- Landing: http://localhost:4599/apps/landing/index.html
- Style guide: http://localhost:4599/packages/ui/styleguide.html
- Prototype surfaces: `apps/partecipanti/…`, `apps/fotografi/…`, `apps/admin/…`
