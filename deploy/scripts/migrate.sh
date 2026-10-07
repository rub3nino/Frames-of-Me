#!/usr/bin/env bash
# Applies pending SQL migrations (packages/db/migrations) with a one-off api container.
#
#   ./scripts/migrate.sh
#
# Not needed in the normal flow: api and worker run `migrate()` under an advisory lock at
# boot. Use it to migrate BEFORE rolling a new image (`docker compose build` then this, then
# `up -d`), or to apply a migration while api/worker are stopped.
set -euo pipefail

. "$(dirname "$0")/lib.sh"
require_env_file

log "running migrations with image rephoto-api:$(env_value IMAGE_TAG)"
# WORKDIR of the api image is /app/apps/api; the migrator lives in the shared packages tree.
compose run --rm --no-deps --entrypoint node api \
  --import tsx /app/packages/db/src/migrate.ts
log "done"
