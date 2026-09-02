"""Neural scoreboard OCR using RapidOCR models through ONNX Runtime.

The reader is deliberately isolated behind the same small score-only contract as
the legacy Tesseract engine.  ONNX Runtime gives us a CPU fallback everywhere
and the CoreML execution provider on macOS; a CUDA provider can be added without
changing callers.
"""
from __future__ import annotations

import platform
import re
import time
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort
from rapidocr import RapidOCR

# Desktop OCR is entirely local, so the runtime does not need telemetry.
ort.disable_telemetry_events()


_STRICT_SCORE_RE = re.compile(r"(?<!\d)(\d{1,2})\s*[:|\-–—]\s*(\d{1,2})(?!\d)")
_SPACED_SCORE_RE = re.compile(r"^\s*(\d{1,2})\s+(\d{1,2})\s*$")
_COMPACT_SINGLE_DIGIT_SCORE_RE = re.compile(r"^\s*(\d)(\d)\s*$")


@dataclass
class NeuralScoreRead:
    ok: bool
    score: str | None
    confidence: float
    raw: str
    provider: str
    inference_seconds: float


@dataclass
class _NumericBox:
    value: int
    center_x: float
    center_y: float
    height: float
    confidence: float
    box: np.ndarray


def _parse_score(
    text: str, max_score: int, *, allow_compact: bool = False
) -> tuple[int, int] | None:
    normalized = text.translate(str.maketrans({"：": ":", "−": "-", "–": "-", "—": "-"}))
    match = _STRICT_SCORE_RE.search(normalized) or _SPACED_SCORE_RE.match(normalized)
    if match is None and allow_compact:
        # A tight score-only crop often loses the drawn divider during OCR and
        # comes back as "00" or "01". Restrict this fallback to exactly two
        # digits so multi-digit scores are never split ambiguously.
        match = _COMPACT_SINGLE_DIGIT_SCORE_RE.match(normalized)
    if not match:
        return None
    home, away = int(match.group(1)), int(match.group(2))
    if home > max_score or away > max_score:
        return None
    return home, away


