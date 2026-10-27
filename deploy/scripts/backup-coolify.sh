#!/bin/sh
# Daily restic backup of Postgres volume snapshot path and MinIO data directory.
# Requires BACKUP_RESTIC_REPOSITORY and BACKUP_RESTIC_PASSWORD in the environment.
set -eu

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ]; then
  echo "backup-coolify: RESTIC_REPOSITORY and RESTIC_PASSWORD required; sleeping."
  sleep infinity
fi

restic snapshots >/dev/null 2>&1 || restic init

while true; do
  echo "backup-coolify: starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  restic backup /data/postgres /data/minio --tag coolify,frames-of-me
  restic forget --keep-daily 7 --keep-weekly 4 --prune
  echo "backup-coolify: done"
  sleep 86400
done
