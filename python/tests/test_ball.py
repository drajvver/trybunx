"""Ball tracker tests: NMS, letterbox math, detection thresholding, clustering."""
import unittest
from unittest.mock import Mock, patch

import numpy as np

from track.ball import BallTracker, cluster_persons, select_action_target


def _tracker() -> BallTracker:
    return BallTracker.__new__(BallTracker)


class ModelContractTests(unittest.TestCase):
    def test_reads_football_class_map_and_input_size(self):
        session = Mock()
        session.get_inputs.return_value = [Mock(name='input', shape=[1,3,1280,1280])]
        session.get_modelmeta.return_value.custom_metadata_map = {
            'names': "{0: 'ball', 1: 'goalkeeper', 2: 'player', 3: 'referee'}"}
        with patch('track.ball.ort.InferenceSession', return_value=session):
            tracker = BallTracker('football.onnx')
        self.assertEqual(tracker.INPUT_SIZE, 1280)
        self.assertEqual(tracker.ball_class, 0)
        self.assertEqual(tracker.person_classes, [1,2])


class NmsTests(unittest.TestCase):
    def test_keeps_highest_and_suppresses_overlap(self) -> None:
        boxes = np.array(
            [
                [100.0, 100.0, 20.0, 20.0],
                [102.0, 101.0, 20.0, 20.0],
                [300.0, 300.0, 20.0, 20.0],
            ]
        )
        scores = np.array([0.9, 0.8, 0.7])
        kept = BallTracker._nms(boxes, scores)
        self.assertEqual(kept[0], 0)
        self.assertNotIn(1, kept)
        self.assertIn(2, kept)

    def test_empty(self) -> None:
        self.assertEqual(BallTracker._nms(np.zeros((0, 4)), np.zeros((0,))), [])


class PreprocessTests(unittest.TestCase):
    def test_converts_bgr_to_rgb(self) -> None:
        image = np.full((640, 640, 3), [10, 80, 240], dtype=np.uint8)
        tensor, *_ = _tracker()._preprocess(image)
        np.testing.assert_allclose(tensor[0, :, 100, 100], np.array([240, 80, 10]) / 255)

    def test_letterboxes_wide_frame(self) -> None:
        tracker = _tracker()
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        tensor, scale, pad_x, pad_y = tracker._preprocess(image)
        self.assertEqual(tensor.shape, (1, 3, 640, 640))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertAlmostEqual(scale, 0.5)
        # 1280x720 at scale 0.5 -> 640x360 centered vertically in the canvas.
        self.assertEqual(pad_x, 0)
        self.assertEqual(pad_y, 140)


class DetectTests(unittest.TestCase):
    def test_maps_to_source_pixels(self) -> None:
        """A stubbed session returning one strong ball box maps through letterbox math."""

        class StubSession:
            def run(self, _outputs, _inputs):
                pred = np.zeros((1, 84, 2), dtype=np.float32)
                pred[0, 0, 0] = 320.0
                pred[0, 1, 0] = 180.0
                pred[0, 2, 0] = 20.0
                pred[0, 3, 0] = 20.0
                pred[0, 4 + BallTracker.BALL_CLASS, 0] = 0.9
                pred[0, 4 + BallTracker.BALL_CLASS, 1] = 0.1
                return [pred]

            def get_inputs(self):
                class In:
                    name = "images"

                return [In()]

        tracker = _tracker()
        tracker.session = StubSession()
        tracker.input_name = "images"
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        detections = tracker.detect(image, 0.3)
        self.assertEqual(len(detections), 1)
        # Letterbox: 1280x720 -> 640x360 at pad_y=140, so model (320,180)
        # maps back to source (640, 80).
        self.assertAlmostEqual(detections[0]["x"], 640.0, delta=2.0)
        self.assertAlmostEqual(detections[0]["y"], 80.0, delta=2.0)
        self.assertEqual(detections[0]["confidence"], 0.9)

    def test_shared_forward_pass_serves_both_heads(self) -> None:
        """predict() runs once; detect_from() filters it per class without inference."""

        class StubSession:
            calls = 0

            def run(self, _outputs, _inputs):
                type(self).calls += 1
                pred = np.zeros((1, 84, 2), dtype=np.float32)
                pred[0, 0, 0] = 320.0
                pred[0, 1, 0] = 180.0
                pred[0, 2, 0] = 20.0
                pred[0, 3, 0] = 20.0
                pred[0, 4 + BallTracker.BALL_CLASS, 0] = 0.9
                pred[0, 4 + BallTracker.PERSON_CLASS, 1] = 0.7
                return [pred]

            def get_inputs(self):
                class In:
                    name = "images"

                return [In()]

        tracker = _tracker()
        tracker.session = StubSession()
        tracker.input_name = "images"
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        predicted = tracker.predict(image)
        balls = tracker.detect_from(predicted, image.shape, BallTracker.BALL_CLASS, 0.3)
        persons = tracker.detect_from(predicted, image.shape, BallTracker.PERSON_CLASS, 0.3)
        self.assertEqual(len(balls), 1)
        self.assertEqual(len(persons), 1)
        self.assertEqual(StubSession.calls, 1)

    def test_respects_min_confidence(self) -> None:
        class StubSession:
            def run(self, _outputs, _inputs):
                pred = np.zeros((1, 84, 1), dtype=np.float32)
                pred[0, 4 + BallTracker.BALL_CLASS, 0] = 0.1
                return [pred]

            def get_inputs(self):
                class In:
                    name = "images"

                return [In()]

        tracker = _tracker()
        tracker.session = StubSession()
        tracker.input_name = "images"
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        self.assertEqual(tracker.detect(image, 0.3), [])

    def test_detect_persons_uses_person_class(self) -> None:
        class StubSession:
            def run(self, _outputs, _inputs):
                pred = np.zeros((1, 84, 1), dtype=np.float32)
                pred[0, 0, 0] = 320.0
                pred[0, 1, 0] = 320.0
                pred[0, 2, 0] = 40.0
                pred[0, 3, 0] = 80.0
                pred[0, 4 + BallTracker.PERSON_CLASS, 0] = 0.7
                return [pred]

            def get_inputs(self):
                class In:
                    name = "images"

                return [In()]

        tracker = _tracker()
        tracker.session = StubSession()
        tracker.input_name = "images"
        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        persons = tracker.detect_persons(image, 0.3)
        self.assertEqual(len(persons), 1)
        self.assertEqual(persons[0]["kind"], "person")
        self.assertAlmostEqual(persons[0]["x"], 640.0, delta=2.0)


