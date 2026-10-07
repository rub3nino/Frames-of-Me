#!/usr/bin/env bash
# Live status of the stack for the test campaign: queue depth/age per job type, photos by status,
# face_vectors/galleries counts, throughput, p50/p95 per job type, face-service /metrics,
# docker stats, disk, iostat, last errors. Prints a screen every N seconds and appends a CSV row.
#
#   ./scripts/status.sh                    # every 30 s, CSV in ./status.csv
#   ./scripts/status.sh -i 10 -o /srv/rephoto/status.csv
#   ./scripts/status.sh --once             # one screen, no loop
#   ./scripts/status.sh --event <slug>     # restrict photo/vector/gallery counts to one event
#
# Works before and after migration 006: jobs.finished_at / duration_ms are detected with
# information_schema; without them throughput comes from claimed_at and p50/p95 are skipped.
# Needs only `docker compose` (psql runs inside the postgres container; the face-service metrics
# are read with python inside its container). Stop with Ctrl-C.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

INTERVAL=30
OUT="${REPHOTO_STATUS_CSV:-./status.csv}"
ONCE=false
EVENT_SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -o|--out) OUT="$2"; shift 2 ;;
    --once) ONCE=true; shift ;;
    --event) EVENT_SLUG="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
require_env_file

PGUSER_="$(env_value POSTGRES_USER)"
PGDB_="$(env_value POSTGRES_DB)"

psql_q() {
  # -A -t: unaligned, tuples only; -F ',' for multi-column rows.
  compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -X -A -t -F ',' -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || echo ""
}

column_exists() {
  [[ "$(psql_q "select 1 from information_schema.columns where table_name = '$1' and column_name = '$2'")" == "1" ]]
}

table_exists() {
  [[ "$(psql_q "select 1 from information_schema.tables where table_name = '$1'")" == "1" ]]
}

HAS_FINISHED=false; column_exists jobs finished_at && HAS_FINISHED=true
HAS_DURATION=false; column_exists jobs duration_ms && HAS_DURATION=true
HAS_VECTORS=false; table_exists face_vectors && HAS_VECTORS=true
HAS_MATCH_RUNS=false; table_exists match_runs && HAS_MATCH_RUNS=true

EVENT_FILTER=""
if [[ -n "$EVENT_SLUG" ]]; then
  EVENT_ID="$(psql_q "select id from events where slug = '${EVENT_SLUG//\'/\'\'}'")"
  if [[ -z "$EVENT_ID" ]]; then echo "event not found: $EVENT_SLUG" >&2; exit 1; fi
  EVENT_FILTER="where event_id = '$EVENT_ID'"
fi

if [[ ! -f "$OUT" ]]; then
  echo "ts,queued_derive,queued_index,queued_attach,queued_match,queued_other,running,error,oldest_queued_s,photos_uploaded,photos_processing,photos_indexed,photos_error,face_vectors,galleries,done_last_interval,derive_p50_ms,derive_p95_ms,index_p50_ms,index_p95_ms,match_p50_ms,match_p95_ms,attach_p50_ms,attach_p95_ms,fs_p50_ms,fs_p95_ms,fs_requests,disk_used_pct" > "$OUT"
fi

