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

## v4 report — go-live gate (security & load)

The v4 load/security report left concrete blockers. Work them in this order; the
first three are hard gates — do not open an event until each is green.

### 1. F05 — liveness must be enforced (CRITICAL, privacy)

A selfie match hands the requester every photo of the matched person, so it has to
be gated on a liveness verdict the server actually produced. The code now fails
closed when `LIVENESS_REQUIRED=true` (a missing model, an unavailable service or a
non-live verdict all reject), but that only works if the model is present:

- [ ] Set `LIVENESS_CHECK=true` and `LIVENESS_REQUIRED=true`.
- [ ] Install the anti-spoofing model weights in the `face-service` container and
      confirm `POST /v1/liveness` returns a `method` other than `"none"`. With
      `LIVENESS_REQUIRED` on and no model, **every** match is (correctly) refused.
- [ ] Smoke test: a selfie that is a photo-of-a-photo must get an empty gallery
      (reason `liveness`), a live selfie must return matches.

Residual risk, accepted and tracked: this is **passive** anti-spoofing. A motivated
attacker presenting the victim's photo to a camera with a weak model can still pass.
The real fix is challenge-response liveness (server-issued nonce + verified
motion/blink); until it ships, keep `LIVENESS_REQUIRED=true` and a good model.

### 2. Schema / migrations — closes B1 (web-first upload 500)

The v4 500 on completing a public web-first upload was migration drift on the box
(a public photo has a null `photographer_id`). Prevent it:

- [ ] Run `db:migrate`, then `deploy/scripts/verify-schema.sh`. It must print
      `schema OK` (checks nullable `photographer_id`, the moderation table, the
      `consents_active_unique` index from migration 013, and that every migration
      file is recorded). Do not proceed on any `FAIL`.

### 3. F10 — close the internal-host exposure (host-side, not in this repo)

The compose already publishes internal services with `expose:` (compose network
only). The exposure the report found comes from the host, so fix it there:

- [ ] Bind any Docker-published port to loopback / the internal interface; nothing
      internal (MinIO, Mailpit, Coolify) should be reachable over Tailscale/LAN.
- [ ] Put Cloudflare Access in front of **every** internal host (`coolify.`, `mail.`,
      `s3.`) and verify a Host-header request without Access is refused.
- [ ] Re-check UFW still blocks the Docker-published ports from the Tailscale subnet.

### 4. Capacity — pre-index before the event

Indexing runs at ~0.4 photo/s per node (≈104 h for 150k photos); match jobs already
take queue priority (`JOB_PRIORITY.match = 0`), but a long in-flight index job and
shared face-service CPU still slow interactive search during ingest.

- [ ] Ingest and index the full back catalogue **before** opening to participants.
- [ ] Raise `WORKER_CONCURRENCY` and the face-service CPUs/replicas to taste, then
      re-measure; scaling is roughly linear to the node's CPU limit.
- [ ] Watch `deploy/scripts/status.sh` during the ramp (queue age, match p50/p95).

### 5. Still owed from v4 (need the live box / a bridge host online)

- [ ] SQL read-only checks §4.1 (orphans/cascade, `selfies/` prefix, embeddings vs
      photos) once the DB is reachable.
- [ ] Real origin load test at high concurrency via the LAN/Tailscale path (the
      single-IP test through Cloudflare only measured the edge, not the origin).
- [ ] Delete the temporary access key (`rm ~/.rpk_id ~/.rp-*`) and the ~600 synthetic
      test images left on the server.
- [ ] B3 (close-ups 0/18): tune `FACE_DET_SIZE` / the min face size against the test
      images and re-measure detection recall.
