"""Offline ball association, independent of the person fallback anchor."""
from __future__ import annotations

import math


def follow_ball(frames: list[dict], frame_width: float, min_confidence: float,
                max_gap_seconds: float = 2.0, reconstruction_seconds: float = 6.0) -> list[dict | None]:
    """Confirm sightings across frames, associate balls, and bridge short occlusions.

    `frames` contain timestamp and confidence-sorted balls in one pixel space.
    Future frames can confirm acquisition; a person position never gates a ball.
    Longer gaps use confirmed endpoints and corridor-consistent candidates to
    plan a pan, never across scene cuts. Recovered positions remain estimates.
    """
    candidates = [[b for b in f['balls'] if b['confidence'] >= min_confidence]
                  for f in frames]
    accepted: list[tuple[int, dict]] = []
    for i, frame in enumerate(frames):
        t = frame['timestamp']
        supported = []
        for ball in candidates[i]:
            # An isolated false positive must not move the camera.
            confirmed = False
            for j in range(len(frames)):
                dt = abs(frames[j]['timestamp'] - t)
                if (j == i or not 0 < dt <= 0.75 or
                        frames[j].get('scene_id', 0) != frame.get('scene_id', 0)):
                    continue
                gate = frame_width * (0.025 + 0.65 * dt)
                if any(math.hypot(b['x'] - ball['x'], b['y'] - ball['y']) <= gate
                       for b in candidates[j]):
                    confirmed = True
                    break
            if confirmed:
                supported.append(ball)
        if not supported:
            continue
        if accepted:
            prev_i, prev = accepted[-1]
            dt = t - frames[prev_i]['timestamp']
            if dt <= max_gap_seconds and frames[prev_i].get('scene_id', 0) == frame.get('scene_id', 0):
                gate = frame_width * (0.025 + 0.65 * dt)
                supported = [b for b in supported
                             if math.hypot(b['x'] - prev['x'], b['y'] - prev['y']) <= gate]
                if not supported:
                    continue
                # Favor continuity, with confidence breaking near ties.
                chosen = min(supported, key=lambda b:
                             math.hypot(b['x'] - prev['x'], b['y'] - prev['y']) / gate
                             - 0.3 * b['confidence'])
            else:
                chosen = max(supported, key=lambda b: b['confidence'])
        else:
            chosen = max(supported, key=lambda b: b['confidence'])
        accepted.append((i, {**chosen, 'kind': 'ball'}))

    result: list[dict | None] = [None] * len(frames)
    for i, ball in accepted:
        result[i] = ball
    for (left, a), (right, b) in zip(accepted, accepted[1:]):
        dt = frames[right]['timestamp'] - frames[left]['timestamp']
        if (dt > reconstruction_seconds or
                frames[left].get('scene_id', 0) != frames[right].get('scene_id', 0)):
            continue
        anchors = [(left, a)]
        if dt > max_gap_seconds:
            # Future confirmed endpoints constrain otherwise isolated sightings.
            # A loose horizontal corridor permits uneven pass speed, while a
            # tighter vertical gate rejects foreground/background false balls.
            for i in range(left + 1, right):
                k = (frames[i]['timestamp'] - frames[left]['timestamp']) / dt
                expected_x = a['x'] + k * (b['x'] - a['x'])
                expected_y = a['y'] + k * (b['y'] - a['y'])
                plausible = [c for c in candidates[i]
                             if abs(c['x'] - expected_x) <= frame_width * 0.25
                             and abs(c['y'] - expected_y) <= frame_width * 0.05]
                if plausible:
                    c = min(plausible, key=lambda c: abs(c['x'] - expected_x))
                    prev_i, prev = anchors[-1]
                    elapsed = frames[i]['timestamp'] - frames[prev_i]['timestamp']
                    if math.hypot(c['x'] - prev['x'], c['y'] - prev['y']) <= frame_width * (0.025 + 0.65 * elapsed):
                        anchors.append((i, {**c, 'kind': 'ball', 'interpolated': True}))
        anchors.append((right, b))
        for (lo, p), (hi, q) in zip(anchors, anchors[1:]):
            span = frames[hi]['timestamp'] - frames[lo]['timestamp']
            for i in range(lo + 1, hi):
                k = (frames[i]['timestamp'] - frames[lo]['timestamp']) / span
                result[i] = {**p, 'x': p['x'] + k * (q['x'] - p['x']),
                             'y': p['y'] + k * (q['y'] - p['y']),
                             'confidence': min(p['confidence'], q['confidence']),
                             'interpolated': True}
            result[hi] = q
    # A recorded clip can begin the pan shortly before confirmed reacquisition.
    for i, ball in accepted:
        for j in range(i - 1, -1, -1):
            if (frames[i]['timestamp'] - frames[j]['timestamp'] > 0.75 or result[j] is not None or
                    frames[i].get('scene_id', 0) != frames[j].get('scene_id', 0)):
                break
            result[j] = {**ball, 'interpolated': True}
    # Brief edge gaps hold the ball, not a distant player; do not extrapolate indefinitely.
    for i, ball in accepted:
        for j in range(i + 1, len(frames)):
            if (frames[j]['timestamp'] - frames[i]['timestamp'] > 3.0 or result[j] is not None or
                    frames[i].get('scene_id', 0) != frames[j].get('scene_id', 0)):
                break
            result[j] = {**ball, 'interpolated': True}
    return result
