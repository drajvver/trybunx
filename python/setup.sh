#!/usr/bin/env bash
# Sets up the Python environment for the OCR worker using uv.
#
#   python/setup.sh             dev mode: `uv sync` -> python/.venv
#   python/setup.sh --portable  relocatable install -> python/vendor
#                               (for packaged apps; no venv)
#
# The Python version is pinned in python/.python-version (3.12). uv uses an
# already-installed interpreter or downloads one automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

PORTABLE=0
for arg in "$@"; do
  case "$arg" in
    --portable) PORTABLE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v uv > /dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: uv is required but not installed.

  macOS:   brew install uv
  Linux:   curl -LsSf https://astral.sh/uv/install.sh | sh
  Windows: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

Then re-run: npm run python:setup
EOF
  exit 1
fi

if [ "$PORTABLE" = "1" ]; then
  echo "Installing portable python deps into python/vendor (uv)"
  rm -rf python/vendor
  # Export a requirements file from pyproject.toml, then install it
  # relocatably with uv (venvs are not relocatable; vendor dirs are).
  uv export --project python --no-hashes --no-dev -o python/.requirements.lock
  uv pip install --target python/vendor -r python/.requirements.lock -q
  rm -f python/.requirements.lock
  echo "Verifying portable install..."
  PYTHONPATH=python/vendor python3 - <<'EOF'
import cv2, pytesseract, numpy
print("portable python deps OK:", cv2.__version__, numpy.__version__)
print("tesseract:", pytesseract.get_tesseract_version())
EOF
  exit 0
fi

echo "Syncing python worker environment (uv, pinned in python/.python-version)"
uv sync --project python

echo "Verifying install..."
uv run --project python python - <<'EOF'
import cv2, pytesseract, numpy
print("python worker deps OK:", cv2.__version__, numpy.__version__)
print("tesseract:", pytesseract.get_tesseract_version())
EOF
