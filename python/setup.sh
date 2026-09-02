#!/usr/bin/env bash
# Sets up the Python environment for the OCR worker.
#
#   python/setup.sh             dev mode: create .venv and install deps there
#   python/setup.sh --portable  install deps into python/vendor using the
#                               system python3 (used for packaged apps; the
#                               directory is relocatable, unlike a venv)
set -euo pipefail
cd "$(dirname "$0")/.."

PORTABLE=0
for arg in "$@"; do
  case "$arg" in
    --portable) PORTABLE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$PORTABLE" = "1" ]; then
  PYTHON="${PYTHON:-python3}"
  if ! "$PYTHON" -m pip --version > /dev/null 2>&1; then
    echo "pip not found; trying ensurepip..."
    "$PYTHON" -m ensurepip --upgrade
  fi
  echo "Installing portable python deps into python/vendor (interpreter: $PYTHON)"
  rm -rf python/vendor
  "$PYTHON" -m pip install --target python/vendor -r python/requirements.txt -q
  echo "Verifying portable install..."
  PYTHONPATH=python/vendor "$PYTHON" - <<'EOF'
import cv2, pytesseract, numpy
print("portable python deps OK:", cv2.__version__, numpy.__version__)
print("tesseract:", pytesseract.get_tesseract_version())
EOF
  exit 0
fi

VENV_DIR="${PYTHON_VENV:-.venv}"

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r python/requirements.txt -q

"$VENV_DIR/bin/python" - <<'EOF'
import cv2, pytesseract, numpy
print("python worker deps OK:", cv2.__version__, numpy.__version__)
print("tesseract:", pytesseract.get_tesseract_version())
EOF
