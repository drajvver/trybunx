"""Ball tracking for vertical 9:16 clips.

Streams full frames from FFmpeg at a low sample rate, runs a nano YOLO ONNX
model (COCO `sports-ball` class) on each frame, and returns a timestamped
ball track. The Node side turns the track into a smoothed crop trajectory;
this module never cuts clips itself (application boundary: PRD section 9).
"""
from __future__ import annotations

import subprocess
import time

import cv2
import numpy as np
import onnxruntime as ort


class BallModelError(RuntimeError):
    pass


class BallTracker:
    """Persistent nano-YOLO session for person + ball detection."""

    #: COCO class indices (0-based).
    BALL_CLASS = 32
    PERSON_CLASS = 0
    INPUT_SIZE = 640

    def __init__(self, model_path: str) -> None:
        try:
            self.session = ort.InferenceSession(
                model_path, providers=["CPUExecutionProvider"]
            )
        except Exception as exc:
            raise BallModelError(f"could not load ball model {model_path}: {exc}") from exc
        self.input_name = self.session.get_inputs()[0].name
        self._input_shape = self.session.get_inputs()[0].shape

    def _preprocess(self, image: np.ndarray) -> tuple[np.ndarray, float, int, int]:
        """Letterbox a BGR frame to the square model input."""
        size = self.INPUT_SIZE
        height, width = image.shape[:2]
        scale = min(size / width, size / height)
        new_width, new_height = int(width * scale), int(height * scale)
        resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((size, size, 3), 114, dtype=np.uint8)
        pad_x, pad_y = (size - new_width) // 2, (size - new_height) // 2
        canvas[pad_y : pad_y + new_height, pad_x : pad_x + new_width] = resized
        tensor = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        return tensor, scale, pad_x, pad_y

    @staticmethod
    def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = 0.45) -> list[int]:
        """Greedy NMS over (cx, cy, w, h) boxes with per-box scores."""
        if len(boxes) == 0:
            return []
        x1 = boxes[:, 0] - boxes[:, 2] / 2
        y1 = boxes[:, 1] - boxes[:, 3] / 2
        x2 = boxes[:, 0] + boxes[:, 2] / 2
        y2 = boxes[:, 1] + boxes[:, 3] / 2
        order = np.argsort(scores)[::-1]
        kept: list[int] = []
        while len(order) > 0:
            best = int(order[0])
            kept.append(best)
            if len(order) == 1:
                break
            rest = order[1:]
            inter_x1 = np.maximum(x1[best], x1[rest])
            inter_y1 = np.maximum(y1[best], y1[rest])
            inter_x2 = np.minimum(x2[best], x2[rest])
            inter_y2 = np.minimum(y2[best], y2[rest])
            inter = np.maximum(0.0, inter_x2 - inter_x1) * np.maximum(0.0, inter_y2 - inter_y1)
            area_best = (x2[best] - x1[best]) * (y2[best] - y1[best])
            area_rest = (x2[rest] - x1[rest]) * (y2[rest] - y1[rest])
            union = area_best + area_rest - inter
            iou = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
            order = rest[iou <= iou_threshold]
        return kept

    def predict(self, image: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, int, int]:
        """Run one forward pass; returns (boxes, scores, scale, pad_x, pad_y).

        boxes is (8400, 4) cx/cy/w/h in letterboxed pixels, scores is
        (8400, 80) class confidences. Shared by the ball and person passes so
        each sampled frame costs exactly one inference.
        """
        tensor, scale, pad_x, pad_y = self._preprocess(image)
        output = self.session.run(None, {self.input_name: tensor})[0][0]
        return output[:4].T, output[4:].T, scale, pad_x, pad_y

    @staticmethod
    def _to_source(
        boxes: np.ndarray,
        scores: np.ndarray,
        kept: list[int],
        image_shape: tuple[int, ...],
        scale: float,
        pad_x: int,
        pad_y: int,
    ) -> list[dict]:
        height, width = image_shape[:2]
        detections = []
        for index in kept:
            cx, cy, bw, bh = (float(v) for v in boxes[index])
            src_cx = (cx - pad_x) / scale
            src_cy = (cy - pad_y) / scale
            detections.append(
                {
                    "x": round(max(0.0, min(width, src_cx)), 1),
                    "y": round(max(0.0, min(height, src_cy)), 1),
                    "width": round(max(1.0, bw / scale), 1),
                    "height": round(max(1.0, bh / scale), 1),
                    "confidence": round(float(scores[index]), 4),
                }
            )
        detections.sort(key=lambda d: d["confidence"], reverse=True)
        return detections

    def detect_from(
        self,
        predicted: tuple[np.ndarray, np.ndarray, float, int, int],
        image_shape: tuple[int, ...],
        class_index: int,
        min_confidence: float,
        iou_threshold: float = 0.45,
    ) -> list[dict]:
        """Filter one cached forward pass for a class; no extra inference."""
        boxes, scores, scale, pad_x, pad_y = predicted
        class_scores = scores[:, class_index]
        mask = class_scores >= min_confidence
        filtered_boxes, filtered_scores = boxes[mask], class_scores[mask]
        if len(filtered_boxes) == 0:
            return []
        kept = self._nms(filtered_boxes, filtered_scores, iou_threshold)
        return self._to_source(
            filtered_boxes, filtered_scores, kept, image_shape, scale, pad_x, pad_y
        )

    def detect(self, image: np.ndarray, min_confidence: float) -> list[dict]:
        """Detect balls in one BGR frame; coordinates are source pixels."""
        predicted = self.predict(image)
        return [
            {**d, "kind": "ball"}
            for d in self.detect_from(predicted, image.shape, self.BALL_CLASS, min_confidence)
        ]

    def detect_persons(
        self, image: np.ndarray, min_confidence: float, iou_threshold: float = 0.5
    ) -> list[dict]:
        """Detect persons in one BGR frame; coordinates are source pixels."""
        predicted = self.predict(image)
        return [
            {**d, "kind": "person"}
            for d in self.detect_from(
                predicted, image.shape, self.PERSON_CLASS, min_confidence, iou_threshold
            )
        ]

    def detect_class(
        self,
        image: np.ndarray,
        class_index: int,
        min_confidence: float,
        iou_threshold: float = 0.45,
    ) -> list[dict]:
        """Detect one COCO class in a BGR frame; coordinates are source pixels."""
        predicted = self.predict(image)
        return self.detect_from(
            predicted, image.shape, class_index, min_confidence, iou_threshold
        )

    def detect_ball_tiles(
        self,
        image: np.ndarray,
        min_confidence: float,
        tile_width: int = 960,
        tile_height: int = 540,
        overlap: float = 0.5,
    ) -> list[dict]:
        """Detect small balls in overlapping native-resolution tiles.

        A 10 px ball in a 1920x1080 frame becomes roughly 3 px after the
        normal full-frame 640px letterbox, which is below the useful range of
        COCO YOLOv8n. Tiles preserve more ball detail, and overlap prevents a
        ball on a tile edge from being discarded. Person detection still uses
        the one full-frame pass.
        """
        height, width = image.shape[:2]
        tile_width = max(1, min(width, int(tile_width)))
        tile_height = max(1, min(height, int(tile_height)))

        def starts(length: int, size: int) -> list[int]:
            if size >= length:
                return [0]
            stride = max(1, int(size * (1.0 - overlap)))
            values = list(range(0, length - size + 1, stride))
            last = length - size
            if values[-1] != last:
                values.append(last)
            return values

        detections: list[dict] = []
        for top in starts(height, tile_height):
            for left in starts(width, tile_width):
                tile = image[top : top + tile_height, left : left + tile_width]
                predicted = self.predict(tile)
                for detection in self.detect_from(
                    predicted, tile.shape, self.BALL_CLASS, min_confidence
                ):
                    detections.append({
                        **detection,
                        "x": detection["x"] + left,
                        "y": detection["y"] + top,
                        "kind": "ball",
                    })
        if not detections:
            return []
        boxes = np.array([[d["x"], d["y"], d["width"], d["height"]] for d in detections], dtype=np.float32)
        scores = np.array([d["confidence"] for d in detections], dtype=np.float32)
        return [detections[i] for i in self._nms(boxes, scores, 0.45)]


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


