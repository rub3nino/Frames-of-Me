# Production runbook

## Required environment

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` enable the shared upload limiter. Without them the API falls back to PostgreSQL and remains safe, but the limit is less precise across multiple API replicas.
- Keep `S3_ENDPOINT` private. Set `S3_PUBLIC_ENDPOINT` only to the Cloudflare/CDN hostname used for signed browser URLs.
- Use `FACE_ENGINE=insightface` only after the face service health check and the consent/retention process have been verified.

## R2 lifecycle

Configure these rules in the R2 bucket (the provider owns the policy, not the application):

1. Abort incomplete multipart uploads after 1 day.
2. Expire objects under `selfies/` after the event retention window unless `KEEP_SELFIES` is explicitly enabled.
3. Keep `thumbs/` and `web/` behind the CDN with immutable cache headers.
4. Keep `originals/` private and serve them only through short-lived signed URLs.
5. Enable object versioning where the account plan supports it and retain a daily backup copy for the contractual retention period.

The worker also removes stale single-part objects and multipart uploads during housekeeping.

## GDPR operations

- Store the consent text version, timestamp, IP and user agent for every selfie search.
- A withdrawal must delete the selfie object, face anchors, query vector and participant gallery data.
- Run event retention before the contractual deadline and verify the deletion audit entries.
- Keep biometric data only for official photos; public photos must never create `faces`, `face_index` or vectors.
- Process photo reports through the admin moderation endpoint and retain the decision in the audit log.

## Release gate

Before opening an event to participants:

1. Run `pnpm test` and require zero failures.
2. Apply all migrations through `packages/db/src/migrate.ts`.
3. Confirm R2 lifecycle, backup restore and CDN signed URL behaviour in a staging event.
4. Confirm Upstash counters increment from two API replicas.
5. Verify a public upload never creates a face row or calls the face engine.
