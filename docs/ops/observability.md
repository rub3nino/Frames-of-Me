# Observability

## Sentry

Set `SENTRY_DSN` (and optional `SENTRY_ENVIRONMENT`) on **api** and **worker** in Coolify. The API initialises Sentry at boot when the DSN is present.

Frontend: inject `SENTRY_DSN` at build time for static apps (public DSN only).

## Logs

Containers use Docker `json-file` logging. Ship logs via your host agent (Vector, Promtail) to Loki — Tailscale-only Grafana recommended.

## Wazuh

Install the Wazuh agent on the Coolify host; manager reachable only on Tailscale. Monitor Docker socket events and SSH logins.

## Alerts

- API `/health` and `/v1/health`
- Worker: queue depth via `/v1/admin/metrics` (`jobsByType`, `oldestQueuedSeconds`)
- Face-service breaker logs (`breaker: "open"`)
