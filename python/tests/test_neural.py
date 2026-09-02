from __future__ import annotations

import unittest

import cv2
import numpy as np

from ocr.neural import NeuralScoreReader, _parse_score


class NeuralScoreParserTest(unittest.TestCase):
    def test_parses_common_neural_ocr_outputs(self) -> None:
        self.assertEqual(_parse_score("0-0", 30), (0, 0))
        self.assertEqual(_parse_score("Score 2 : 1", 30), (2, 1))
        self.assertEqual(_parse_score("12  3", 30), (12, 3))
        self.assertEqual(_parse_score("1：0", 30), (1, 0))
        self.assertEqual(_parse_score("0|1", 30), (0, 1))
        self.assertEqual(_parse_score("00", 30, allow_compact=True), (0, 0))
        self.assertEqual(_parse_score("01", 30, allow_compact=True), (0, 1))

    def test_rejects_clock_and_unreasonable_scores(self) -> None:
        self.assertIsNone(_parse_score("45:30", 30))
        self.assertIsNone(_parse_score("team 1 team 0", 30))
        self.assertIsNone(_parse_score("100", 30))
        self.assertIsNone(_parse_score("22", 30))


class NeuralScoreReaderTest(unittest.TestCase):
    def test_reads_a_synthetic_scoreboard_on_cpu(self) -> None:
        image = np.full((180, 600, 3), 40, dtype=np.uint8)
        cv2.putText(
            image,
            "2 - 1",
            (40, 125),
            cv2.FONT_HERSHEY_SIMPLEX,
            3,
            (255, 255, 255),
            8,
            cv2.LINE_AA,
        )
        ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(ok)

        result = NeuralScoreReader("cpu").read_score(encoded.tobytes(), 30)
        self.assertTrue(result.ok, result.raw)
        self.assertEqual(result.score, "2:1")
        self.assertGreater(result.confidence, 0.8)
        self.assertEqual(result.provider, "cpu")

        # The first read calibrates the score crop; subsequent reads skip the
        # full text detector and run recognition only.
        calibrated = NeuralScoreReader("cpu")
        first = calibrated.read_score(encoded.tobytes(), 30)
        second = calibrated.read_score(encoded.tobytes(), 30)
        self.assertEqual(second.score, first.score)
        self.assertLess(second.inference_seconds, first.inference_seconds)


if __name__ == "__main__":
    unittest.main()
