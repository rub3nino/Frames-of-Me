# Staff SSO (Authentik on Tailscale)

[ADR-003](../adr/003-sso-staff-only.md): participants keep magic link; staff use OIDC.

## Deployment

1. Run **Authentik** on a host reachable only via **Tailscale** (no public admin UI).
2. Create an OAuth2/OIDC provider and application for Frames of Me staff.
3. Set redirect URI to `https://api.framesofme.com/v1/auth/staff/callback` (or your API host).

## API environment (Coolify)

Set all of:

- `STAFF_OIDC_AUTHORIZE_URL`
- `STAFF_OIDC_TOKEN_URL`
- `STAFF_OIDC_CLIENT_ID`
- `STAFF_OIDC_CLIENT_SECRET`
- `STAFF_OIDC_REDIRECT_URL`
- `STAFF_OIDC_ISSUERS` — comma-separated allowed `iss` values from the IdP

Alternatively, **Google Workspace** remains supported via existing `GOOGLE_*` variables (`/v1/auth/google/start`).

## Break-glass

Keep magic-link admin access documented and rate-limited; use only when IdP is unavailable.
