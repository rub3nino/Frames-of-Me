# ADR-004: Redis for cross-replica limits; Postgres jobs until metrics say otherwise

**Status:** Accepted (2026-10-27)

## Context

Job processing uses Postgres `jobs`. API rate limits are partly in-process (broken with multiple replicas). Optional Upstash REST exists for crowd burst only.

## Decision

- **Redis (private network)** is required before running **≥2 API replicas** in production.
- Use Redis for distributed rate limiting (piece C) and any shared counters; prefer `REDIS_URL` on the private network over Upstash when self-hosted.
- **Job queue** stays on Postgres until [ADR-005 spike](../plans/bullmq-spike.md) (stream S5) proves BullMQ is worth the migration.

## Consequences

- [docker-compose.coolify.yml](../../docker-compose.coolify.yml) includes a Redis service.
- [docs/production-runbook.md](../production-runbook.md) drops permanent “single API replica” guidance once piece C is done.
