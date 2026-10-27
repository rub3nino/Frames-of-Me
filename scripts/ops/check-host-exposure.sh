#!/usr/bin/env bash
# F10 gate: internal services must not answer on the host's public/LAN interfaces.
# Usage: ./scripts/ops/check-host-exposure.sh [host]   (default: 127.0.0.1 checks only)
set -euo pipefail

HOST="${1:-127.0.0.1}"
PORTS=(5432 6379 9000 9001 8025 8090 8787)

fail=0
for port in "${PORTS[@]}"; do
  if nc -z -w 2 "$HOST" "$port" 2>/dev/null; then
    echo "FAIL: port $port is open on $HOST"
    fail=1
  else
    echo "OK: port $port closed on $HOST"
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "Exposure check failed. Bind Docker publishes to loopback or remove host ports."
  exit 1
fi
echo "Exposure check passed (best-effort; verify Cloudflare Tunnel is the only public ingress)."
