#!/usr/bin/env bash
# Fills every `GENERATE` placeholder of an env file with random secrets.
#
#   ./scripts/gen-secrets.sh [.env.production]
#
# - POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD: 32 url-safe chars
# - SESSION_SECRET: 48 url-safe chars
# - STATUS_BASIC_AUTH_HASH: bcrypt of a random password printed ONCE on stderr (write it in the
#   password manager); `$` are doubled so compose interpolation leaves the hash intact.
# Values already set (not GENERATE) are left alone, so the script is safe to re-run.
# The provider SMTP password (GENERATE_AT_PROVIDER) is not touched: it comes from the provider.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

target="${1:-$ENV_FILE}"
if [[ ! -f "$target" ]]; then
  echo "env file not found: $target (cp .env.production.example .env.production first)" >&2
  exit 1
fi

random_token() {
  # $1 = bytes of entropy; url-safe base64 without padding.
  openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'
}

set_if_generate() {
  local key="$1" value="$2"
  if grep -qE "^${key}=GENERATE$" "$target"; then
    # `|` is not in the alphabet of the generated values; `\` and `&` are escaped for sed.
    local escaped
    escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
    sed -i.bak -E "s|^${key}=GENERATE$|${key}=${escaped}|" "$target"
    rm -f "$target.bak"
    log "set $key"
  else
    log "keep $key (already set)"
  fi
}

set_if_generate POSTGRES_PASSWORD "$(random_token 24)"
set_if_generate MINIO_ROOT_PASSWORD "$(random_token 24)"
set_if_generate SESSION_SECRET "$(random_token 36)"

if grep -qE '^STATUS_BASIC_AUTH_HASH=.*GENERATE' "$target"; then
  status_password="$(random_token 18)"
  if command -v caddy >/dev/null 2>&1; then
    hash="$(caddy hash-password --plaintext "$status_password")"
  else
    hash="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$status_password")"
  fi
  # Compose reads `$$` as a literal `$`.
  escaped_hash="${hash//\$/\$\$}"
  sed -i.bak -E "s|^STATUS_BASIC_AUTH_HASH=.*$|STATUS_BASIC_AUTH_HASH=${escaped_hash}|" "$target"
  rm -f "$target.bak"
  log "set STATUS_BASIC_AUTH_HASH"
  printf '\nstatus.<domain> basic auth password (shown once, store it now):\n  %s\n\n' "$status_password" >&2
else
  log "keep STATUS_BASIC_AUTH_HASH (already set)"
fi

if grep -qE '=GENERATE' "$target"; then
  log "remaining placeholders (fill by hand):"
  grep -nE '=GENERATE' "$target" >&2
fi
chmod 600 "$target"
log "done: $target"
