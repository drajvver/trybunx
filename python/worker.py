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
import signal
import subprocess
import sys
import traceback
import time

import cv2
import numpy as np
import pytesseract

from ocr.change_detection import FrameChangeDetector
from ocr.engine import read_score
from ocr.neural import NeuralScoreReader


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
    try:
        tesseract_version = str(pytesseract.get_tesseract_version())
    except Exception:
        tesseract_version = None
    try:
        import onnxruntime as ort
        onnx_providers = ort.get_available_providers()
    except Exception:
        onnx_providers = []
    return {
        "pong": True,
        "tesseract_version": tesseract_version,
        "tesseract_path": pytesseract.pytesseract.tesseract_cmd,
        "onnx_providers": onnx_providers,
        "python_version": sys.version.split()[0],
    }


neural_readers: dict[str, NeuralScoreReader] = {}
active_ffmpeg: list[subprocess.Popen | None] = [None]


def handle_termination(_signum: int, _frame: object) -> None:
    process = active_ffmpeg[0]
    if process is not None and process.poll() is None:
        process.terminate()
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, handle_termination)


def get_neural_reader(provider: str) -> NeuralScoreReader:
    reader = neural_readers.get(provider)
    if reader is None:
        try:
            reader = NeuralScoreReader(provider)
        except Exception:
            # CoreML model compilation can fail on older macOS/Intel Macs.
            # Neural CPU inference is still preferable to abandoning the new
            # backend or making Tesseract a hard runtime requirement.
            if provider not in ("auto", "coreml"):
                raise
            reader = NeuralScoreReader("cpu")
        neural_readers[provider] = reader
    return reader


def read_image(
    image: np.ndarray,
    engine: str,
    provider: str,
    fallback_to_tesseract: bool,
    min_confidence: float,
    max_score: int,
) -> dict:
    """Run the configured OCR backend on an already-decoded BGR frame."""
    used_engine = engine
    if engine == "neural":
        try:
            neural_read = get_neural_reader(provider).read_image(image, max_score)
            read = neural_read
            if not neural_read.ok and fallback_to_tesseract:
                fallback_started = time.perf_counter()
                ok, encoded = cv2.imencode(".png", image)
                if not ok:
                    raise ValueError("could not encode frame for Tesseract fallback")
                read = read_score(encoded.tobytes(), 1.0, max_score)
                read.inference_seconds = (  # type: ignore[attr-defined]
                    neural_read.inference_seconds + time.perf_counter() - fallback_started
                )
                read.provider = neural_read.provider  # type: ignore[attr-defined]
                used_engine = "tesseract_fallback"
        except Exception:
            if not fallback_to_tesseract:
                raise
            ok, encoded = cv2.imencode(".png", image)
            if not ok:
                raise ValueError("could not encode frame for Tesseract fallback")
            read = read_score(encoded.tobytes(), 1.0, max_score)
            used_engine = "tesseract_fallback"
    else:
        started = time.perf_counter()
        ok, encoded = cv2.imencode(".png", image)
        if not ok:
            raise ValueError("could not encode frame for Tesseract")
        read = read_score(encoded.tobytes(), 1.0, max_score)
        read.inference_seconds = time.perf_counter() - started  # type: ignore[attr-defined]

    return {
        "ok": read.ok and read.confidence >= min_confidence,
        "score": read.score,
        "confidence": read.confidence,
        "raw": read.raw,
        "engine": used_engine,
        "provider": getattr(read, "provider", "cpu"),
        "inference_seconds": round(getattr(read, "inference_seconds", 0.0), 6),
        "reused": False,
    }


