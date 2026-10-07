#!/usr/bin/env bash
# Restores a backup made by the `backup` service: pg_restore of one dump into the running
# Postgres, then `mc mirror` of /backup/objects/<bucket> back into MinIO.
#
#   ./scripts/restore.sh                       # latest dump in BACKUP_DIR/postgres
#   ./scripts/restore.sh rephoto-20261007-033000.dump
#   ./scripts/restore.sh --yes <dump>          # no interactive confirmation
#
# api and worker are stopped during the restore (sessions and the job queue are in the dump)
# and started again at the end. Objects not in the local copy stay in the bucket: the
# mirror back is additive (it never deletes), so a restore after a bad purge is safe.
set -euo pipefail

. "$(dirname "$0")/lib.sh"
require_env_file

# `backup` may be stopped (e.g. a restore test on a fresh host): exec into it when running,
# otherwise run a one-off container with the same volumes.
if compose ps --status running --services | grep -qx backup; then
  backup_sh() { compose exec -T backup "$@"; }
else
  backup_sh() { compose run --rm -T --entrypoint "" backup "$@"; }
fi

YES="false"
DUMP=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES="true" ;;
    *) DUMP="$arg" ;;
  esac
done

if [[ -z "$DUMP" ]]; then
  DUMP="$(backup_sh sh -c 'ls -1 /backup/postgres/rephoto-*.dump 2>/dev/null | sort | tail -n1' | tr -d '\r')"
  [[ -n "$DUMP" ]] || { echo "no dump found in BACKUP_DIR/postgres" >&2; exit 1; }
fi
case "$DUMP" in
  /*) ;;
  *) DUMP="/backup/postgres/$DUMP" ;;
esac

log "dump: $DUMP"
backup_sh sh -c "ls -lh '$DUMP'"

if [[ "$YES" != "true" ]]; then
  read -r -p "This DROPS and recreates every table in $(env_value POSTGRES_DB) and overwrites bucket objects. Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || { echo "aborted"; exit 1; }
fi

log "stopping api and worker"
compose stop api worker

log "restoring"
backup_sh rephoto-backup restore "$DUMP"

log "starting api and worker (they re-run migrations at boot)"
compose up -d api worker
compose ps api worker

log "done. Check: curl -fsS https://$(env_value DOMAIN)/v1/health"
