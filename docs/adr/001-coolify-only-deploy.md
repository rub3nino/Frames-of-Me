# ADR-001: Deploy Coolify-only

**Status:** Accepted (2026-10-27)

## Context

Production currently builds from this monorepo via [docker-compose.coolify.yml](../../docker-compose.coolify.yml) (Cloudflare Tunnel → Traefik). An alternate stack lives in [deploy/compose.yml](../../deploy/compose.yml) (single VPS + Caddy).

## Decision

- **Target production** is Coolify + Cloudflare Tunnel only.
- [deploy/](../../deploy/) remains in the repo for reference, load-test scripts, and emergency restore patterns, but is **not** the architecture target for new work.
- New infra docs and compose changes land in the Coolify path first.

## Consequences

- Runbooks must describe Tunnel/Traefik, not Caddy `media.DOMAIN`.
- Event-scale sizing docs in [docs/infra.md](../infra.md) stay valid for capacity; edge topology references Coolify.
