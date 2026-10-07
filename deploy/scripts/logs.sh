#!/usr/bin/env bash
# Tails the stack logs (json-file driver, 50 MB × 5 per container).
#
#   ./scripts/logs.sh                 # every service, last 200 lines, follow
#   ./scripts/logs.sh worker          # one or more services
#   ./scripts/logs.sh --since 1h api  # any `docker compose logs` option before the services
#   ./scripts/logs.sh access          # Caddy access log (JSON lines) from the caddy_logs volume
set -euo pipefail

. "$(dirname "$0")/lib.sh"
require_env_file

if [[ "${1:-}" == "access" ]]; then
  shift
  exec compose exec caddy tail -n 200 -f /var/log/caddy/access.log "$@"
fi

exec compose logs --tail=200 --follow --timestamps "$@"
