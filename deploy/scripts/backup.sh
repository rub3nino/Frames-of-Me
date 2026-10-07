#!/usr/bin/env bash
# Runs one backup now (pg_dump -Fc + mc mirror of the bucket) through the `backup` service,
# then lists what is in BACKUP_DIR. The daily run happens on its own inside that container.
#
#   ./scripts/backup.sh
set -euo pipefail

. "$(dirname "$0")/lib.sh"
require_env_file

backup_dir="$(env_value BACKUP_DIR)"
log "backup → ${backup_dir:-<BACKUP_DIR unset>}"

if compose ps --status running --services | grep -qx backup; then
  compose exec backup rephoto-backup once
else
  compose run --rm backup once
fi

log "dumps:"
compose exec backup sh -c 'ls -lh /backup/postgres/ 2>/dev/null || true'
log "last-ok: $(compose exec backup sh -c 'cat /backup/last-ok 2>/dev/null || echo never')"