def _read_exact(stream: object, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining > 0:
        chunk = stream.read(remaining)  # type: ignore[attr-defined]
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class FfmpegDecodeError(RuntimeError):
    pass


def _decode_probe(
    ffmpeg_path: str,
    input_path: str,
    start: float,
    duration: float,
    filters: list[str],
    hardware: bool,
) -> tuple[bool, float]:
    """Time a short real decode/filter pass; availability alone is insufficient."""
    args = [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if hardware:
        args.extend(["-hwaccel", "videotoolbox"])
    args.extend(
        [
            "-ss", f"{start:.3f}",
            "-t", f"{duration:.3f}",
            "-i", input_path,
            "-an", "-sn",
            "-vf", ",".join(filters),
            "-f", "null", "-",
        ]
    )
    started = time.perf_counter()
    process: subprocess.Popen | None = None
    try:
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        active_ffmpeg[0] = process
        process.communicate(timeout=60)
        return process.returncode == 0, time.perf_counter() - started
    except (OSError, subprocess.TimeoutExpired):
        return False, time.perf_counter() - started
    finally:
        active_ffmpeg[0] = None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


def op_ocr_video(params: dict) -> dict:
    """Stream cropped BGR frames from FFmpeg and OCR only changed frames."""
    input_path = str(params["input_path"])
    ffmpeg_path = str(params.get("ffmpeg_path") or "ffmpeg")
    start = float(params.get("start", 0.0))
    end_value = params.get("end")
    end = float(end_value) if end_value is not None else None
    interval_ms = int(params.get("interval_ms", 1000))
    width = int(params["output_width"])
    height = int(params["output_height"])
    crop = params["crop"]
    engine = str(params.get("engine", "neural"))
    provider = str(params.get("provider", "auto"))
    fallback = bool(params.get("fallback_to_tesseract", False))
    min_confidence = float(params.get("min_confidence", 0.0))
    max_score = int(params.get("max_score", 30))
    change_enabled = bool(params.get("change_detection_enabled", True))
    change_threshold = float(params.get("change_threshold", 2.0))
    refresh_seconds = float(params.get("refresh_interval_seconds", 30.0))
    refresh_frames = max(1, round(refresh_seconds * 1000 / interval_ms))
    confirmation_reads = int(params.get("confirmation_reads", 3))
    decode_mode = str(params.get("decode_acceleration", "auto"))

    fps = 1000.0 / interval_ms
    filters = [
        f"fps={fps}",
        f"crop={int(crop['width'])}:{int(crop['height'])}:{int(crop['x'])}:{int(crop['y'])}",
    ]
    if width != int(crop["width"]) or height != int(crop["height"]):
        filters.append(f"scale={width}:{height}:flags=lanczos")

    duration = max(0.0, end - start) if end is not None else 0.0
    decoder = "software"
    if decode_mode == "videotoolbox":
        decoder = "videotoolbox"
    elif decode_mode == "auto" and sys.platform == "darwin" and duration >= 30:
        probe_duration = min(10.0, duration)
        hw_ok, hw_seconds = _decode_probe(
            ffmpeg_path, input_path, start, probe_duration, filters, True
        )
        sw_ok, sw_seconds = _decode_probe(
            ffmpeg_path, input_path, start, probe_duration, filters, False
        )
        # Require a meaningful win; small probe differences are often startup noise.
        if hw_ok and (not sw_ok or hw_seconds < sw_seconds * 0.9):
            decoder = "videotoolbox"

    def stream_attempt(selected_decoder: str) -> dict:
        args = [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin"]
        if selected_decoder == "videotoolbox":
            args.extend(["-hwaccel", "videotoolbox"])
        args.extend(["-ss", f"{start:.3f}"])
        if end is not None:
            args.extend(["-t", f"{duration:.3f}"])
        args.extend(
            [
                "-i", input_path,
                "-an", "-sn",
                "-vf", ",".join(filters),
                "-pix_fmt", "bgr24",
                "-f", "rawvideo",
                "pipe:1",
            ]
        )

        detector = FrameChangeDetector(change_threshold, refresh_frames, confirmation_reads)
        frame_bytes = width * height * 3
        samples: list[dict] = []
        cached: dict | None = None
        inferred = 0
        reused = 0
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        active_ffmpeg[0] = process
        try:
            assert process.stdout is not None
            index = 0
            while True:
                raw = _read_exact(process.stdout, frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise FfmpegDecodeError(
                        f"incomplete FFmpeg frame: {len(raw)}/{frame_bytes} bytes"
                    )
                image = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
                should_read, difference = detector.should_read(image, index)
                if not change_enabled:
                    should_read = True

                if should_read or cached is None:
                    sample = read_image(
                        image, engine, provider, fallback, min_confidence, max_score
                    )
                    cached = sample
                    inferred += 1
                else:
                    sample = {**cached, "inference_seconds": 0.0, "reused": True}
                    reused += 1
                samples.append(
                    {
                        **sample,
                        "timestamp": start + index * interval_ms / 1000,
                        "change_difference": (
                            None if difference == float("inf") else round(difference, 4)
                        ),
                    }
                )
                index += 1
                if index % 25 == 0:
                    emit({"id": current_request_id[0], "progress": {"done": index, "total": 0}})

            return_code = process.wait(timeout=30)
            if return_code != 0:
                stderr = (
                    process.stderr.read().decode("utf-8", errors="replace")
                    if process.stderr else ""
                )
                raise FfmpegDecodeError(
                    f"FFmpeg exited with code {return_code}: {stderr[-1000:]}"
                )
        finally:
            active_ffmpeg[0] = None
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()

        return {
            "samples": samples,
            "frame_count": len(samples),
            "inferred_frames": inferred,
            "reused_frames": reused,
        }

    hardware_fallback = False
    try:
        result = stream_attempt(decoder)
    except FfmpegDecodeError:
        if decoder != "videotoolbox":
            raise
        hardware_fallback = True
        decoder = "software"
        result = stream_attempt(decoder)

    return {
        **result,
        "decoder": decoder,
        "hardware_decode_fallback": hardware_fallback,
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
    engine = str(params.get("engine", "neural"))
    provider = str(params.get("provider", "auto"))
    fallback_to_tesseract = bool(params.get("fallback_to_tesseract", False))

    samples = []
    total = len(frames)
    for i, frame in enumerate(frames):
        path = frame.get("path")
        timestamp = float(frame.get("timestamp", 0.0))
        try:
            with open(path, "rb") as fh:
                img_bytes = fh.read()
            used_engine = engine
            if engine == "neural":
                try:
                    neural_read = get_neural_reader(provider).read_score(img_bytes, max_score)
                    read = neural_read
                    if not neural_read.ok and fallback_to_tesseract:
                        fallback_started = time.perf_counter()
                        read = read_score(img_bytes, upscale, max_score)
                        read.inference_seconds = (  # type: ignore[attr-defined]
                            neural_read.inference_seconds + time.perf_counter() - fallback_started
                        )
                        read.provider = neural_read.provider  # type: ignore[attr-defined]
                        used_engine = "tesseract_fallback"
                except Exception:
                    if not fallback_to_tesseract:
                        raise
                    read = read_score(img_bytes, upscale, max_score)
                    used_engine = "tesseract_fallback"
            else:
                started = time.perf_counter()
                read = read_score(img_bytes, upscale, max_score)
                read.inference_seconds = time.perf_counter() - started  # type: ignore[attr-defined]
            ok = read.ok and read.confidence >= min_confidence
            samples.append(
                {
                    "timestamp": timestamp,
                    "ok": ok,
                    "score": read.score,
                    "confidence": read.confidence,
                    "raw": read.raw,
                    "engine": used_engine,
                    "provider": getattr(read, "provider", "cpu"),
                    "inference_seconds": round(getattr(read, "inference_seconds", 0.0), 6),
                }
            )
        except FileNotFoundError:
            samples.append(
                {
                    "timestamp": timestamp,
                    "ok": False,
                    "score": None,
                    "confidence": 0.0,
                    "raw": None,
                    "engine": engine,
                    "provider": "unknown",
                    "inference_seconds": 0.0,
                }
            )
        if total and (i + 1) % 25 == 0:
            emit({"id": current_request_id[0], "progress": {"done": i + 1, "total": total}})

    return {"samples": samples}


OPS = {
    "ping": op_ping,
    "ocr_batch": op_ocr_batch,
    "ocr_video": op_ocr_video,
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