def _decode(img_bytes: bytes) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(img_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("could not decode image")
    return image


class NeuralScoreReader:
    """Persistent RapidOCR session. Model compilation happens once per worker."""

    def __init__(self, requested_provider: str = "auto") -> None:
        available = ort.get_available_providers()
        wants_coreml = requested_provider == "coreml" or (
            requested_provider == "auto"
            and platform.system() == "Darwin"
            and "CoreMLExecutionProvider" in available
        )
        self.provider = "coreml" if wants_coreml else "cpu"
        params: dict[str, Any] = {
            "EngineConfig.onnxruntime.use_coreml": wants_coreml,
        }
        self.engine = RapidOCR(params=params)
        self.score_crops: list[tuple[float, float, float, float]] = []
        self.reads_since_detection = 0
        self.calibrated_failures = 0

    def _failed_calibrated_read(self, started: float, raw_parts: list[str]) -> NeuralScoreRead:
        return NeuralScoreRead(
            ok=False,
            score=None,
            confidence=0.0,
            raw=" | ".join(raw_parts),
            provider=self.provider,
            inference_seconds=time.perf_counter() - started,
        )

    def _recognize_calibrated_crops(
        self, image: np.ndarray, max_score: int
    ) -> NeuralScoreRead | None:
        if len(self.score_crops) not in (1, 2) or self.reads_since_detection >= 600:
            return None
        started = time.perf_counter()
        height, width = image.shape[:2]
        values: list[int] = []
        confidences: list[float] = []
        raw_parts: list[str] = []
        for nx0, ny0, nx1, ny1 in self.score_crops:
            x0, x1 = int(nx0 * width), int(nx1 * width)
            y0, y1 = int(ny0 * height), int(ny1 * height)
            crop = image[max(0, y0) : min(height, y1), max(0, x0) : min(width, x1)]
            if crop.size == 0:
                return self._failed_calibrated_read(started, raw_parts)
            result = self.engine(crop, use_det=False, use_cls=False, use_rec=True)
            texts = [str(text).strip() for text in (result.txts or ()) if str(text).strip()]
            scores = [float(score) for score in (result.scores or ())]
            text = texts[0] if texts else ""
            raw_parts.append(text)
            if len(self.score_crops) == 1:
                parsed = _parse_score(text, max_score, allow_compact=True)
                if parsed is None:
                    return self._failed_calibrated_read(started, raw_parts)
                values.extend(parsed)
            else:
                if not re.fullmatch(r"\d{1,2}", text):
                    return self._failed_calibrated_read(started, raw_parts)
                value = int(text)
                if value > max_score:
                    return self._failed_calibrated_read(started, raw_parts)
                values.append(value)
            confidences.append(scores[0] if scores else 0.0)
        self.reads_since_detection += 1
        return NeuralScoreRead(
            ok=True,
            score=f"{values[0]}:{values[1]}",
            confidence=min(confidences),
            raw=" | ".join(raw_parts),
            provider=self.provider,
            inference_seconds=time.perf_counter() - started,
        )

    def _remember_line_crop(self, image_shape: tuple[int, ...], box: np.ndarray) -> None:
        image_height, image_width = image_shape[:2]
        xs, ys = box[:, 0], box[:, 1]
        height = max(1.0, float(ys.max() - ys.min()))
        self.score_crops = [
            (
                max(0.0, float(xs.min() - height * 0.25) / image_width),
                max(0.0, float(ys.min() - height * 0.2) / image_height),
                min(1.0, float(xs.max() + height * 0.25) / image_width),
                min(1.0, float(ys.max() + height * 0.2) / image_height),
            )
        ]
        self.reads_since_detection = 0
        self.calibrated_failures = 0

    def _remember_score_crops(
        self, image_shape: tuple[int, ...], left: _NumericBox, right: _NumericBox
    ) -> None:
        image_height, image_width = image_shape[:2]
        crops: list[tuple[float, float, float, float]] = []
        for numeric in (left, right):
            xs, ys = numeric.box[:, 0], numeric.box[:, 1]
            # Leave room for a future two-digit score without including team names.
            pad_x = numeric.height * 0.55
            pad_y = numeric.height * 0.25
            crops.append(
                (
                    max(0.0, float(xs.min() - pad_x) / image_width),
                    max(0.0, float(ys.min() - pad_y) / image_height),
                    min(1.0, float(xs.max() + pad_x) / image_width),
                    min(1.0, float(ys.max() + pad_y) / image_height),
                )
            )
        self.score_crops = crops
        self.reads_since_detection = 0
        self.calibrated_failures = 0

    def read_score(self, img_bytes: bytes, max_score: int) -> NeuralScoreRead:
        return self.read_image(_decode(img_bytes), max_score)

    def read_image(self, image: np.ndarray, max_score: int) -> NeuralScoreRead:
        """Read an already-decoded BGR frame (the streaming fast path)."""
        previous_crops = self.score_crops
        calibrated = self._recognize_calibrated_crops(image, max_score)
        if calibrated is not None:
            if calibrated.ok:
                self.calibrated_failures = 0
                return calibrated
            self.calibrated_failures += 1
            # A replay graphic or half-time overlay can hide the scoreboard for
            # minutes. Keep the cheap calibrated read on most frames and only
            # retry the full layout detector periodically.
            if self.calibrated_failures % 10 != 1:
                return calibrated
        self.score_crops = []
        started = time.perf_counter()
        # Scoreboards are upright, so the orientation classifier is unnecessary.
        result = self.engine(image, use_det=True, use_cls=False, use_rec=True)
        elapsed = time.perf_counter() - started

        text_records = [
            (index, str(text).strip())
            for index, text in enumerate(result.txts or ())
            if str(text).strip()
        ]
        texts = [text for _, text in text_records]
        scores = [float(score) for score in (result.scores or ())]
        boxes = list(result.boxes) if result.boxes is not None else []

        # A detector normally returns the score as one line. Also try the joined
        # output for graphics where the separator or digits become separate boxes.
        candidates: list[tuple[str, float, int | None]] = []
        for original_index, text in text_records:
            confidence = scores[original_index] if original_index < len(scores) else 0.0
            candidates.append((text, confidence, original_index))
        if len(texts) > 1:
            joined_confidence = min(scores) if scores else 0.0
            candidates.extend(
                [
                    (" ".join(texts), joined_confidence, None),
                    ("".join(texts), joined_confidence, None),
                ]
            )

        raw = " | ".join(texts)
        score_only_roi = image.shape[1] / max(1, image.shape[0]) <= 3.0
        for text, confidence, box_index in sorted(candidates, key=lambda item: item[1], reverse=True):
            parsed = _parse_score(text, max_score, allow_compact=score_only_roi)
            if parsed is not None:
                if box_index is not None and box_index < len(boxes):
                    self._remember_line_crop(
                        image.shape, np.asarray(boxes[box_index], dtype=np.float32)
                    )
                return NeuralScoreRead(
                    ok=True,
                    score=f"{parsed[0]}:{parsed[1]}",
                    confidence=confidence,
                    raw=raw,
                    provider=self.provider,
                    inference_seconds=elapsed,
                )

        # Broadcast scoreboards often use a drawn divider rather than a colon.
        # OCR then detects each score as an independent numeric box (for example
        # "GKS", "0", "0", "IKA"). Reconstruct the nearest same-line numeric
        # pair from detection geometry instead of requiring a textual separator.
        numeric_boxes: list[_NumericBox] = []
        for index, text in text_records:
            if not re.fullmatch(r"\d{1,2}", text):
                continue
            value = int(text)
            if value > max_score or index >= len(boxes):
                continue
            box = np.asarray(boxes[index], dtype=np.float32)
            xs, ys = box[:, 0], box[:, 1]
            numeric_boxes.append(
                _NumericBox(
                    value=value,
                    center_x=float(xs.mean()),
                    center_y=float(ys.mean()),
                    height=max(1.0, float(ys.max() - ys.min())),
                    confidence=scores[index] if index < len(scores) else 0.0,
                    box=box,
                )
            )

        pairs: list[tuple[float, _NumericBox, _NumericBox]] = []
        ordered = sorted(numeric_boxes, key=lambda item: item.center_x)
        for left_index, left in enumerate(ordered):
            for right in ordered[left_index + 1 :]:
                average_height = (left.height + right.height) / 2
                if abs(left.center_y - right.center_y) > average_height * 0.7:
                    continue
                normalized_gap = (right.center_x - left.center_x) / average_height
                pairs.append((normalized_gap, left, right))
        if pairs:
            _, left, right = min(pairs, key=lambda pair: pair[0])
            self._remember_score_crops(image.shape, left, right)
            return NeuralScoreRead(
                ok=True,
                score=f"{left.value}:{right.value}",
                confidence=min(left.confidence, right.confidence),
                raw=raw,
                provider=self.provider,
                inference_seconds=elapsed,
            )
        failed = NeuralScoreRead(
            ok=False,
            score=None,
            confidence=max(scores, default=0.0),
            raw=raw,
            provider=self.provider,
            inference_seconds=elapsed,
        )
        if previous_crops:
            self.score_crops = previous_crops
            self.reads_since_detection = 0
        return failed
