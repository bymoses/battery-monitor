#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/target" "$ROOT/.cargo-cache/registry" "$ROOT/.cargo-cache/git"
exec docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$ROOT:/work" \
  -v "$ROOT/.cargo-cache/registry:/usr/local/cargo/registry" \
  -v "$ROOT/.cargo-cache/git:/usr/local/cargo/git" \
  -w /work \
  rust:1-alpine cargo "$@"
