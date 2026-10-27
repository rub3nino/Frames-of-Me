# ADR-005: Static frontends per surface

**Status:** Accepted (2026-10-27)

## Context

Production ships [apps/web](../../apps/web) (Next.js). New work lives in [frontend/](../../frontend/) as static apps with shared `packages/ui` and `api-client`.

## Decision

- Target deploy: static builds for landing, partecipanti, fotografi, admin on separate subdomains.
- Each host reverse-proxies `/v1/*` to the API (same-origin cookies).
- [apps/web](../../apps/web) is **deprecated for new features**; removed from production compose once S3 frontend gates pass.

## Consequences

- CI shifts from `docker compose build web` to static artifact builds when S3 stream completes.
- No secrets in frontend bundles; only public config.
