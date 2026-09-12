# TrybunaTV AI Clip Hunter (v0.1)

Automatic highlight extraction from completed football broadcast VOD files.
The app analyzes a local recording, detects goals from scoreboard OCR +
audio excitement, and cuts one clip per goal. See `prd.md` for the full
product requirements.

## Architecture

```text
Electron / TypeScript  (product shell, orchestration, domain logic)
    |
    +-- FFmpeg / ffprobe      media probing, frame & audio extraction, clips
    +-- detection core        score state machine, audio events, aggregation
    +-- optional Python worker (isolated child process, JSON Lines over stdio)
            +-- scoreboard OCR (RapidOCR/ONNX; Tesseract fallback)
```

- `src/main/` — Electron main process: pipeline, detection, clips, IPC
- `src/renderer/` — UI (React)
- `src/shared/` — language-neutral data contracts and configuration
- `python/` — OCR worker (`worker.py`); never the application shell
- `config/default.yaml` — all detection thresholds and timing parameters

## Setup

Requirements: Node 20+, [uv](https://docs.astral.sh/uv/) (manages the Python
side and auto-installs the pinned Python 3.12 if missing), and ffmpeg
(xvfb for headless UI tests). Tesseract is optional and used only by the
legacy OCR mode or opt-in fallback.

```bash
npm install
npm run python:setup     # uv sync -> python/.venv
```

Python deps live in `python/pyproject.toml` (Python >= 3.10, pinned to 3.12
via `python/.python-version`; uv will use an already-installed interpreter
or download one). Install ffmpeg with:
- Ubuntu/Debian: `sudo apt install ffmpeg`
- macOS: `brew install ffmpeg`

For legacy OCR, also install `tesseract-ocr` (Linux) or `tesseract` (Homebrew).
- Windows: install both and set `TRYBUNX_FFMPEG_PATH` / `TESSERACT_CMD`

### macOS notes

The app works on Apple Silicon and Intel Macs. Homebrew-installed binaries
are found even when the app is launched from Finder (the app probes
`/opt/homebrew/bin` and `/usr/local/bin`; you can also set
`TRYBUNX_FFMPEG_PATH` / `TESSERACT_CMD` / `TRYBUNX_PYTHON`).

Build a distributable dmg (bundles the Python worker + deps, so end users
only need ffmpeg, which a future release will bundle too):

```bash
npm run python:setup:portable   # fills python/vendor (relocatable, no venv)
npm run dist:mac                # dist/*.dmg (arm64 + x64, unsigned)
```

The dmg is unsigned — on first launch right-click the app → Open, or run
`xattr -cr "TrybunaTV AI Clip Hunter.app"`. See `JOURNAL.md` for details and
current limitations.

## Running

Desktop app (dev):

```bash
npm run dev
```

Headless analysis (same core as the app):

```bash
npm run analyze -- --input match.mp4 --roi "0.04,0.03,0.18,0.08"
```

The ROI is the scoreboard region in normalized coordinates
(`x,y,width,height`, each 0..1). In the desktop UI you draw it on a frame
instead (section 2 of the UI).

Outputs land in `output/<video>_<timestamp>/`:

```text
events.json      detected events with signals, confidence and clip info
analysis.json    run metadata (counts, durations, config snapshot)
clips/           goal_01_67m14s.mp4 + goal_01_67m14s_vertical.mp4 ...
logs/analysis.log  per-sample detection log for tuning
```

Every goal produces two clips of the same window with identical audio: the
horizontal original and an action-following 9:16 vertical twin
(`*_vertical.mp4`, 1080x1920, flat in `clips/`). The vertical crop keeps full
source height and pans horizontally. Crop positions update every video frame,
with a centered 1-second smoothing window to avoid stepped pans. No padding
or landscape inset is used.

The default YAML enables a football-trained YOLOv8x detector at 2560px,
using Apple Silicon MPS or CUDA when available (CPU otherwise). The original
nano ONNX model supplies person detections for fallback. Ball candidates are
filtered against the wide-shot player/grass region, confirmed across nearby
frames, and associated independently of players. Short gaps interpolate;
reacquisition can anticipate the pan by up to 0.75 seconds, and loss holds the
last ball position for up to 3 seconds before returning to the player fallback.
These estimates are marked separately from observed ball detections.

