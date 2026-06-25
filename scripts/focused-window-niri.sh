#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible entrypoint. Prefer ./scripts/battery-monitor-system-helper.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/battery-monitor-system-helper.sh" "$@"