class ClusterTests(unittest.TestCase):
    def test_tallest_box_wins_over_confidence(self) -> None:
        # A zoomed-in follow films one large player; the still group behind
        # scores higher but is not the action.
        persons = [
            {"x": 100.0, "y": 300.0, "width": 40.0, "height": 90.0, "confidence": 0.9},
            {"x": 140.0, "y": 320.0, "width": 60.0, "height": 250.0, "confidence": 0.8},
            {"x": 900.0, "y": 300.0, "width": 40.0, "height": 90.0, "confidence": 0.85},
        ]
        cluster = cluster_persons(persons, top_k=3, padding_px=60.0)
        assert cluster is not None
        self.assertAlmostEqual(cluster["x"], 140.0)
        self.assertEqual(cluster["kind"], "cluster")

    def test_none_without_persons(self) -> None:
        self.assertIsNone(cluster_persons([], top_k=6))


class SelectActionTargetTests(unittest.TestCase):
    def _ball(self, x: float, conf: float) -> dict:
        return {"x": x, "y": 700.0, "width": 30.0, "height": 30.0,
                "confidence": conf, "kind": "ball"}

    def _cluster(self, x: float) -> dict:
        return {"x": x, "y": 600.0, "width": 900.0, "height": 200.0,
                "confidence": 0.6, "kind": "cluster"}

    def test_cluster_seeds_track_despite_early_ball(self) -> None:
        # A stray ball at the wrong side must not latch the whole window.
        target = select_action_target([self._ball(100.0, 0.9)], self._cluster(1200.0), None)
        assert target is not None
        self.assertEqual(target["kind"], "cluster")
        self.assertAlmostEqual(target["x"], 1200.0)

    def test_trusted_continuous_ball_overrides_cluster(self) -> None:
        target = select_action_target(
            [self._ball(1210.0, 0.8)], self._cluster(1200.0), (1200.0, 600.0),
            ball_trust=0.3, max_jump_px=150.0,
        )
        assert target is not None
        self.assertEqual(target["kind"], "ball")

    def test_nearby_ball_survives_stronger_teleporting_candidate(self) -> None:
        target = select_action_target(
            [self._ball(100, 0.95), self._ball(1210, 0.7)],
            self._cluster(1200), (1200, 600), max_jump_px=150,
        )
        self.assertEqual(target, self._ball(1210, 0.7))

    def test_diagonal_motion_uses_euclidean_distance(self) -> None:
        target = select_action_target(
            [self._ball(1300, 0.8)], None, (1200, 600), max_jump_px=150,
        )
        self.assertIsNotNone(target)

    def test_weak_ball_ignored(self) -> None:
        target = select_action_target(
            [self._ball(1210.0, 0.1)], self._cluster(1200.0), (1200.0, 600.0),
            ball_trust=0.3, max_jump_px=150.0,
        )
        assert target is not None
        self.assertEqual(target["kind"], "cluster")

    def test_teleporting_ball_ignored(self) -> None:
        target = select_action_target(
            [self._ball(100.0, 0.9)], self._cluster(1200.0), (1200.0, 600.0),
            ball_trust=0.3, max_jump_px=150.0,
        )
        assert target is not None
        self.assertEqual(target["kind"], "cluster")

    def test_lost_when_everything_teleports(self) -> None:
        self.assertIsNone(
            select_action_target([], None, (1200.0, 600.0),
                                 ball_trust=0.3, max_jump_px=150.0)
        )


if __name__ == "__main__":
    unittest.main()
