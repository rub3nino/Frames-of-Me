# Coolify + Cloudflare production edge

Operational topology for the **Coolify-only** deploy ([ADR-001](adr/001-coolify-only-deploy.md)). Compose file: [docker-compose.coolify.yml](../docker-compose.coolify.yml).

## Public hostnames (internet via Cloudflare Tunnel)

| Host | Service | Notes |
|------|---------|--------|
| `framesofme.com`, `www` | static / web | Traefik → port 3000 until static frontends replace Next |
| `app.framesofme.com` | partecipanti (future) | `/v1/*` → API |
| `foto.framesofme.com` | fotografi (future) | `/v1/*` → API |
| `admin.framesofme.com` | admin | Cloudflare Access recommended |
| `api.framesofme.com` | API | Direct API host; apps may also proxy `/v1` on app hosts |

## Must NOT be public

| Host | Reason |
|------|--------|
| `s3.*` / MinIO | [ADR-002](adr/002-media-via-api.md): objects only via API |
| `mail.*` / Mailpit | Dev/test only; production uses SMTP provider (no public UI) |
| Postgres, Redis, face-service | Compose `expose` only |
| Coolify UI | Tailscale and/or Cloudflare Access |

## Required Coolify environment variables

- `S3_APP_SECRET_KEY` — required (v6 H3); see [RUN.md](../RUN.md).
- `WEB_ROUTER_NAME`, `WEB_DOMAIN` — Traefik router uniqueness (prod vs staging).
- `TRUSTED_PROXY_HOPS=2` — Cloudflare + Traefik.
- Do **not** set `S3_PUBLIC_ENDPOINT` in production.

## Cloudflare checklist

1. DNS proxied (orange cloud) for all public app hostnames.
2. WAF managed ruleset enabled.
3. Rate limiting rules on `/v1/auth/*` and `/v1/*/selfie`.
4. Access policies on `admin.*`, Coolify, any remaining internal UI.

## Post-deploy verification

Run [scripts/ops/check-host-exposure.sh](../scripts/ops/check-host-exposure.sh) on the host (Tailscale SSH). See [production-runbook.md](production-runbook.md) § F10.

## Static frontend apps (S3) — edge sketch

When `apps/partecipanti`, `apps/fotografi`, or `apps/admin` replace the Next `web` container, each
subdomain serves **static files** (Vite `dist/`) and proxies API traffic on the same host:

```caddyfile
# Example: foto.framesofme.com (fotografi SPA)
foto.framesofme.com {
  handle /v1/* {
    reverse_proxy api:8787
  }
  handle {
    root * /srv/fotografi
    try_files {path} /index.html
    file_server
  }
}
```

Nginx equivalent: `location /v1/ { proxy_pass http://api:8787; }` plus `try_files $uri /index.html`
for the SPA root. Coolify can map each app host to a small Caddy/nginx sidecar or Traefik labels
with the same split. Session cookies stay same-origin because `/v1` and the app share the hostname
([frontend/DEPLOY.md](../frontend/DEPLOY.md)).
