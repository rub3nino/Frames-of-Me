#!/usr/bin/env bash
# Wipes one event's data (photos, faces, vectors, galleries, jobs, uploads, match log) so the next
# test round starts clean — users, consents and the event row itself stay.
#
#   ./scripts/reset-event.sh <slug>            # asks for confirmation (type the slug)
#   ./scripts/reset-event.sh <slug> --yes      # no prompt
#   ./scripts/reset-event.sh <slug> --keep-running   # do not stop/start api + worker
#
# Steps: stop worker + api → SQL cleanup in one transaction (jobs of the event, upload_sessions,
# face_vectors, match_runs/match_hits, galleries, photos — derivatives/faces/gallery_items cascade)
# → `mc rm` of originals/<eventId>/ and selfies/<eventId>/ plus the thumbs/web objects of the
# deleted photos → vacuum analyze → start. The admin "Reset evento" (job `reset`) is the online
# alternative when stopping the stack is not an option.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

SLUG="${1:-}"
if [[ -z "$SLUG" || "$SLUG" == "-h" || "$SLUG" == "--help" ]]; then
  sed -n '2,13p' "$0"; exit 2
fi
shift
require_env_file
YES=false; KEEP_RUNNING=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=true ;;
    --keep-running) KEEP_RUNNING=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

PGUSER_="$(env_value POSTGRES_USER)"
PGDB_="$(env_value POSTGRES_DB)"
BUCKET="$(env_value S3_BUCKET)"; BUCKET="${BUCKET:-rephoto}"
MINIO_USER="$(env_value MINIO_ROOT_USER)"
MINIO_PASSWORD="$(env_value MINIO_ROOT_PASSWORD)"

psql_q() {
  compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -X -A -t -v ON_ERROR_STOP=1 "$@"
}

EVENT_ID="$(psql_q -c "select id from events where slug = '${SLUG//\'/\'\'}'")"
if [[ -z "$EVENT_ID" ]]; then echo "event not found: $SLUG" >&2; exit 1; fi
COUNTS="$(psql_q -F ' ' -c "select (select count(*) from photos where event_id = '$EVENT_ID'), (select count(*) from galleries where event_id = '$EVENT_ID'), (select count(*) from jobs where status in ('queued','running'))")"
read -r N_PHOTOS N_GALLERIES N_ACTIVE_JOBS <<< "$COUNTS"
log "event $SLUG ($EVENT_ID): $N_PHOTOS photos, $N_GALLERIES galleries, $N_ACTIVE_JOBS active jobs in the whole queue"

if ! $YES; then
  printf 'This deletes every photo, face, vector, gallery and job of "%s" and the objects in MinIO. Type the slug to continue: ' "$SLUG"
  read -r answer
  [[ "$answer" == "$SLUG" ]] || { echo "aborted"; exit 1; }
fi

if ! $KEEP_RUNNING; then
  log "stopping worker and api"
  compose stop worker api
fi

# Photo ids first: thumbs/<id>.jpg and web/<id>.jpg are not prefixed by event.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
psql_q -c "select id from photos where event_id = '$EVENT_ID'" > "$WORKDIR/photo-ids.txt"

HAS_MATCH_RUNS="$(psql_q -c "select 1 from information_schema.tables where table_name = 'match_runs'")"
HAS_VECTORS="$(psql_q -c "select 1 from information_schema.tables where table_name = 'face_vectors'")"
HAS_FEEDBACK="$(psql_q -c "select 1 from information_schema.tables where table_name = 'gallery_feedback'")"

log "sql cleanup"
psql_q <<SQL
begin;
-- jobs whose payload points at this event or at one of its photos / users' galleries
delete from jobs where payload->>'eventId' = '$EVENT_ID';
delete from jobs where payload->>'photoId' in (select id::text from photos where event_id = '$EVENT_ID');
delete from upload_sessions where event_id = '$EVENT_ID';
$( [[ "$HAS_VECTORS" == "1" ]] && echo "delete from face_vectors where event_id = '$EVENT_ID';" )
$( [[ "$HAS_MATCH_RUNS" == "1" ]] && echo "delete from match_runs where event_id = '$EVENT_ID';" )
$( [[ "$HAS_FEEDBACK" == "1" ]] && echo "delete from gallery_feedback where event_id = '$EVENT_ID';" )
delete from galleries where event_id = '$EVENT_ID';
delete from face_index where event_id = '$EVENT_ID';
delete from photos where event_id = '$EVENT_ID';
commit;
SQL

log "removing objects from MinIO (bucket $BUCKET)"
mc_run() {
  compose exec -T -e MC_HOST_local="http://${MINIO_USER}:${MINIO_PASSWORD}@minio:9000" minio /usr/bin/mc "$@"
}
mc_run rm --recursive --force "local/$BUCKET/originals/$EVENT_ID/" >/dev/null 2>&1 || true
mc_run rm --recursive --force "local/$BUCKET/selfies/$EVENT_ID/" >/dev/null 2>&1 || true
OTHER_PHOTOS="$(psql_q -c "select count(*) from photos")"
if [[ "$OTHER_PHOTOS" == "0" ]]; then
  # No photo left in any event: the derivative prefixes can go wholesale (fast).
  mc_run rm --recursive --force "local/$BUCKET/thumbs/" >/dev/null 2>&1 || true
  mc_run rm --recursive --force "local/$BUCKET/web/" >/dev/null 2>&1 || true
elif [[ -s "$WORKDIR/photo-ids.txt" ]]; then
  # Other events keep their derivatives: remove ours by id, 500 photos (1000 objects) per mc call.
  split -l 500 "$WORKDIR/photo-ids.txt" "$WORKDIR/chunk-"
  for chunk in "$WORKDIR"/chunk-*; do
    args=()
    while read -r id; do args+=("local/$BUCKET/thumbs/$id.jpg" "local/$BUCKET/web/$id.jpg"); done < "$chunk"
    mc_run rm --force "${args[@]}" >/dev/null 2>&1 || true
  done
fi

log "vacuum analyze"
psql_q -c "vacuum analyze photos, faces, derivatives, galleries, gallery_items, jobs, upload_sessions$( [[ "$HAS_VECTORS" == "1" ]] && echo ', face_vectors' )" >/dev/null

if ! $KEEP_RUNNING; then
  log "starting api and worker"
  compose start api worker
fi
log "done: $N_PHOTOS photos and $N_GALLERIES galleries of $SLUG removed"
