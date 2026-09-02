"""Python analysis worker for TrybunaTV AI Clip Hunter.

Isolated worker process started by the Electron main process.
Protocol: JSON Lines over stdin/stdout (PRD section 9.3).

Request:  {"id": "<str>", "op": "<name>", "params": {...}}
Progress: {"id": "<str>", "progress": {"done": n, "total": m}}
Response: {"id": "<str>", "ok": true, "result": {...}}
          {"id": "<str>", "ok": false, "error": "<message>"}

Media/frame inputs are exchanged as file paths, never raw video over IPC.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import traceback

import pytesseract

from ocr.engine import read_score


def find_tesseract() -> str:
    """Locate the tesseract binary.

    GUI-launched apps (e.g. a macOS .app opened from Finder) inherit a minimal
    PATH that misses Homebrew installs, so common locations are probed too.
    Override with the TESSERACT_CMD environment variable.
    """
    override = os.environ.get("TESSERACT_CMD")
    if override:
        return override
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in (
        "/opt/homebrew/bin/tesseract",  # Homebrew on Apple Silicon
        "/usr/local/bin/tesseract",  # Homebrew on Intel macOS
        "/usr/bin/tesseract",
    ):
        if os.path.exists(candidate):
            return candidate
    return "tesseract"


pytesseract.pytesseract.tesseract_cmd = find_tesseract()


def op_ping(params: dict) -> dict:
    return {
        "pong": True,
        "tesseract_version": str(pytesseract.get_tesseract_version()),
        "tesseract_path": pytesseract.pytesseract.tesseract_cmd,
        "python_version": sys.version.split()[0],
    }


def op_ocr_batch(params: dict) -> dict:
    """OCR a batch of scoreboard frame images.

    params:
      frames: [{ "path": str, "timestamp": float }]
      upscale: float
      min_confidence: float
      max_score: int
    """
    frames = params.get("frames") or []
    upscale = float(params.get("upscale", 3.0))
    min_confidence = float(params.get("min_confidence", 0.0))
    max_score = int(params.get("max_score", 30))

    samples = []
    total = len(frames)
    for i, frame in enumerate(frames):
        path = frame.get("path")
        timestamp = float(frame.get("timestamp", 0.0))
        try:
            with open(path, "rb") as fh:
                img_bytes = fh.read()
            read = read_score(img_bytes, upscale, max_score)
            ok = read.ok and read.confidence >= min_confidence
            samples.append(
                {
                    "timestamp": timestamp,
                    "ok": ok,
                    "score": read.score,
                    "confidence": read.confidence,
                    "raw": read.raw,
                }
            )
        except FileNotFoundError:
            samples.append(
                {"timestamp": timestamp, "ok": False, "score": None, "confidence": 0.0, "raw": None}
            )
        if total and (i + 1) % 25 == 0:
            emit({"id": current_request_id[0], "progress": {"done": i + 1, "total": total}})

    return {"samples": samples}


OPS = {
    "ping": op_ping,
    "ocr_batch": op_ocr_batch,
}

current_request_id = [""]


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            rid = str(request.get("id", ""))
            current_request_id[0] = rid
            op_name = str(request.get("op", ""))
            params = request.get("params") or {}

            handler = OPS.get(op_name)
            if handler is None:
                emit({"id": rid, "ok": False, "error": f"unknown operation: {op_name}"})
                continue

            result = handler(params)
            emit({"id": rid, "ok": True, "result": result})
        except BrokenPipeError:
            break
        except Exception as exc:  # noqa: BLE001 - report any failure to the host
            rid = str(current_request_id[0])
            emit({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}",
                  "trace": traceback.format_exc()})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