def cluster_persons(
    persons: list[dict],
    top_k: int = 6,
    padding_px: float = 60.0,
    frame_width: float = 0.0,
) -> dict | None:
    """Summarize the close-up action as one follow point.

    Picks the tallest top-k person box (closest to the camera = the action
    the broadcast is showing) and returns its center. Tallest-box wins over
    confidence because a zoomed-in follow films exactly one large player
    while the celebration it tracks scores slightly lower than a distant
    still group. Boxes near the frame edges are down-weighted (camera-follow
    artifacts: players walking out of frame are not the action). Returns
    None when no person is detected. Coordinates are in the input boxes'
    pixel space.
    """
    if not persons:
        return None
    top = persons[: max(1, top_k)]

    def edge_weight(p: dict) -> float:
        if frame_width <= 0:
            return 1.0
        margin = frame_width * 0.06
        dist = min(p["x"], frame_width - p["x"])
        if dist >= margin:
            return 1.0
        return max(0.35, dist / margin)

    main = max(
        top,
        key=lambda p: (p["height"] * edge_weight(p), p["confidence"] * edge_weight(p)),
    )
    left = min(p["x"] - p["width"] / 2 for p in top) - padding_px
    right = max(p["x"] + p["width"] / 2 for p in top) + padding_px
    return {
        "x": round(main["x"], 1),
        "y": round(main["y"], 1),
        "width": round(max(1.0, right - left), 1),
        "height": round(max(1.0, main["height"]), 1),
        "confidence": round(main["confidence"], 4),
        "kind": "cluster",
    }


