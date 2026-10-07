#!/usr/bin/env bash
# Shared bits for deploy/scripts/*. Source it: `. "$(dirname "$0")/lib.sh"`.
# Resolves the deploy directory, the env file and the `docker compose` invocation.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPHOTO_ENV_FILE:-$DEPLOY_DIR/.env.production}"

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" --env-file "$ENV_FILE" "$@"
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "env file not found: $ENV_FILE (copy .env.production.example and run gen-secrets.sh)" >&2
    exit 1
  fi
}

# Reads KEY=value from the env file (first match, no interpolation). Usage: env_value KEY
env_value() {
  local line
  line="$(grep -E "^${1}=" "$ENV_FILE" | head -n1 || true)"
  printf '%s' "${line#*=}"
}

log() {
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}
