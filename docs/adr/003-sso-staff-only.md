# ADR-003: SSO for staff; magic link for participants

**Status:** Accepted (2026-10-27)

## Context

Authentication is magic-link + session cookie for all roles. Enterprise ops want IdP separated from the app.

## Decision

- **Staff / admin / photographers (console):** OIDC via an IdP reachable only on Tailscale (e.g. Authentik). API validates JWT or uses OIDC code flow on dedicated routes.
- **Event participants:** unchanged — magic link, consent, GDPR flows.
- **Break-glass:** documented magic-link path for admins if IdP is down.

## Consequences

- No IdP secrets in static frontends; only public OIDC client ids where required.
- Cloudflare Access may additionally guard `admin.*` hostnames.
