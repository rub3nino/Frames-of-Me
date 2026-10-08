#!/usr/bin/env bash
# Read-only pre-go-live schema check. Asserts the invariants whose absence produced
# the v4 report's B1 (a web-first *public* upload 500ing on complete because a migration
# had not landed on the box), and confirms the consent uniqueness from migration 013.
# Run it after `db:migrate`, before opening to participants:
#
#   ./scripts/verify-schema.sh
#
# Exits 0 when every check passes, 1 otherwise. Needs only `docker compose` (psql runs
# inside the postgres container). It changes nothing.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

require_env_file
PGUSER_="$(env_value POSTGRES_USER)"
PGDB_="$(env_value POSTGRES_DB)"

psql_q() {
  compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -X -A -t -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || echo ""
}

fail=0
check() {
  # check "<description>" "<sql returning 1 when healthy>"
  local desc="$1" sql="$2" got
  got="$(psql_q "$sql")"
  if [[ "$got" == "1" ]]; then
    printf '  ok   %s\n' "$desc"
  else
    printf '  FAIL %s\n' "$desc"
    fail=1
  fi
}

log "verifying schema on $PGDB_"

# B1 root cause: public photos/sessions have an uploader but no official photographer,
# so these columns MUST be nullable (migration 012). A not-null column here 500s the
# complete of every public web-first upload.
check "photos.photographer_id is nullable" \
  "select 1 from information_schema.columns where table_name='photos' and column_name='photographer_id' and is_nullable='YES'"
check "upload_sessions.photographer_id is nullable" \
  "select 1 from information_schema.columns where table_name='upload_sessions' and column_name='photographer_id' and is_nullable='YES'"

# Columns the web-first + public path writes (migrations 009/010) and moderation (011).
check "photos.uploader_id exists" \
  "select 1 from information_schema.columns where table_name='photos' and column_name='uploader_id'"
check "photos.collection exists" \
  "select 1 from information_schema.columns where table_name='photos' and column_name='collection'"
check "photos.original_status exists" \
  "select 1 from information_schema.columns where table_name='photos' and column_name='original_status'"
check "photo_moderation table exists" \
  "select 1 from information_schema.tables where table_name='photo_moderation'"

# Consent idempotency (migration 013, v4 report S4): one active consent per participant/event.
check "consents_active_unique index exists" \
  "select 1 from pg_indexes where indexname='consents_active_unique'"
check "no duplicate active consents remain" \
  "select case when count(*)=0 then 1 else 0 end from (
     select user_id, event_id from consents where withdrawn_at is null
     group by 1,2 having count(*) > 1
   ) d"

# Every migration file on disk has been recorded as applied.
expected="$(ls "$DEPLOY_DIR/../packages/db/migrations"/*.sql 2>/dev/null | xargs -n1 basename | sort | tr '\n' ' ')"
applied="$(psql_q "select id from schema_migrations order by id" | sort | tr '\n' ' ')"
if [[ -n "$expected" && "$expected" == "$applied" ]]; then
  printf '  ok   all migrations applied\n'
else
  printf '  FAIL migrations differ\n       on disk: %s\n       applied: %s\n' "$expected" "$applied"
  fail=1
fi

if [[ "$fail" == "0" ]]; then
  log "schema OK"
else
  log "schema check FAILED — do not open to participants until fixed (re-run db:migrate)"
fi
exit "$fail"
