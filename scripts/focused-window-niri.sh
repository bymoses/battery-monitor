#!/usr/bin/env bash
set -euo pipefail

# Lightweight host helper for Wayland/niri focused-window tracking.
# Run on the host session, not inside Docker:
#   ./scripts/focused-window-niri.sh
# It writes JSON atomically to ./data/focused-window.json; the container imports it
# on the next 30s poll.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${FOCUSED_WINDOW_FILE:-$ROOT/data/focused-window.json}"
INTERVAL="${FOCUSED_WINDOW_INTERVAL_SECONDS:-5}"

mkdir -p "$(dirname "$OUT")"
if ! command -v niri >/dev/null 2>&1; then
  echo "niri command not found" >&2
  exit 1
fi
if [[ -z "${NIRI_SOCKET:-}" ]]; then
  echo "NIRI_SOCKET is not set; run this from inside the niri session" >&2
  exit 1
fi

echo "writing focused window to $OUT every ${INTERVAL}s" >&2
while true; do
  tmp="${OUT}.tmp"
  if niri msg -j focused-window > "$tmp" 2>/dev/null; then
    mv "$tmp" "$OUT"
  else
    rm -f "$tmp"
  fi
  sleep "$INTERVAL"
done
