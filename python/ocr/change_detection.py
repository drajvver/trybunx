"""Cheap temporal change detection for scoreboard ROI frames."""
from __future__ import annotations

import cv2
import numpy as np


class FrameChangeDetector:
    """Decide when neural OCR is needed while preserving one sample per frame."""

    def __init__(self, threshold: float, refresh_frames: int, confirmation_reads: int = 1) -> None:
        self.threshold = max(0.0, threshold)
        self.refresh_frames = max(1, refresh_frames)
        self.confirmation_reads = max(1, confirmation_reads)
        self.previous: np.ndarray | None = None
        self.last_read_index = -self.refresh_frames
        self.burst_remaining = 0

    @staticmethod
    def _signature(image: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return cv2.resize(gray, (48, 24), interpolation=cv2.INTER_AREA)

    def should_read(self, image: np.ndarray, index: int) -> tuple[bool, float]:
        signature = self._signature(image)
        if self.previous is None:
            self.previous = signature
            self.last_read_index = index
            self.burst_remaining = self.confirmation_reads - 1
            return True, float("inf")

        difference = float(
            np.mean(np.abs(signature.astype(np.int16) - self.previous.astype(np.int16)))
        )
        self.previous = signature
        refresh_due = index - self.last_read_index >= self.refresh_frames
        changed = difference >= self.threshold
        if changed:
            self.last_read_index = index
            self.burst_remaining = self.confirmation_reads - 1
            return True, difference
        if self.burst_remaining > 0:
            self.last_read_index = index
            self.burst_remaining -= 1
            return True, difference
        if refresh_due:
            self.last_read_index = index
            self.burst_remaining = self.confirmation_reads - 1
            return True, difference
        return False, difference