def select_action_target(
    balls: list[dict],
    cluster: dict | None,
    last_pos: tuple[float, float] | None,
    ball_trust: float = 0.3,
    max_jump_px: float = 150.0,
) -> dict | None:
    """Pick the follow point for one frame (pure; unit-tested).

    Policy: the player cluster is the reliable backbone (it is always
    visible on real broadcasts). A ball sighting overrides it only when it
    is trusted (confidence >= ball_trust) and continuous (near last_pos).
    A weak or teleporting ball is ignored instead of dragging the crop to
    a false positive. At track start the cluster seeds the track so a
    stray early ball cannot latch the whole window to the wrong side.
    """
    trusted = [b for b in balls if b["confidence"] >= ball_trust]
    best_ball = trusted[0] if trusted else None  # balls arrive conf-sorted
    if last_pos is None:
        if cluster is not None:
            return cluster
        return best_ball
    if best_ball is not None:
        jump = abs(best_ball["x"] - last_pos[0]) + abs(best_ball["y"] - last_pos[1])
        if jump <= max_jump_px:
            return best_ball
    if cluster is not None:
        jump = abs(cluster["x"] - last_pos[0]) + abs(cluster["y"] - last_pos[1])
        if jump <= max_jump_px * 2:
            return cluster
    return None


def select_continuous_ball(
    balls: list[dict],
    last_ball_pos: tuple[float, float] | None,
    ball_trust: float = 0.3,
    max_jump_px: float = 150.0,
) -> dict | None:
    """Return a plausible ball linked only to the prior ball.

    In a wide shot the ball can be far from the player the broadcast frames,
    so it must not be judged against the player-cluster position.
    """
    trusted = [ball for ball in balls if ball["confidence"] >= ball_trust]
    if not trusted:
        return None
    if last_ball_pos is None:
        return trusted[0]
    nearby = [
        ball for ball in trusted
        if abs(ball["x"] - last_ball_pos[0]) + abs(ball["y"] - last_ball_pos[1]) <= max_jump_px
    ]
    return nearby[0] if nearby else None


