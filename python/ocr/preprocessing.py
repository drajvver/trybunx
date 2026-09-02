"""Image preprocessing variants for scoreboard OCR (see PRD section 13).

Broadcast scoreboard graphics vary a lot (bright text on dark boxes, dark
text on bright strips, semi-transparent overlays). A single binarization
method does not fit all of them, so we produce ordered variants and let the
engine use the first one that yields a parseable score.
"""
from __future__ import annotations

from typing import Iterator, Tuple

import cv2
import numpy as np


def _load_gray(img_bytes: bytes, upscale: float) -> np.ndarray:
    buf = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("could not decode image")
    if upscale and upscale != 1.0:
        img = cv2.resize(
            img,
            None,
            fx=upscale,
            fy=upscale,
            interpolation=cv2.INTER_CUBIC,
        )
    return img


def _pad(image: np.ndarray) -> np.ndarray:
    """Pad so glyphs never touch the image border (helps tesseract segmentation)."""
    pad = max(4, int(image.shape[0] * 0.12))
    return cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)


def _normalize_text_bright(image: np.ndarray) -> np.ndarray:
    """Invert so text is bright on dark background."""
    if float(np.mean(image)) > 127.0:
        return cv2.bitwise_not(image)
    return image


def variants(img_bytes: bytes, upscale: float) -> Iterator[Tuple[str, np.ndarray]]:
    """Yield named preprocessing variants, cheapest-first stop-when-parsed order."""
    gray = _load_gray(img_bytes, upscale)

    # 1. Otsu binarization - works when the ROI is mostly box + text.
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    yield "otsu", _pad(_normalize_text_bright(bw))

    # 2. Raw upscaled grayscale - robust when background is uniform.
    yield "gray", _pad(gray)

    # 3. Adaptive threshold - handles gradients / semi-transparent overlays.
    block = max(11, (min(gray.shape) | 1) // 2 * 2 + 1)
    adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 10
    )
    yield "adaptive", _pad(_normalize_text_bright(adaptive))
