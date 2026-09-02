"""Scoreboard OCR engine.

Reads a scoreboard ROI image and returns score information only
(PRD sections 13 and 6.3): a "H:A" string plus a confidence value.
Team names are intentionally not recognized in v0.1.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import pytesseract

from .preprocessing import variants

_SCORE_RE = re.compile(r"(\d{1,2})\s*[:\-]\s*(\d{1,2})")

_TESS_CONFIG = "--psm 7 --oem 3 -c tessedit_char_whitelist=0123456789:- "

# Confidence per preprocessing variant position (first parse wins).
_VARIANT_CONFIDENCE = (0.9, 0.75, 0.6)


@dataclass
class ScoreRead:
    ok: bool
    score: str | None
    confidence: float
    raw: str


def _parse(raw: str, max_score: int) -> tuple[int, int] | None:
    match = _SCORE_RE.search(raw)
    if not match:
        return None
    home, away = int(match.group(1)), int(match.group(2))
    if home > max_score or away > max_score:
        return None
    return home, away


def read_score(img_bytes: bytes, upscale: float, max_score: int) -> ScoreRead:
    """OCR a single scoreboard image; returns a parsed score when possible."""
    best_raw = ""
    for i, (_name, image) in enumerate(variants(img_bytes, upscale)):
        data = pytesseract.image_to_data(
            image,
            config=_TESS_CONFIG,
            output_type=pytesseract.Output.DICT,
        )
        words = [t.strip() for t in data.get("text", []) if t and t.strip()]
        raw = " ".join(words)
        if len(raw) > len(best_raw):
            best_raw = raw

        parsed = _parse(raw, max_score)
        if parsed is None:
            continue

        confidence = _VARIANT_CONFIDENCE[i] if i < len(_VARIANT_CONFIDENCE) else 0.5
        return ScoreRead(ok=True, score=f"{parsed[0]}:{parsed[1]}", confidence=confidence, raw=raw)

    return ScoreRead(ok=False, score=None, confidence=0.0, raw=best_raw)