iteration() {
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local now_epoch; now_epoch="$(date +%s)"

  # --- jobs: depth and age per type
  local jobs_rows
  jobs_rows="$(psql_q "select type, status, count(*), coalesce(extract(epoch from now() - min(run_after)) filter (where status = 'queued'), 0)::int from jobs where status in ('queued','running','error') group by 1,2 order by 1,2")"
  local q_derive=0 q_index=0 q_attach=0 q_match=0 q_other=0 running=0 errors=0 oldest=0
  while IFS=',' read -r type status count age; do
    [[ -z "${type:-}" ]] && continue
    case "$status" in
      queued)
        case "$type" in
          derive) q_derive=$count ;; index) q_index=$count ;; attach) q_attach=$count ;; match) q_match=$count ;; *) q_other=$((q_other + count)) ;;
        esac
        (( age > oldest )) && oldest=$age
        ;;
      running) running=$((running + count)) ;;
      error) errors=$((errors + count)) ;;
    esac
  done <<< "$jobs_rows"

  # --- photos by status
  local photos_rows
  photos_rows="$(psql_q "select status, count(*) from photos $EVENT_FILTER group by 1")"
  local p_uploaded=0 p_processing=0 p_indexed=0 p_error=0
  while IFS=',' read -r status count; do
    [[ -z "${status:-}" ]] && continue
    case "$status" in
      uploaded) p_uploaded=$count ;; processing) p_processing=$count ;; indexed) p_indexed=$count ;; error) p_error=$count ;;
    esac
  done <<< "$photos_rows"

  local vectors="-" galleries
  if $HAS_VECTORS; then
    # n_live_tup is instant; the exact count on 500k rows takes seconds — use it only per event.
    if [[ -n "$EVENT_FILTER" ]]; then vectors="$(psql_q "select count(*) from face_vectors $EVENT_FILTER")"
    else vectors="$(psql_q "select n_live_tup from pg_stat_user_tables where relname = 'face_vectors'")"; fi
  fi
  galleries="$(psql_q "select count(*) || '/' || count(*) filter (where cardinality(anchor_face_ids) > 0) from galleries $EVENT_FILTER")"

  # --- throughput and durations
  local done_recent="" durations=""
  if $HAS_FINISHED; then
    done_recent="$(psql_q "select type || ':' || count(*) from jobs where status = 'done' and finished_at > now() - interval '${INTERVAL} seconds' group by 1 order by 1" | paste -sd ' ' -)"
    done_recent="${done_recent:-0}"
  else
    done_recent="$(psql_q "select type || ':' || count(*) from jobs where status = 'done' and claimed_at > now() - interval '${INTERVAL} seconds' group by 1 order by 1" | paste -sd ' ' -)"
    done_recent="${done_recent:-0}"
  fi
  local d_p50=("" "" "" "") d_p95=("" "" "" "")
  if $HAS_DURATION; then
    durations="$(psql_q "select type, percentile_cont(0.5) within group (order by duration_ms)::int, percentile_cont(0.95) within group (order by duration_ms)::int from jobs where status = 'done' and finished_at > now() - interval '10 minutes' and duration_ms is not null group by 1 order by 1")"
    while IFS=',' read -r type p50 p95; do
      [[ -z "${type:-}" ]] && continue
      case "$type" in
        derive) d_p50[0]=$p50; d_p95[0]=$p95 ;; index) d_p50[1]=$p50; d_p95[1]=$p95 ;;
        match) d_p50[2]=$p50; d_p95[2]=$p95 ;; attach) d_p50[3]=$p50; d_p95[3]=$p95 ;;
      esac
    done <<< "$durations"
  fi

  # --- face-service /metrics (plain text, agent B); python3 is in the image, curl is not
  local fs_metrics fs_p50="" fs_p95="" fs_req=""
  fs_metrics="$(compose exec -T face-service python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8090/metrics',timeout=5).read().decode())" 2>/dev/null || true)"
  if [[ -n "$fs_metrics" ]]; then
    fs_p50="$(awk '/embed_latency_ms_p50/ {print $2}' <<< "$fs_metrics")"
    fs_p95="$(awk '/embed_latency_ms_p95/ {print $2}' <<< "$fs_metrics")"
    fs_req="$(awk '/embed_requests_total/ {print $2}' <<< "$fs_metrics")"
  fi

  # --- host
  local stats disk disk_pct io=""
  stats="$(docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null | grep -E '^rephoto' | sort || true)"
  disk="$(df -h "$(env_value MINIO_DATA_DIR | grep -E '^/' || echo /var/lib/docker)" 2>/dev/null | tail -n1)"
  disk_pct="$(awk '{print $5}' <<< "$disk" | tr -d '%')"
  if command -v iostat >/dev/null 2>&1; then
    io="$(iostat -dx 1 2 2>/dev/null | awk 'f && NF>0 {print} /Device/ {c++; if (c==2) f=1}' | head -n 6 || true)"
  fi

  # --- last errors
  local last_errors
  last_errors="$(psql_q "select to_char(coalesce(claimed_at, created_at), 'HH24:MI:SS') || ' ' || type || ' ' || left(regexp_replace(coalesce(last_error, ''), E'[\\n\\r]+', ' ', 'g'), 110) from jobs where status = 'error' order by coalesce(claimed_at, created_at) desc limit 5")"
  local photo_errors
  photo_errors="$(psql_q "select left(coalesce(error, '?'), 80) || ' ×' || count(*) from photos where status = 'error' $( [[ -n "$EVENT_FILTER" ]] && echo "and event_id = '$EVENT_ID'" ) group by 1 order by 2 desc limit 3")"
  local match_line=""
  if $HAS_MATCH_RUNS; then
    match_line="$(psql_q "select count(*) || ' runs/10min, rejected ' || count(*) filter (where reason is not null and reason <> 'no_photos_yet') || ', avg hits ' || coalesce(round(avg(hits))::text, '-') || ', engine p50 ' || coalesce(percentile_cont(0.5) within group (order by engine_ms)::int::text, '-') || ' ms' from match_runs where created_at > now() - interval '10 minutes'")"
  fi

  # --- screen
  clear 2>/dev/null || true
  printf 'Frames of Me status  %s  every %ss  csv: %s%s\n' "$ts" "$INTERVAL" "$OUT" "${EVENT_SLUG:+  event: $EVENT_SLUG}"
  printf '%s\n' "----------------------------------------------------------------------------------------"
  printf 'jobs      queued  derive %-6s index %-6s attach %-6s match %-6s other %-5s | running %-4s error %-5s oldest queued %ss\n' "$q_derive" "$q_index" "$q_attach" "$q_match" "$q_other" "$running" "$errors" "$oldest"
  printf 'photos    uploaded %-7s processing %-7s indexed %-8s error %-6s | face_vectors %-8s galleries %s (with anchors)\n' "$p_uploaded" "$p_processing" "$p_indexed" "$p_error" "$vectors" "$galleries"
  printf 'done last %ss: %s' "$INTERVAL" "$done_recent"
  if ! $HAS_FINISHED; then printf '   (from claimed_at: migration 006 adds finished_at)'; fi
  printf '\n'
  if $HAS_DURATION; then
    printf 'p50/p95 ms (10 min)  derive %s/%s  index %s/%s  match %s/%s  attach %s/%s\n' "${d_p50[0]:--}" "${d_p95[0]:--}" "${d_p50[1]:--}" "${d_p95[1]:--}" "${d_p50[2]:--}" "${d_p95[2]:--}" "${d_p50[3]:--}" "${d_p95[3]:--}"
  else
    printf 'p50/p95 per job type: n/a until migration 006 (jobs.duration_ms)\n'
  fi
  printf 'face-service  embed p50 %s ms  p95 %s ms  requests %s%s\n' "${fs_p50:--}" "${fs_p95:--}" "${fs_req:--}" "$( [[ -z "$fs_metrics" ]] && echo '  (no /metrics: service down or older image)' )"
  [[ -n "$match_line" ]] && printf 'match     %s\n' "$match_line"
  printf '%s\n' "----------------------------------------------------------------------------------------"
  printf 'disk      %s\n' "$disk"
  [[ -n "$io" ]] && { printf 'iostat\n%s\n' "$io"; }
  [[ -n "$stats" ]] && { printf 'containers (cpu, mem)\n%s\n' "$stats"; }
  if [[ -n "$last_errors" ]]; then printf 'last job errors\n%s\n' "$last_errors"; fi
  if [[ -n "$photo_errors" ]]; then printf 'photo errors\n%s\n' "$photo_errors"; fi

  # --- csv
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"%s",%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$ts" "$q_derive" "$q_index" "$q_attach" "$q_match" "$q_other" "$running" "$errors" "$oldest" \
    "$p_uploaded" "$p_processing" "$p_indexed" "$p_error" "$vectors" "${galleries%%/*}" "$done_recent" \
    "${d_p50[0]}" "${d_p95[0]}" "${d_p50[1]}" "${d_p95[1]}" "${d_p50[2]}" "${d_p95[2]}" "${d_p50[3]}" "${d_p95[3]}" \
    "$fs_p50" "$fs_p95" "$fs_req" "$disk_pct" >> "$OUT"
}

if $ONCE; then
  iteration
  exit 0
fi
while true; do
  iteration
  sleep "$INTERVAL"
done
