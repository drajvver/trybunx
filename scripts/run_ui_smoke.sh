#!/usr/bin/env bash
# Runs the Electron UI smoke test headlessly (xvfb) when no display is present.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${DISPLAY:-}" ]; then
  exec node --import tsx tests/electron_smoke.ts
else
  if ! command -v xvfb-run > /dev/null; then
    echo "No DISPLAY and xvfb-run missing. Install with: apt install xvfb" >&2
    exit 1
  fi
  exec xvfb-run -a node --import tsx tests/electron_smoke.ts
fi