def track_ball_video(
    params: dict,
    emit_progress,
    request_id: str,
    ffmpeg_tracker: list,
) -> dict:
    """Sample full frames over [start, end) and follow the action per frame.

    The COCO `person` head runs once on the full frame for the fallback player
    cluster. The `sports-ball` head runs on overlapping tiles so small balls
    retain enough detail to be detectable; confirmed ball tracks take priority.

    params: input_path, ffmpeg_path, start, end, sample_fps, model_path,
      min_confidence (ball), ball_trust, person_confidence, person_iou,
      cluster_top_k, cluster_padding, cluster_trust, resync_after_lost,
      max_width (0 = full resolution).
    Returns { samples: [{timestamp, x, y, width, height, confidence, kind} |
    {timestamp, lost: true}], width, height, sample_count, inference_seconds }.
    Coordinates are source-video pixels. A sample is `lost` only when neither
    a ball nor a player cluster is found. Missing model file must raise
    BallModelError so the caller can fall back to a static center crop.
    """
    from worker import FfmpegDecodeError, active_ffmpeg  # local import: worker owns the process slot

    input_path = str(params["input_path"])
    ffmpeg_path = str(params.get("ffmpeg_path") or "ffmpeg")
    start = float(params.get("start", 0.0))
    end = float(params.get("end", start))
    sample_fps = max(0.5, min(30.0, float(params.get("sample_fps", 3.0))))
    model_path = str(params.get("model_path", ""))
    min_confidence = float(params.get("min_confidence", 0.05))
    person_confidence = float(params.get("person_confidence", 0.3))
    person_iou = float(params.get("person_iou", 0.5))
    cluster_top_k = max(1, int(params.get("cluster_top_k", 6)))
    cluster_padding = float(params.get("cluster_padding", 60.0))
    # Full-resolution sampling: players and the ball are tiny at 960 px on a
    # wide amateur pitch (verified: cluster collapses to 1/75 samples there
    # while full-res persons read at 0.6-0.9). AV1 software decode of a few
    # frames/sec is cheap next to the model; keep max_width as an opt-out.
    max_width = int(params.get("max_width", 0))

    tracker = BallTracker(model_path)
    started = time.perf_counter()

    scale_filter = f"scale=min(iw\\,{max_width}):-2" if max_width > 0 else "scale=iw:ih"
    args = [
        ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}",
        "-i", input_path,
        "-an", "-sn",
        "-vf", f"fps={sample_fps},{scale_filter}",
        "-pix_fmt", "bgr24",
        "-f", "rawvideo", "pipe:1",
    ]
    probe = subprocess.run(
        [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin",
         "-ss", f"{start:.3f}", "-t", "0.5", "-i", input_path,
         "-vf", scale_filter,
         "-frames:v", "1", "-f", "null", "-"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if probe.returncode != 0:
        raise FfmpegDecodeError("tracking probe failed")

    # Resolve the actual sampled frame size with a single PNG probe frame.
    probe_size = subprocess.run(
        [ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin",
         "-ss", f"{start:.3f}", "-i", input_path,
         "-vf", scale_filter,
         "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    raw_probe = probe_size.stdout or b""
    probe_frame = cv2.imdecode(np.frombuffer(raw_probe, dtype=np.uint8), cv2.IMREAD_COLOR)
    if probe_frame is None:
        raise FfmpegDecodeError(
            f"could not determine tracking frame size: {(probe_size.stderr or b'').decode('utf-8', errors='replace')[-300:]}"
        )

    frame_height, frame_width = probe_frame.shape[:2]
    frame_bytes = frame_width * frame_height * 3

    # The inference frames are letterboxed from these sampled frames; map
    # detections back to source pixels with the width ratio of the input.
    # Source dimensions come from the caller for exactness.
    source_width = float(params.get("source_width", 0) or 0)
    source_height = float(params.get("source_height", 0) or 0)
    scale_x = (source_width / frame_width) if source_width > 0 else 1.0
    scale_y = (source_height / frame_height) if source_height > 0 else 1.0

    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    active_ffmpeg[0] = process
    ffmpeg_tracker[0] = process
    samples: list[dict] = []
    inference_seconds = 0.0
    # The player cluster is a fallback. A ball gets its own temporal
    # confirmation track, rather than being judged against that cluster.
    last_pos: tuple[float, float] | None = None
    last_ball_pos: tuple[float, float] | None = None
    ball_streak = 0
    max_jump_px = max(48.0, source_width * 0.15) if source_width > 0 else 160.0
    # Per-frame link gate: allow fast action motion between consecutive
    # samples but reject teleports across the frame (verified on real
    # broadcasts: the action moves smoothly; a jump of half the frame in
    # 1/3 s is always a different player group, never the same action).
    link_gate_px = max_jump_px
    # A trusted ball must be both confident and continuous; the greedy link
    # compares per-frame motion, so scale the teleport gate to the sample
    # rate (a 60 px/s player at 3 fps moves ~20 px/frame).
    ball_trust = float(params.get("ball_trust", 0.3))
    ball_confirmation_frames = max(1, int(params.get("ball_confirmation_frames", 2)))
    # Weak cluster frames (no clear main group) must not yank the crop:
    # require a minimum cluster confidence before linking to it, and resync
    # (re-seed) when the track has been lost for a while instead of
    # holding a stale position far from the new action.
    cluster_trust = float(params.get("cluster_trust", 0.35))
    resync_after_lost = max(1, int(float(params.get("resync_after_lost", 3.0)) * sample_fps))
    lost_streak = 0
    try:
        assert process.stdout is not None
        index = 0
        while True:
            raw = _read_exact(process.stdout, frame_bytes)
            if not raw:
                break
            if len(raw) != frame_bytes:
                raise FfmpegDecodeError(
                    f"incomplete tracking frame: {len(raw)}/{frame_bytes} bytes"
                )
            image = np.frombuffer(raw, dtype=np.uint8).reshape((frame_height, frame_width, 3))
            timestamp = start + index / sample_fps
            # One full-frame pass finds people. Small-ball detection runs on
            # overlapping tiles so the ball is not reduced to a few pixels.
            infer_start = time.perf_counter()
            predicted = tracker.predict(image)
            balls = tracker.detect_ball_tiles(image, min_confidence)
            persons = [
                {**d, "kind": "person"}
                for d in tracker.detect_from(
                    predicted, image.shape, BallTracker.PERSON_CLASS,
                    person_confidence, person_iou,
                )
            ]
            inference_seconds += time.perf_counter() - infer_start
            cluster = cluster_persons(
                persons, cluster_top_k, cluster_padding,
                frame_width=float(image.shape[1]),
            )
            if cluster is not None and cluster["confidence"] < cluster_trust:
                cluster = None
            ball = select_continuous_ball(
                balls, last_ball_pos, ball_trust=ball_trust, max_jump_px=link_gate_px,
            )
            if ball is not None:
                last_ball_pos = (ball["x"], ball["y"])
                ball_streak += 1
            else:
                # Never bridge an unobserved gap with an old ball position:
                # a later false positive would otherwise look continuous.
                last_ball_pos = None
                ball_streak = 0
            anchor = None if lost_streak >= resync_after_lost else last_pos
            target = ball if ball is not None and ball_streak >= ball_confirmation_frames else select_action_target(
                [], cluster, anchor,
                ball_trust=ball_trust, max_jump_px=link_gate_px,
            )
            best = None
            if target is not None:
                best = {
                    **target,
                    "x": target["x"] * scale_x,
                    "y": target["y"] * scale_y,
                    "width": target["width"] * scale_x,
                    "height": target["height"] * scale_y,
                }
            if best is not None:
                last_pos = (best["x"], best["y"])
                lost_streak = 0
                samples.append(
                    {
                        "timestamp": round(timestamp, 3),
                        "x": round(best["x"], 1),
                        "y": round(best["y"], 1),
                        "width": round(best["width"], 1),
                        "height": round(best["height"], 1),
                        "confidence": best["confidence"],
                        "kind": best.get("kind", "ball"),
                    }
                )
            else:
                lost_streak += 1
                samples.append({"timestamp": round(timestamp, 3), "lost": True})
            index += 1
            if index % 10 == 0:
                emit_progress({"id": request_id, "progress": {"done": index, "total": 0}})
        return_code = process.wait(timeout=60)
        if return_code != 0:
            stderr = (
                process.stderr.read().decode("utf-8", errors="replace")
                if process.stderr else ""
            )
            raise FfmpegDecodeError(f"tracking FFmpeg exited with code {return_code}: {stderr[-500:]}")
    finally:
        active_ffmpeg[0] = None
        ffmpeg_tracker[0] = None
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()

    confidences = [s["confidence"] for s in samples if "confidence" in s]
    return {
        "samples": samples,
        "width": int(source_width or frame_width),
        "height": int(source_height or frame_height),
        "sample_count": len(samples),
        "tracked_count": len(confidences),
        "mean_confidence": round(sum(confidences) / len(confidences), 4) if confidences else 0.0,
        "inference_seconds": round(inference_seconds, 3),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    }
