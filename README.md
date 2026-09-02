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
            +-- scoreboard OCR (OpenCV + Tesseract)
```

- `src/main/` — Electron main process: pipeline, detection, clips, IPC
- `src/renderer/` — UI (React)
- `src/shared/` — language-neutral data contracts and configuration
- `python/` — OCR worker (`worker.py`); never the application shell
- `config/default.yaml` — all detection thresholds and timing parameters

## Setup

Requirements: Node 20+, Python 3.10+, ffmpeg, tesseract-ocr, (xvfb for
headless UI tests).

```bash
npm install
npm run python:setup     # creates .venv with opencv + pytesseract
```

If ffmpeg/tesseract are missing:
- Ubuntu/Debian: `sudo apt install ffmpeg tesseract-ocr`
- macOS: `brew install ffmpeg tesseract`
- Windows: install both and set `TRYBUNX_FFMPEG_PATH` / `TESSERACT_CMD`

### macOS notes

The app works on Apple Silicon and Intel Macs. Homebrew-installed binaries
are found even when the app is launched from Finder (the app probes
`/opt/homebrew/bin` and `/usr/local/bin`; you can also set
`TRYBUNX_FFMPEG_PATH` / `TESSERACT_CMD` / `TRYBUNX_PYTHON`).

Build a distributable dmg (bundles the Python worker + deps, so end users
only need ffmpeg + tesseract, which a future release will bundle too):

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
clips/           goal_01_67m14s.mp4 ...
logs/analysis.log  per-sample detection log for tuning
```

## Tuning

Everything the detection depends on lives in `config/default.yaml`:
OCR intervals and confirmation rules, audio spike thresholds, lookback
windows, confidence weights, clip pre/post-roll, dedup window, encoding.
Changes apply on the next run without touching code.

## Tests

```bash
npm test        # unit tests + synthetic-VOD end-to-end test (~2 min)
npm run test:ui # Electron UI smoke test (headless, uses xvfb if needed)
```

The e2e test generates a synthetic broadcast (scoreboard graphic + crowd
audio) with known goal times and verifies the full pipeline: baseline
handling, anomaly rejection, transitions, timestamps, dedup and clips.

## Benchmark (PRD Milestone 5)

For historical broadcast evaluation, put videos plus manually annotated
`<name>.truth.json` files (ground truth goals + optional per-video ROI)
into a directory, then:

```bash
npm run benchmark -- --dir dataset --roi "0.04,0.03,0.18,0.08"
```

It reports goal recall, precision, duplicate rate, median timestamp error
and clip coverage against the PRD section 34 targets.

## v0.1 scope notes

- Goal detection needs only the scoreboard + audio; speech-to-text is
  intentionally absent (optional v0.2 component) and its absence never
  blocks detection.
- Clip cutting re-encodes by default for frame-accurate boundaries
  (`clips.encoding: copy` switches to stream copy).
- Python worker failures degrade gracefully: audio failures continue
  OCR-only; OCR failure fails the stage and can be retried.
