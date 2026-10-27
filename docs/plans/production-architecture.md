# Production architecture — tracking

Living checklist for the multi-stream rollout. Plan source: `.cursor/plans/production_architecture_rollout_8719c067.plan.md` (do not edit the plan file from agents; update this doc).

**Locked decisions:** [ADR-001](../adr/001-coolify-only-deploy.md) … [ADR-005](../adr/005-frontend-static.md).

| Stream | Owner | Branch prefix | Gate | Status |
|--------|-------|---------------|------|--------|
| S0 ADR + tracking | coordinator | — | ADR-002 accepted | done |
| S1 Edge | edge-infra | `feat/prod-arch/s1-edge` | No public MinIO/mail FQDN | done (docs + script) |
| S2 Storage API | storage-api | `feat/prod-arch/s2-storage` | E2E upload/gallery without S3 URLs | done (code; Coolify gate on deploy) |
| S3 Frontend static | frontend-static | `feat/prod-arch/s3-fe` | Staging flows on static apps | done (fotografi upload via `/v1/uploads/*`; edge sketch in infra-coolify; full Next→static cutover on ops) |
| S4 Redis | api-scale | `feat/prod-arch/s4-redis` | 2 API + burst limit | done (compose + limiters) |
| S5 Queue spike | worker-queue | `feat/prod-arch/s5-spike` | Written decision | done ([bullmq-spike.md](bullmq-spike.md)) |
| S6 SSO | auth-sso | `feat/prod-arch/s6-sso` | Staff OIDC on staging | done (routes + docs; IdP on host) |
| S7 Observability | observability | `feat/prod-arch/s7-obs` | Sentry test event | done (SDK + docs) |
| S8 Backup | backup-dr | `feat/prod-arch/s8-backup` | Restore drill | done (sidecar + docs; drill on ops) |
| S9 QA gate | qa-gate | `feat/prod-arch/s9-qa` | Runbook signed | done (runbook updated) |

## Merge order

S0 → S1 → S2 → S3; S4 after S1+S2; S6 after S4; S9 last.

## Risks

See plan file § Rischi (API upload bandwidth, Traefik timeouts, uploader dual support).
