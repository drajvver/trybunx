"""Conservative hard-cut boundaries for offline ball-gap reconstruction."""
from __future__ import annotations

import cv2
import numpy as np


class SceneDetector:
    def __init__(self) -> None:
        self.previous: np.ndarray | None = None
        self.scene_id = 0

    def update(self, image: np.ndarray) -> int:
        # A small blurred thumbnail ignores individual players and compression.
        thumb = cv2.resize(image, (32, 18), interpolation=cv2.INTER_AREA).astype(np.float32)
        if self.previous is not None:
            difference = np.abs(thumb - self.previous).mean(axis=2)
            if float(difference.mean()) > 35 and float(np.mean(difference > 30)) > 0.55:
                self.scene_id += 1
        self.previous = thumb
        return self.scene_id
