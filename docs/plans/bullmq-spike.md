# Spike: Postgres `jobs` vs BullMQ (S5)

**Status:** Recommendation — stay on Postgres for MVP production.

## Comparison

| Criterion | Postgres `jobs` | BullMQ + Redis |
|-----------|-----------------|----------------|
| Ops | Already deployed | Requires Redis (now added for limits) |
| Priorities | SQL `ORDER BY` in claim | Native queue priorities |
| Observability | `jobs` table + admin metrics | Bull Board / Redis metrics |
| Retry / DLQ | Application logic in worker | Built-in attempts |
| Migration cost | Zero | Dual-write or cutover |

## Decision

Keep **Postgres** until staging load tests show claim latency or lock contention blocking event throughput. Revisit after the first full-scale dress rehearsal (`scripts/loadtest/` + `status.sh` patterns on Coolify).

If migrating later: preserve job type names and payloads in `@rephoto/contracts`; add ADR-006 for upload-worker if API bandwidth becomes the bottleneck.
