# Ball tracking changes and validation

## Current implementation

The rejected landscape-in-portrait fallback has been removed. Vertical exports
again use a full-height moving 9:16 crop, with no padding.

The default YAML now enables a football-trained YOLOv8x checkpoint at 2560px.
The optional `tracking` Python extra supplies Ultralytics/PyTorch; inference
uses MPS on Apple Silicon, CUDA when available, or CPU. The original YOLOv8n
ONNX model still provides player fallback detections. Set `ball_model_path`
to an empty string to select the lightweight detector alone.

Source: https://huggingface.co/gianpaj/football-players-detection-1
Revision: 19ff0a8196ba3839d67acead4d7983692e8b79ff
SHA-256: a35ca40ea9e728288b86b37f728afbe601dfd7ec58f30d4661900c2d9b308932
Model card license: AGPL-3.0. Download with `python/track/download_model.py --football`.
The checkpoint is local and git-ignored; no video is uploaded for inference.

## Why the old crop missed goal2

- The nano model lost the small ball when shrinking a wide frame to 640px.
- The fallback selected the tallest foreground player, away from the attack.
- Ball association used that player's position as its anchor, rejecting balls
  detected elsewhere on the pitch.
- Earlier fixes corrected BGR/RGB preprocessing, mixed coordinate spaces when
  resizing, and rejecting valid ball candidates behind stronger false detections.

## Added with the heavier detector

- Read ONNX input size and class metadata instead of assuming every model has
  COCO class IDs and 640px input.
- Apply wide-pitch plausibility filtering to reject sky, tree/background,
  near-foreground specks, and detections inside player torsos. Close-up tiny
  specks are filtered by their size relative to players.
- Confirm ball candidates across neighboring frames and associate them
  independently of the player fallback. Isolated detections cannot acquire a track.
- Interpolate gaps up to two seconds. Confirmed reacquisition can lead the pan
  by up to 0.75 seconds; after loss, hold the ball for up to three seconds.
- Report model-observed and interpolated/held ball samples separately.
- Preserve worker failure details in the tracking summary.
- Add a repeatable production-worker preview command:

```bash
npx tsx scripts/render_vertical_preview.ts INPUT START END OUTPUT.mp4
```

## Evaluation on goal2.webm

Tested the original model, smaller tiled inputs, a football-trained YOLOv8x,
FootAndBall, a YOLO11s ball detector, and the Roboflow ball detector. Bigger
models alone were insufficient: false background detections and the player
anchor also needed correction. The selected YOLOv8x at 2560px plus filtering
and independent association produced the useful crop in this clip.

A 35-second window (4.6–39.6 media seconds) takes about 80 seconds of detection
on this Mac, plus encoding. The preview is a real 1080×1920 crop with audio,
at output/tracking_fix_review/goal2_vertical_tracked.mp4. The pass/shot/goal
sequence was visually inspected: the crop moves right toward the attacking
players and goalmouth, instead of staying on the foreground player at left.
The lead-up still has missed ball sightings. Model observations are not a
manually labeled ball-accuracy score.

Tests cover RGB preprocessing, source coordinates, class metadata, candidate
selection, acquisition independent of players, isolated false positives,
occlusion interpolation, bounded holds, and pitch plausibility filtering.
The TypeScript unit tests and typecheck pass. The synthetic end-to-end fixture
cannot be generated with this machine's FFmpeg because it lacks `drawtext`.

## Remaining limitations

This is not guaranteed ball identity tracking. High aerial balls may fail the
pitch plausibility filter. Persistent false detections can still pass temporal
confirmation. A camera cut or zoom can invalidate a held position; shot-boundary
resets and camera-motion compensation remain future work. Player fallback still
uses the tallest-person heuristic, so celebrations and long ball-free sections
can frame the wrong player. An annotated multi-video dataset is still needed
to measure ball-in-crop coverage and tune the policies beyond this example.

## Smoother crop motion

The previous renderer discarded most trajectory positions and sent FFmpeg
only five crop updates per second, causing visible stepping in 60fps footage.
Crop commands now default to every output frame. The video is normalized to
the same frame rate before command application, fractional source rates are
preserved, and command timestamps round down to microseconds so commands
cannot slip to the following frame. The centered smoothing window increased
from 0.6 to 1.0 seconds; the fast-pan speed limit remains unchanged.

On the saved goal2 track, the maximum commanded frame-to-frame movement fell
from 301 to 16 source pixels. During the inspected shot/goal interval, the
new planned crop differs from the previous planned crop by at most 22 source
pixels. This comparison reuses the same detections to isolate smoothing.
A real FFmpeg gradient-frame regression verifies that each frame gets its
own intended crop position, including at a fractional frame rate.

Preview: output/tracking_fix_review/goal2_vertical_smooth.mp4.

## App export model-path regression

The exact export in output/goal2_2026-09-12_15_42_47/clips used a static
center crop: events.json records zero tracking samples and an ONNX
NO_SUCHFILE error. The main process checked a relative model path from the
project root, then passed it unchanged to Python running in the python/
directory. Previous preview scripts pre-resolved that path, hiding the bug.

Both model paths now resolve against the app resource root before crossing
the worker boundary, preserving absolute overrides and packaged resource
locations. Preview and real-footage proxy tests no longer pre-resolve the
configuration. Regression tests cover existing relative paths, a separate
resource root, and absolute overrides. No additional gap-reconstruction
heuristics were introduced for this failure.

## Recover the shot during a detection gap

The model-path repair exposed a separate association failure: in goal2,
confirmed ball sightings were 5.5 seconds apart (media 8.1 to 13.6 seconds).
The old two-second bridge limit held the earlier position for three seconds,
then followed the midfield player fallback until reacquisition near the goal.

Offline reconstruction now bridges up to six seconds between confirmed
endpoints in the same detected scene. Intermediate candidates that fit a
horizontal/vertical corridor and the motion gate can shape that estimated
path; these recovered positions remain marked interpolated. A thumbnail
hard-cut detector prevents confirmation, reconstruction, or holds across a
detected cut. The existing per-frame crop commands and smoothing are retained.

The production worker regenerated the same 4.6–39.6-second window as
goal_01_0m29s_vertical_shot_fix.mp4 in the user's original clips directory.
Comparison of encoded frames at clip 7.9–8.9 seconds shows the attacking
players already in view before the old crop reaches them. The export remains
1080x1920, 35.021 seconds, with 22 direct sightings and 76 estimated positions.
All 30 focused Python tests passed.

This estimates camera framing through missing detections; it does not recover
ground-truth ball locations. Curved passes, persistent false positives, and
cuts missed by the conservative detector remain limitations.
