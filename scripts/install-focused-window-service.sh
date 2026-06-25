#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible installer. Prefer ./scripts/install-system-helper-service.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-system-helper-service.sh" "$@"
