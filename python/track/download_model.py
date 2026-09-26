#!/usr/bin/env python3
"""Download the ball-tracking ONNX model (YOLOv8n, COCO sports-ball class).

Usage: python track/download_model.py [--force]

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


def ensure_model(model_path: Path = MODEL_PATH, force: bool = False) -> Path:
    """Fetch a verified copy of the tracker model when it is not present."""
    model_path.parent.mkdir(parents=True, exist_ok=True)
    if model_path.exists() and not force:
        print(f"model already present: {model_path} ({model_path.stat().st_size} bytes)")
        return model_path
    print(f"downloading {MODEL_URL} ...")
    tmp = model_path.with_suffix(model_path.suffix + ".download")
    try:
        urllib.request.urlretrieve(MODEL_URL, tmp)
        size = tmp.stat().st_size
        print(f"downloaded {size} bytes")
        if size != EXPECTED_SIZE:
            raise RuntimeError(f"expected {EXPECTED_SIZE} bytes, got {size}")
        digest = sha256_of(tmp)
        if digest != EXPECTED_SHA256:
            raise RuntimeError(f"sha256 mismatch: {digest}")
        print(f"sha256 OK: {digest}")
        tmp.replace(model_path)
    finally:
        if tmp.exists():
            tmp.unlink()
    print(f"model ready: {model_path}")
    return model_path


def main() -> int:
    force = "--force" in sys.argv[1:]
    ensure_model(force=force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
