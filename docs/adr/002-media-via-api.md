# ADR-002: Object storage via API (no public bucket)

**Status:** Accepted (2026-10-27)

## Context

Browsers today upload and download via presigned URLs against `S3_PUBLIC_ENDPOINT` (e.g. `s3.framesofme.com`). That exposes the object store hostname on the public internet.

## Decision

- **Production:** do not set `S3_PUBLIC_ENDPOINT`. MinIO is reachable only on the Compose network.
- Uploads use **same-origin API routes** (`PUT /v1/uploads/:id/object`, multipart via `PUT /v1/uploads/:id/parts/:partNumber`).
- Reads use **API media routes** (`GET /v1/media/...`) with session authorization; JSON responses carry relative `/v1/media/...` URLs instead of presigned S3 URLs.
- **Staging/dev** may still set `S3_PUBLIC_ENDPOINT` for legacy direct-MinIO testing.

## Consequences

- API bandwidth and CPU become the upload path; scale API replicas (see ADR-004) and consider upload-worker (ADR-006) if metrics require it.
- Traefik/Coolify timeouts on upload routes must allow large bodies (≤ 70 MB).
- [CONTRACTS.md](../../CONTRACTS.md) documents presigned URLs; this ADR adds an operational mode where `url` in init responses points at the API, not S3.
