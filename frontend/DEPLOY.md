# RePhoto frontend — deploy & backend wiring

Four apps, one `main`, independent deploys per subdomain. Nobody develops on per-surface branches;
CI decides what to ship from `main`.

## Domains (proposed)

| App | Subdomain | Kind | Cadence |
| --- | --- | --- | --- |
| `apps/landing` | `rephoto.it` (+ `www`) | static (CDN) | rare — "frozen" |
| `apps/partecipanti` | `app.rephoto.it` | dynamic (SSR/SPA) | frequent during the event |
| `apps/fotografi` | `foto.rephoto.it` | dynamic | frequent during the event |
| `apps/admin` | `admin.rephoto.it` | dynamic | as needed |
| backend | `api.rephoto.it` | `../apps/api` | — |

Each app's host (or a shared edge/reverse proxy) routes **`/v1/*` → the API** so the browser sees
the API as same-origin and the session cookie (`rephoto_session`, httpOnly, SameSite=Lax) works
without CORS. This is why `packages/api-client` defaults to `/v1`.

## Independent deploys from `main` (the right version of "a branch per surface")

CI triggers a deploy **only for the app whose files changed**, using path filters:

```yaml
# .github/workflows/deploy.yml (sketch)
on: { push: { branches: [main] } }
jobs:
  changes:
    # dorny/paths-filter → outputs: landing, partecipanti, fotografi, admin, ui, api-client
  landing:
    needs: changes
    if: needs.changes.outputs.landing == 'true' || needs.changes.outputs.ui == 'true'
    steps: [ build apps/landing, deploy to the landing CDN target ]
  partecipanti:
    if: needs.changes.outputs.partecipanti == 'true' || needs.changes.outputs.ui == 'true' || needs.changes.outputs.api-client == 'true'
    steps: [ build, deploy to app.rephoto.it ]
  # …fotografi, admin the same way
```

- A change under `apps/landing/**` (rare) redeploys only the landing.
- A change under `packages/ui/**` or `packages/api-client/**` redeploys the apps that use it —
  which is exactly what you want (shared code stays consistent), and is precisely what 4 separate
  branches would make painful.
- **"Landing nobody touches":** protect `apps/landing/**` and `packages/ui/**` with `CODEOWNERS`
  + branch protection, and deploy the landing to a CDN once; it isn't redeployed unless those paths
  change.

### If the server wants branch-based deploys (git-pull)

Keep development on `main`; let CI **fast-forward** deploy-only branches:
`deploy/landing`, `deploy/partecipanti`, `deploy/fotografi`, `deploy/admin`. The server pulls its
branch. The branches never diverge (CI owns them), so there is no merge hell.

## Local development

Run each app behind the existing Next dev proxy (which already forwards `/v1/*` to the API on
`:8787`), or point the client at the API directly:

```js
// before importing the client, for a pure-static preview:
globalThis.REPHOTO_API_BASE = "http://localhost:8787/v1";
```

Cross-origin note: a pure-static origin (e.g. the `python -m http.server` preview on `:4599`)
cannot read credentialed cross-origin responses without CORS on the API. That is fine for the
prototype (the landing degrades gracefully). In every real deploy the app is same-origin with
`/v1` via the proxy, so there is no CORS and cookies work. Do **not** add wildcard CORS to the API;
use the proxy.

Backend bring-up is in [`../RUN.md`](../RUN.md) (Postgres on 5433, API 8787, web 3010, Mailpit 8025,
`FACE_ENGINE=fake`).

## Backend contract the apps rely on

`packages/api-client` wraps the real routes (see [`../CONTRACTS.md`](../CONTRACTS.md)):
`POST /v1/auth/request-link|verify|logout`, `GET /v1/events/:slug`, `POST …/consent|selfie`,
`GET …/gallery`, `POST …/gallery/download|zip`, `POST /v1/uploads/init|:id/parts|:id/complete`,
`GET /v1/uploads/summary`, `GET /v1/admin/metrics|events`, … New endpoints the ported surfaces will
need (event create/list, minors/guardian consent, albums/coverage/embargo, admin lists) are
specified in [`../docs/analysis/`](../docs/analysis/README.md) and get added to the API additively.

## CI/CD

Two GitHub Actions workflows implement the "independent deploys from one `main`" model above:

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| **CI** | [`.github/workflows/frontend-ci.yml`](../.github/workflows/frontend-ci.yml) | PR + push on `frontend/**` | Build-check each **changed** app. The three Vite SPAs run `npm ci \|\| npm install` + `npm run build` (Node 20) and must produce `dist/index.html`; landing just asserts `index.html` exists. A broken build fails the PR. |
| **Deploy** | [`.github/workflows/frontend-deploy.yml`](../.github/workflows/frontend-deploy.yml) | push to `main` on `frontend/**` | Per-app deploy jobs, each gated by a path filter so **only the changed app ships**. Landing publishes static files; the SPAs build then upload `dist/`. One `concurrency` group per app so deploys never overlap. |

### Path-filter model (what triggers what)

Both workflows use [`dorny/paths-filter`](https://github.com/dorny/paths-filter) to map changed files → affected apps:

- `apps/landing/**` → **landing** only.
- `apps/partecipanti/**` / `apps/fotografi/**` / `apps/admin/**` → that SPA only.
- `packages/ui/**` (the design system / CSS) → **all four** apps (landing included).
- `packages/api-client/**` (the typed fetch client) → the **three SPAs** (landing doesn't use it).

So a shared-package change fans out to exactly the apps that consume it, and an app-only change ships just that app — the whole point of not using one branch per surface.

**"Landing is frozen" = just don't change its files.** There is no frozen branch and no special lock: because deploys are path-gated, landing is only ever rebuilt/redeployed when `apps/landing/**` or `packages/ui/**` actually change. Leave those paths alone (optionally guard them with `CODEOWNERS` + branch protection) and landing stays put. Nothing to "re-trigger".

### Build/prod notes

- The build is **origin-agnostic**: `packages/api-client` defaults to `/v1`, and in prod a reverse proxy routes `/v1/*` → `api.rephoto.it` (same-origin, so the `rephoto_session` cookie works without CORS). There is **no build-time API URL** to set — do not bake an absolute API origin into the bundle. (`API_PROXY_TARGET` only matters for the local Vite dev proxy, not the production build.)
- Each app is standalone (its own `package.json` + lockfile, not a root npm workspace). Vite still bundles the shared packages via the `@ui`/`@api` aliases + `server.fs.allow` already set in each `vite.config.ts`.

### Secrets to set (repo → Settings → Secrets and variables → Actions)

The deploy steps are clearly-marked **TODO placeholders** (an rsync-over-ssh sketch and an `upload-artifact` sketch — pick one per app). Before they do anything real, set:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | SSH host of the server/edge serving the static roots. |
| `DEPLOY_USER` | SSH user for rsync/scp. |
| `DEPLOY_KEY` | Private SSH key (PEM) for `DEPLOY_USER`. |

Per-app document roots are the `DEPLOY_PATH` env in each deploy job (e.g. `/srv/www/app.rephoto.it`); adjust them to your server layout, or swap the rsync step for your CDN/host provider's own action (Cloudflare Pages, S3+CloudFront, Netlify, …). Subdomain mapping is `rephoto.it` (landing), `app.` (partecipanti), `foto.` (fotografi), `admin.` (admin).