Install the heavier optional runtime and both models once:

```bash
uv sync --project python --extra tracking
python/.venv/bin/python python/track/download_model.py
python/.venv/bin/python python/track/download_model.py --football
```

The football checkpoint is about 130 MB, pinned to an upstream revision and
verified by SHA-256. Its [model card](https://huggingface.co/gianpaj/football-players-detection-1)
identifies it as AGPL-3.0. The runtime is local; videos are not uploaded.
Set `vertical.ball_model_path: ""` to use only the faster legacy detector.
Running `uv sync` again without `--extra tracking` removes the optional runtime.

`clip_vertical.tracking` records observed and interpolated ball sample counts.
Missing models or worker errors retain the existing static center-crop fallback
and record the error in the tracking summary. This is still not guaranteed
ball identity tracking: small balls, occlusion, aerial passes, and new camera
angles can cause misses or false detections. The pitch plausibility checks are
intended for wide green-pitch footage and may reject high aerial balls.

## Tuning

Everything the detection depends on lives in `config/default.yaml`:
OCR intervals and confirmation rules, audio spike thresholds, lookback
windows, confidence weights, clip pre/post-roll, dedup window, encoding.
Changes apply on the next run without touching code.

Neural OCR is the default. On Apple Silicon, `ocr.provider: auto` uses the
ONNX Runtime CoreML provider and falls back to neural CPU inference if CoreML
cannot compile the model. Set `ocr.provider: cpu` when comparing performance,
or `ocr.engine: tesseract` to diagnose a regression against the legacy engine.
`ocr.fallback_to_tesseract` is disabled by default because neural misses are
handled by temporal confirmation and invoking the legacy engine is relatively
expensive.

The worker streams cropped frames directly from FFmpeg, avoiding temporary PNG
files. A lightweight visual-change detector runs neural OCR only when the
scoreboard changes (plus periodic refreshes), while still taking independent
confirmation reads after every change. Tune this with
`ocr.change_threshold`, `ocr.refresh_interval_seconds`, or disable it with
`ocr.change_detection_enabled: false` when diagnosing unusual animated layouts.

`analysis.decode_acceleration: auto` performs a short real-world decode probe on
macOS and uses VideoToolbox only when it beats software decoding by a meaningful
margin. Hardware initialization or decode errors transparently retry in
software. Use `videotoolbox` to force a hardware attempt or `software` to skip
the probe. `analysis.json` records `video_decoder` and whether fallback occurred.

## Tests

```bash
npm test        # unit tests + synthetic-VOD end-to-end test (~2 min)
npm run test:ui # Electron UI smoke test (headless, uses xvfb if needed)
```

The e2e test generates a synthetic broadcast (scoreboard graphic + crowd
audio + a sweeping trackable ball) with known goal times and verifies the
full pipeline: baseline handling, anomaly rejection, transitions, timestamps,
dedup, horizontal clips and 1080x1920 vertical twins.

## Benchmark (PRD Milestone 5)

For historical broadcast evaluation, put videos plus manually annotated
`<name>.truth.json` files (ground truth goals + optional per-video ROI)
into a directory, then:

```bash
npm run benchmark -- --dir dataset --roi "0.04,0.03,0.18,0.08"
```

It reports goal recall, precision, duplicate rate, median timestamp error,
clip coverage and vertical-twin coverage against the PRD section 34 targets
(vertical twins have no PRD target yet; the benchmark reports the share of
correctly detected goals whose 1080x1920 twin matches the horizontal window).

## v0.1 scope notes

- Goal detection needs only the scoreboard + audio; speech-to-text is
  intentionally absent (optional v0.2 component) and its absence never
  blocks detection.
- Clip cutting re-encodes by default for frame-accurate boundaries
  (`clips.encoding: copy` switches to stream copy).
- Python worker failures degrade gracefully: audio failures continue
  OCR-only; OCR failure fails the stage and can be retried.
