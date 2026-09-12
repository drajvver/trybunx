"""Optional high-resolution football detector, accelerated by MPS/CUDA when available."""
from __future__ import annotations

import contextlib
import sys

import cv2
import numpy as np

from track.ball import BallModelError


class FootballDetector:
    def __init__(self, model_path: str, input_size: int = 2560) -> None:
        try:
            # The worker's stdout is exclusively JSON Lines, including on first import.
            with contextlib.redirect_stdout(sys.stderr):
                import torch
                from ultralytics import YOLO
                self.model = YOLO(model_path)
            self.device = 'cuda:0' if torch.cuda.is_available() else (
                'mps' if torch.backends.mps.is_available() else 'cpu')
            self.ball_classes = [i for i, name in self.model.names.items()
                                 if name in ('ball', 'sports ball', 'sports-ball')]
            if not self.ball_classes:
                raise ValueError('model has no ball class')
            self.input_size = max(640, min(2560, int(input_size)))
        except Exception as exc:
            raise BallModelError(f'could not load football detector: {exc}; '
                                 'install with uv sync --project python --extra tracking') from exc

    def detect(self, image: np.ndarray, min_confidence: float) -> list[dict]:
        with contextlib.redirect_stdout(sys.stderr):
            result = self.model.predict(image, imgsz=self.input_size, conf=min_confidence,
                                        classes=self.ball_classes, device=self.device, verbose=False)[0]
        boxes = result.boxes.xywh.cpu().numpy()
        scores = result.boxes.conf.cpu().numpy()
        return [{'x': float(b[0]), 'y': float(b[1]), 'width': float(b[2]),
                 'height': float(b[3]), 'confidence': float(score), 'kind': 'ball'}
                for b, score in zip(boxes, scores)]


def plausible_balls(image: np.ndarray, balls: list[dict], persons: list[dict]) -> list[dict]:
    """Reject tiny background/foreground specks in wide pitch views.

    Applied only when several small players establish a wide shot. Close-ups
    and views without enough players leave the detector's candidates alone.
    Grass around (not inside) the tiny ball is evidence; the ball needn't be white.
    """
    height, width = image.shape[:2]
    if len(persons) < 4:
        return balls
    median_height = float(np.median([p['height'] for p in persons]))
    if median_height > height * 0.12:
        # In a zoomed view a four-pixel "ball" is usually a grass highlight.
        return [b for b in balls if b['height'] >= median_height * 0.05]
    top = float(np.median([p['y'] + p['height']/2 for p in persons])) - 2 * median_height
    bottom = max(p['y'] + p['height'] / 2 for p in persons) + height * 0.07
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    accepted = []
    for b in balls:
        x, y = int(b['x']), int(b['y'])
        if not (0 <= x < width and 0 <= y < height) or not top <= y <= bottom:
            continue
        radius = max(12, int(max(b['width'], b['height']) * 3))
        patch = hsv[max(0, y-radius):min(height, y+radius+1),
                    max(0, x-radius):min(width, x+radius+1)]
        green = (patch[:, :, 0] >= 25) & (patch[:, :, 0] <= 95) & (patch[:, :, 1] >= 35)
        if float(np.mean(green)) < 0.25:
            continue
        # Jerseys and skin inside an upright player's torso are frequent false balls.
        if any(abs(b['x'] - p['x']) < p['width'] * 0.45 and
               p['y'] - p['height']/2 <= b['y'] < p['y'] + p['height'] * 0.2
               for p in persons):
            continue
        accepted.append(b)
    return accepted
