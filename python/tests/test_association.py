import unittest
import numpy as np
from track.association import follow_ball
from track.football import plausible_balls


def ball(x, y=500, confidence=.8):
    return {'x': x, 'y': y, 'width': 8, 'height': 8, 'confidence': confidence, 'kind': 'ball'}


class AssociationTests(unittest.TestCase):
    def test_acquires_ball_without_a_player_anchor(self):
        frames = [{'timestamp': i/6, 'balls': [ball(1500+i*20)]} for i in range(4)]
        track = follow_ball(frames, 1920, .2)
        self.assertTrue(all(b is not None for b in track))
        self.assertEqual(track[0]['x'], 1500)

    def test_isolated_false_positive_does_not_move_crop(self):
        frames = [{'timestamp': i/6, 'balls': [ball(1500)] if i == 2 else []} for i in range(6)]
        self.assertEqual(follow_ball(frames, 1920, .2), [None] * 6)

    def test_bridges_occlusion_and_stops_holding_after_timeout(self):
        frames = [{'timestamp': i*.5, 'balls': [ball(500+i*20)] if i in [0,1,4,5] else []}
                  for i in range(14)]
        track = follow_ball(frames, 1920, .2)
        self.assertAlmostEqual(track[2]['x'], 540)
        self.assertTrue(track[2]['interpolated'])
        self.assertIsNone(track[-1])

    def test_teleporting_false_ball_does_not_hide_continuous_ball(self):
        frames = [{'timestamp': i/6, 'balls': [ball(1500, confidence=.99), ball(300+i*10)] if i == 2
                   else [ball(300+i*10)]} for i in range(6)]
        self.assertEqual(follow_ball(frames, 1920, .2)[2]['x'], 320)

    def test_missing_pass_uses_endpoints_and_an_isolated_corridor_sighting(self):
        frames = [{'timestamp': i/6, 'balls': []} for i in range(40)]
        for i, x in [(0,470),(1,500),(26,1160),(34,1900),(35,1890)]:
            frames[i]['balls'] = [ball(x)]
        # A stronger false positive outside the corridor must not steal the pan.
        frames[28]['balls'] = [ball(60, confidence=.99)]
        track = follow_ball(frames, 1920, .2)
        self.assertAlmostEqual(track[26]['x'], 1160)
        self.assertTrue(track[26]['interpolated'])
        self.assertGreater(track[30]['x'], 1450)
        self.assertLess(track[30]['x'], 1650)
        self.assertTrue(track[30]['interpolated'])
        self.assertNotIn('interpolated', track[34])

    def test_long_gap_is_not_reconstructed_without_a_confirmed_endpoint(self):
        frames = [{'timestamp': i/6, 'balls': []} for i in range(50)]
        for i, x in [(0,500),(1,510),(40,1800)]:
            frames[i]['balls'] = [ball(x)]
        track = follow_ball(frames, 1920, .2)
        self.assertIsNone(track[35])

    def test_reconstruction_has_a_time_limit(self):
        frames = [{'timestamp': i/6, 'balls': []} for i in range(50)]
        for i, x in [(0,500),(1,510),(45,1800),(46,1810)]:
            frames[i]['balls'] = [ball(x)]
        self.assertIsNone(follow_ball(frames, 1920, .2)[30])

    def test_scene_cut_blocks_confirmation_reconstruction_and_holds(self):
        frames = [{'timestamp': i/6, 'scene_id': int(i >= 12), 'balls': []}
                  for i in range(36)]
        for i, x in [(0,500),(1,510),(34,1500),(35,1510)]:
            frames[i]['balls'] = [ball(x)]
        self.assertIsNone(follow_ball(frames, 1920, .2)[12])
        self.assertIsNone(follow_ball(frames, 1920, .2)[24])
        self.assertEqual(follow_ball([
            {'timestamp': 0, 'scene_id': 0, 'balls': [ball(500)]},
            {'timestamp': .1, 'scene_id': 1, 'balls': [ball(510)]}
        ], 1920, .2), [None, None])

    def test_empty_and_weak_candidates(self):
        self.assertEqual(follow_ball([], 1920, .2), [])
        self.assertEqual(follow_ball([{'timestamp': i/6, 'balls': [ball(300, confidence=.1)]}
                                     for i in range(6)], 1920, .2), [None]*6)


class PlausibilityTests(unittest.TestCase):
    def test_rejects_sky_and_near_foreground_specks_on_wide_pitch(self):
        image = np.zeros((1080,1920,3), dtype=np.uint8)
        image[:450] = [220,160,90]
        image[450:] = [35,120,65]
        persons = [{'x': x, 'y': 550, 'width': 30, 'height': 100} for x in [200,500,900,1300]]
        candidates = [ball(800,300), ball(800,580), ball(800,1000), ball(500,550)]
        self.assertEqual(plausible_balls(image, candidates, persons), [candidates[1]])

    def test_does_not_apply_pitch_filter_to_closeups(self):
        image = np.zeros((1080,1920,3), dtype=np.uint8)
        candidates = [ball(800,300)]
        self.assertEqual(plausible_balls(image, candidates, []), candidates)


class SceneTests(unittest.TestCase):
    def test_cut_detected_but_small_motion_ignored(self):
        from track.scenes import SceneDetector
        detector = SceneDetector()
        pitch = np.full((108,192,3), [35,120,65], dtype=np.uint8)
        self.assertEqual(detector.update(pitch), 0)
        moving = pitch.copy()
        moving[50:60,80:90] = 255
        self.assertEqual(detector.update(moving), 0)
        self.assertEqual(detector.update(np.full_like(pitch, 220)), 1)
