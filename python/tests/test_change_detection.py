import unittest

import numpy as np

from ocr.change_detection import FrameChangeDetector


class FrameChangeDetectorTests(unittest.TestCase):
    def test_reuses_unchanged_frames_and_forces_periodic_refresh(self) -> None:
        detector = FrameChangeDetector(threshold=2.0, refresh_frames=3, confirmation_reads=1)
        frame = np.zeros((60, 120, 3), dtype=np.uint8)

        self.assertTrue(detector.should_read(frame, 0)[0])
        self.assertFalse(detector.should_read(frame, 1)[0])
        self.assertFalse(detector.should_read(frame, 2)[0])
        self.assertTrue(detector.should_read(frame, 3)[0])

    def test_reads_a_confirmation_burst_before_reuse(self) -> None:
        detector = FrameChangeDetector(threshold=2.0, refresh_frames=100, confirmation_reads=3)
        frame = np.zeros((60, 120, 3), dtype=np.uint8)

        self.assertTrue(detector.should_read(frame, 0)[0])
        self.assertTrue(detector.should_read(frame, 1)[0])
        self.assertTrue(detector.should_read(frame, 2)[0])
        self.assertFalse(detector.should_read(frame, 3)[0])

    def test_detects_a_local_scoreboard_change(self) -> None:
        detector = FrameChangeDetector(threshold=2.0, refresh_frames=100)
        before = np.zeros((60, 120, 3), dtype=np.uint8)
        after = before.copy()
        after[10:50, 75:95] = 255

        detector.should_read(before, 0)
        changed, difference = detector.should_read(after, 1)

        self.assertTrue(changed)
        self.assertGreaterEqual(difference, 2.0)


if __name__ == "__main__":
    unittest.main()
