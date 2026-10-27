# Backup off-site (Coolify stack)

Enable the `backup` profile in [docker-compose.coolify.yml](../../docker-compose.coolify.yml):

```bash
docker compose -f docker-compose.coolify.yml --profile backup up -d backup
```

## Coolify variables

| Variable | Purpose |
|----------|---------|
| `BACKUP_RESTIC_REPOSITORY` | e.g. `s3:https://account.r2.cloudflarestorage.com/bucket/backups` |
| `BACKUP_RESTIC_PASSWORD` | Restic encryption password |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | Credentials for the repository (if S3-compatible) |

## Restore drill (staging gate S8)

1. `restic snapshots` on the repository.
2. `restic restore latest --target /tmp/restore-test`.
3. Document checksum and date in your ops log.

See also [docs/DPIA.md](../DPIA.md) for retention alignment.
