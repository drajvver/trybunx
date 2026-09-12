#!/usr/bin/env python3
"""Download the ball-tracking ONNX model (YOLOv8n, COCO sports-ball class).

Usage: python track/download_model.py [--football] [--force]

The model is Ultralytics YOLOv8n exported to ONNX (~12 MB). It runs on CPU via
the existing onnxruntime dependency; no torch/ultralytics install needed.
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

MODEL_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx"
MODEL_PATH = Path(__file__).parent / "models" / "ball.onnx"
# Recorded from the upstream release asset (12,851,049 bytes).
EXPECTED_SHA256 = "b2bc52f40e8e1c532427d5bde3575a5d5b571b739fab2c6df443733ed1589cbd"
EXPECTED_SIZE = 12851049


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    global MODEL_URL, MODEL_PATH, EXPECTED_SHA256, EXPECTED_SIZE
    force = "--force" in sys.argv[1:]
    if "--football" in sys.argv[1:]:
        # Immutable upstream revision; YOLOv8x football fine-tune (AGPL-3.0).
        MODEL_URL = ("https://huggingface.co/gianpaj/football-players-detection-1/resolve/"
                     "19ff0a8196ba3839d67acead4d7983692e8b79ff/weights/best.pt")
        MODEL_PATH = Path(__file__).parent / "models" / "football.pt"
        EXPECTED_SHA256 = "a35ca40ea9e728288b86b37f728afbe601dfd7ec58f30d4661900c2d9b308932"
        EXPECTED_SIZE = 0
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists() and not force:
        if sha256_of(MODEL_PATH) != EXPECTED_SHA256:
            print("existing model checksum mismatch; rerun with --force", file=sys.stderr)
            return 1
        print(f"model already present: {MODEL_PATH} ({MODEL_PATH.stat().st_size} bytes)")
        return 0
    print(f"downloading {MODEL_URL} ...")
    tmp = MODEL_PATH.with_suffix(".onnx.download")
    urllib.request.urlretrieve(MODEL_URL, tmp)
    size = tmp.stat().st_size
    print(f"downloaded {size} bytes")
    if EXPECTED_SIZE and size != EXPECTED_SIZE:
        print(f"WARNING: expected {EXPECTED_SIZE} bytes, got {size}", file=sys.stderr)
    digest = sha256_of(tmp)
    if digest != EXPECTED_SHA256:
        print(f"ERROR: sha256 mismatch: {digest}", file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return 1
    else:
        print(f"sha256 OK: {digest}")
    tmp.replace(MODEL_PATH)
    print(f"model ready: {MODEL_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
