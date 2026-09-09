# TrybunaTV AI Clip Hunter — Project Journal

Single source of truth for what has been built, verified, decided, and what
remains. PRD reference: `prd.md` (v0.2 of the document, VOD edition).

---

## 2026-09-09 — Action-following 9:16 vertical twins (ball failed on real footage)

- Ball-only following does not work on real TrybunaTV broadcasts: YOLOv8n
  `sports-ball` peaks at conf 0.0003-0.02 on real 1920x1080 frames (ball is
  ~10-25 px wide = ~5 px in the 640 model input; verified even zoomed crops
  and pitch-band upscales stay at 0.001-0.004). COCO `person` on the same
  pass reads 0.6-0.9, so the tracker now follows the action instead.
- Every goal clip gets a flat 9:16 twin (`goal_01_67m14s_vertical.mp4`,
  1080x1920, same window + same AAC audio): `src/main/vertical/` (tracker,
  smoothing, sendcmd crop command, renderer) + `generateClips` extension in
  `src/main/clips/generator.ts`. Contracts: `clip_vertical` on
  `DetectedEvent`, `variant/width/height/tracking` on `ClipInfo`,
  `vertical_clips_created/vertical_center_fallbacks` in metadata.
- Tracking (`python/track/ball.py`, `track_ball_video` worker op): one YOLOv8n
  ONNX forward pass per sampled frame serves both heads (refactored
  `predict()` + `detect_from()`; inference halved vs two passes, ~19 ms/frame
  full-res). The follow point is the tallest top-k `person` box (closest to
  camera = the close-up the broadcast is showing; edge-down-weighted so
  players walking out of frame don't drag the crop), with the ball used only
  when trusted (conf >= `ball_trust` 0.30) and continuous (near last pos).
  Greedy link gate 288 px/frame, lost-streak resync after 3 s, weak-cluster
  gate via `cluster_trust` (0 = accept all). Full-resolution sampling
  (`max_width: 0`): verified 960 px downscale collapses the cluster to 1/75
  samples while full-res tracks 61-74/75. New config: `ball_trust`,
  `cluster_trust`, `resync_after_lost_seconds`, `person_confidence` 0.25.
- Verified on real footage: short.webm goal window (135-160 s) 61/75 tracked
  with the celebration zoom kept in frame (t=147/149/152 frames checked);
  goal2.webm (10-35 s) 73/75, max jump 182 px, no teleports. Frame-by-frame
  person dump (`/tmp/opencode/real/short_persons.json`, throwaway) confirmed
  tallest-box selection tracks the zoomed celebration, not the still group.
- Render: full-height crop (`w=ih*9/16`) panned by FFmpeg `sendcmd` driving
  `crop x` at 5 cmds/s (verified on FFmpeg 9: red-left/blue-right fixture
  flips color exactly at the command timestamp), then `scale=1080:1920`.
  Smoothing is pure/unit-tested: nearest-sample targets, hold-last
  (`lost_hold_seconds`), smoothstep ease-to-center (`recenter_seconds`),
  moving average, max-pan-speed clamp, bounds clamp.
- Synthetic fixture: `scripts/make_synthetic_match.ts` overlays a trackable
  r=20 disc per goal in a chunked second pass; E2E asserts twins per goal.
- Tests: typecheck clean, 46 TS unit + 20 python unittest pass
  (`PYTHONPATH=python ... discover`), proxy render test rewritten onto the
  two real goal windows (25 s each, 1080x1920, >=60% tracked, travel >200 px).
  Full synthetic E2E not runnable on this Mac (no `drawtext` in Homebrew
  FFmpeg).
- Benchmark reports `vertical_coverage` alongside the PRD §34 metrics.
- UI: results table shows both clip buttons per row; settings card shows the
  vertical spec.
- Known limits: only horizontal pan (full-height crop leaves no Y room);
  the ball head is opportunistic (real-ball conf ~0.05-0.8 when close, mostly
  absent); celebration zoom keeps players, not the ball, in frame — that is
  the intended behavior; FootAndBall-style dedicated ball models checked,
  no maintained repo/weights found (only a temporal-fusion fork referencing
  the original architecture).

---

## 2026-09-02 — Streaming OCR and temporal reuse

- Replaced the coarse/fine scan PNG handoff with a raw BGR24 pipe from FFmpeg
  to the persistent Python worker. Frames are cropped and upscaled before they
  enter Python, so analysis no longer writes hundreds of temporary images.
- Added a cheap downsampled-frame change detector. Unchanged frames reuse the
  last OCR result, periodic refreshes protect against subtle changes, and each
  detected change triggers the configured number of independent OCR reads so a
  single mistaken read cannot satisfy temporal confirmation by itself.
- Added configuration for the change threshold/refresh interval and metadata
  counters for inferred versus reused samples.
- Verified with the exact app ROI on the 5-minute `short.webm`: 274/300 readable,
  baseline `0:0`, refined `0:0 -> 0:1` at 151.4 s, goal event at 147.4 s, and
  one clip. The accuracy-preserving run inferred 130 frames and reused 170;
  CoreML inference was 2.03 s and total app-recorded processing was 15.3 s,
  versus the prior 3.79 s and 18.8 s respectively.
- Verification: 6 Python tests and 38 non-E2E TypeScript tests pass; typecheck
  is clean. The synthetic E2E remains unavailable on this Mac because the
  installed FFmpeg lacks `drawtext`.

## 2026-09-02 — Adaptive macOS hardware decoding

- Added `analysis.decode_acceleration`: `auto`, `videotoolbox`, or `software`.
  Auto mode benchmarks a short section through the actual fps/crop/scale graph
  and selects VideoToolbox only when it is at least 10% faster. Any hardware
  initialization or mid-stream decode failure retries the scan in software.
- Decoder choice and fallback are recorded in `analysis.json` and the analysis
  log. Fine scans reuse the coarse scan's choice without repeating the probe.
- This Mac and FFmpeg expose VideoToolbox and successfully decode the AV1 sample,
  but forced hardware took 48.5 s versus 15.3 s for software because filtered
  frames must cross back to CPU memory. Auto therefore correctly selected
  software (17.2 s including its one-time probe).
- Verified the forced hardware path and a simulated unavailable-hardware path;
  both retained 274/300 readable samples, the `0:0 -> 0:1` transition, goal,
  and clip. The simulated failure recorded `hardware_decode_fallback: true`.

## 2026-09-02 — Mac-first neural OCR

- Replaced Tesseract as the default with RapidOCR PP-OCRv6 models running via
  ONNX Runtime. `ocr.provider: auto` selects CoreML on macOS and neural CPU
  elsewhere; CoreML initialization failure falls back to neural CPU. The old
  Tesseract engine remains available explicitly but is no longer required.
- Added persistent model sessions, real model confidence, provider/engine
  diagnostics, per-run inference timing, and geometry-aware parsing for
  scoreboards whose two digits are separate boxes without a textual colon.
- Added automatic layout calibration: the first full OCR pass locates the one
  score line or two digit boxes, then later frames use recognition-only crops.
  This reduced warm per-frame CPU inference on the real sample from about
  0.36 s to about 0.008 s; CoreML is selectable and measured independently.
- Fixed frame extraction's `start_number: 0` indexing mismatch, which skipped
  frame zero and requested one nonexistent final frame.
- Final real 5-minute 1920x1080 AV1 smoke run on Apple Silicon/CoreML: 276/300
  readable samples, baseline `0:0`, transition `0:0 -> 0:1`, one goal and one
  clip. Total time was 24.1 s (7.75 s neural inference), versus 47 s and 0/300
  readable samples for the original Tesseract run on the same file and ROI.
  An interim compatibility run showed legacy fallback only added cost, so it is
  now off by default.
- Verification: neural parser/inference/calibration tests pass, 38 non-E2E
  TypeScript tests pass, typecheck is clean, and the real-VOD pipeline completed
  end to end. The generated Linux-font synthetic E2E fixture was not rerun on
  macOS because this Homebrew FFmpeg build lacks the `drawtext` filter.

---

## 2026-09-02 — Tight score-only ROI fix

- Diagnosed an app/CLI discrepancy on `short.webm`: the app used a tight
  score-only ROI while the earlier CLI verification used the whole scoreboard.
  PP-OCR returned tight crops as compact `00`/`01` or divider-based `0|1`, which
  the initial parser did not accept. It eventually miscalibrated and treated
  `1:1` as the baseline, so no transition was emitted.
- Added divider and tightly-scoped compact-score parsing. Compact two-digit
  splitting is enabled only for narrow score-only regions/calibrated crops so a
  `22` elsewhere in a full scoreboard cannot be mistaken for `2:2`.
- Added `scoreboard_roi` to `analysis.json` so future runs are reproducible from
  metadata, and replaced removed FFmpeg 8 `-vsync` syntax with `-fps_mode`.
- Verified with the app's exact persisted ROI: 274/300 readable samples,
  baseline `0:0`, refined change `0:0 -> 0:1` at 151.4 s, one goal event and
  clip; 18.8 s total with 3.79 s CoreML inference.

---

## 2026-09-02 — v0.1 implementation complete

### Environment (Ubuntu 24.04 container, no GPU, 4 cores / 8 GB)

- Installed: `ffmpeg 6.1.1`, `tesseract-ocr 5.3.4` (apt), `xvfb`, `libnss3` + Electron GUI deps,
  `python3-pip`; Node 24 / Python 3.12 were preinstalled.
- Python deps in `.venv` via `python/setup.sh` (opencv-python-headless, pytesseract, numpy).
- npm 12 quirk: sandbox env var `npm_config_allow_scripts` overrides `package.json`
  `allowScripts` → installs must run with `env -u npm_config_allow_scripts npm install`.
  `allowScripts` for electron/esbuild/tsx are committed in `package.json`.

### What was built

**Stack:** Electron 33 + TypeScript (strict) via electron-vite; React renderer;
vitest tests; electron-builder config for mac/linux/win. Python is strictly an
isolated OCR worker child process (JSON Lines over stdin/stdout, PRD §9.3);
Electron/Node owns FFmpeg/ffprobe, orchestration, detection, clipping (PRD §9).

**Core pipeline** (`src/main/pipeline/analyze.ts`), stages:
`prepare → scoreboard_scan → audio_analysis → build_events → generate_clips → write_outputs`
with stage progress events, AbortSignal cancellation, degraded-mode handling
(audio failure → OCR-only), and deterministic re-runs (stale clips cleared).

- **Media layer** (`src/main/media/`): ffprobe wrapper, frame extraction
  (ffmpeg `fps` + ROI crop + lanczos upscale → PNGs), 16 kHz mono PCM audio
  extraction, WAV parsing, RMS windowing (200 ms) with rolling 10 s baseline
  and delta-dB spike detection (cooldown + silence floor).
- **Python OCR worker** (`python/worker.py`, `python/ocr/`): protocol ops
  `ping` / `ocr_batch` with progress lines; preprocessing variants
  (Otsu → grayscale → adaptive threshold, stop at first parseable read —
  the crop usually contains green field, which breaks single-Otsu
  binarization); tesseract `--psm 7` digit whitelist; score regex
  `(\d{1,2})[:\- ](\d{1,2})`; structural confidence fallback because Tesseract 5
  LSTM reports `conf=0` for short whitelisted digit strings.
- **Detection** (`src/main/detection/`):
  - `score_state.ts` — sliding-window repeated-confirmation state machine
    (confirmation_reads within confirmation_window, not necessarily
    consecutive), baseline without event, transition validation
    (+1 valid, +2/+3 suspicious → fine-scan resolution, >+3 or decrease
    invalid per PRD §14.3 examples).
  - Fine scans at 200 ms around each candidate change refine change times
    and resolve suspicious transitions (merging fine samples, re-running the
    machine seeded with the change's `from` score).
  - `goal_detector.ts` — event time = *onset* of the strongest audio
    excitement peak in the configurable lookback window (earliest window
    within 1 dB of the max, so the goal roar start wins); fallback
    `change_time − fallback_offset`.
  - `event_aggregator.ts` — signals → 8 s clusters → GOAL /
    UNKNOWN_INTERESTING classification with PRD §21 confidence weights
    (0.70 score change, +0.15 spike, +0.05 agreeing, −0.10 suspicious).
  - `dedup.ts` — semantic dedup by `score_before|score_after` within
    `dedup_seconds` (different transitions never merged).
- **Clips** (`src/main/clips/generator.ts`): pre/post-roll windows with
  boundary clamping, max length cap, re-encode default (libx264 veryfast
  CRF 23 + AAC, accurate cuts) with `encoding: copy` option, per-clip
  ffprobe validation, `goal_01_67m14s.mp4` naming. Individual clip failures
  degrade instead of aborting the run.
- **Outputs** (PRD §7/§28): `output/<video>_<ts>/{events.json, analysis.json,
  clips/, logs/analysis.log}` with per-sample `[mm:ss.mmm]` logging
  (PRD §27).
- **Config**: `config/default.yaml` merged over typed defaults
  (`src/shared/config.ts`) — every threshold/timing parameter is tunable
  without code changes (DoD #14).
- **Electron shell**: `index.ts` (window + app IPC incl. frame extraction for
  the ROI editor), `jobs/job_runner.ts` (single-job manager, cancel,
  stage events to renderer), `settings.ts` (ROI + overrides persisted in
  userData), `paths.ts` (dev vs packaged resource resolution),
  `workers/python_worker.ts` (JSONL client, request timeouts, worker-death
  detection, restartable).
- **Renderer** (`src/renderer/`): VOD picker + metadata, ROI editor (draw on
  a real frame, normalized coords, persisted), settings summary from the
  effective config, start/cancel, stage progress bars, event/clip table,
  open output folder / reveal clip. No freezes (work runs in main process).
- **Headless CLI** (`src/main/cli.ts`): same pipeline core; `npm run analyze
  -- --input x.mp4 --roi "x,y,w,h"`. Enables CI-ish testing without a display.
- **Benchmark runner** (`scripts/benchmark.ts`, PRD M5/§34): truth-file
  dataset (`<video>.truth.json`), computes recall / precision / duplicate
  rate / median timestamp error / clip coverage, writes
  `benchmark_summary.json`.

### Verification

- `npm run typecheck` — clean.
- `npm test` — 41/41 passing, including the synthetic end-to-end:
  - synthetic VOD: 330 s, 1280×720@25, drawtext scoreboard, pink-noise crowd
    with volume automation (generator: `scripts/make_synthetic_match.ts`);
  - ground truth goals at 80/200/300 s, scoreboard updates at 83/203/304 s;
  - result: 3/3 goals, transitions exact, **no baseline event**, event times
    80.0/200.2/300.0 s (≤0.2 s error), fine-scan change times within 1 s of
    scripted updates, 3 clips of 26.0 s (≤ 30 s), zero duplicates.
- Unit tests cover: transition validation, baseline/anomaly/suspicious/
  rejection flows, confirmation-window expiry, dedup semantics, onset peak
  selection, fallback timing, clip clamping/max length, audio spike
  detection/cooldown, clustering/classification, config merge/parse/ROI.
- Electron UI smoke test (`npm run test:ui`, Playwright `_electron` driver
  under xvfb): boots, probes media, gates start button on file+ROI, runs a
  full real-IPC analysis, shows 3 events with clip actions.
- Benchmark run on the synthetic fixture hits all PRD §34 targets
  (100/100/0/0.0 s/100%).
- `npm run dev` and built `out/main` both stay alive under xvfb (GPU process
  error in container is expected; software rendering fallback).

### Mac support (added 2026-09-02)

Code fixes so the app runs on macOS (dev mode + packaged .app):

1. **Binary discovery for GUI-launched apps** — Finder launches get a minimal
   PATH that misses Homebrew. `resolveBinary()` now probes
   `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` (ffmpeg/ffprobe), and the
   Python worker does the same for `tesseract` (`TESSERACT_CMD` env override
   for both).
2. **Resource paths** (`src/main/paths.ts`) — packaged apps get config from
   `Contents/Resources/config`, the worker from `Resources/python`, and
   output defaults to `~/Documents/TrybunaTV`; dev mode keeps project-relative
   paths.
3. **Portable Python mode** — venvs are not relocatable, so packaged builds
   use `python/vendor` (pip `--target`, ~225 MB) on `PYTHONPATH` with the
   system `python3`. Verified on Linux by running the full pipeline with
   `TRYBUNX_PYTHON=/usr/bin/python3` and no venv (3/3 goals).
4. **Packaging** — `npm run dist:mac` (dmg, arm64 + x64, unsigned);
   `electron-builder.yml` ships `python/` + `config/` via `extraResources`
   (outside asar so native binaries stay executable).

### Mac quickstart:

```bash
brew install node ffmpeg tesseract uv     # prereqs
git clone <repo> && cd trybunx
npm install
npm run python:setup                      # uv sync -> python/.venv
npm run dev                               # desktop app
npm test                                  # unit + synthetic e2e
```

Packaged dmg: `npm run python:setup:portable && npm run dist:mac` → unsigned
app; first launch: right-click → Open (or `xattr -cr TrybunaTV*.app`).
The dmg bundles the python worker + deps; ffmpeg/tesseract still come from
Homebrew (or set `TRYBUNX_FFMPEG_PATH` / `TESSERACT_CMD` to absolute paths —
e.g. to copies inside `TrybunaTV.app/Contents/Resources/bin`).

**What could not be verified here:** this container is Linux-only, so
macOS-specific behaviors (Homebrew paths, Gatekeeper, dmg build, GUI PATH
handling, Apple Silicon wheels) are implemented per upstream docs but need a
one-time smoke run on real hardware (see Remaining work).

### Decisions made (deviations / interpretations of the PRD)

- **OCR engine:** Tesseract 5 (LSTM) inside the Python worker, with a
  3-variant preprocessing cascade instead of one fixed binarization — real
  scoreboards sit on varied backgrounds; kept deterministic and CPU-only.
- **Peak selection:** PRD §17 says "strongest relevant audio peak"; we take
  the onset of the excitement (earliest window within 1 dB of the max) since
  the roar onset, not its loudest fluctuation, coincides with the goal.
- **Suspicious transitions:** accepted as single events after fine-scan
  resolution attempts, with a −0.10 confidence penalty; a +2 jump that fine
  scan proves to be two +1 steps becomes two events.
- **UNKNOWN_INTERESTING:** classified and logged but not clipped by default
  (`clips.create_clips_for_unknown: false`) to protect goal precision (§20/§34).
- **Clip cutting:** re-encode by default for frame-accurate cuts; `copy`
  available via config (PRD §23.2 allows this prioritization).
- **Repeated runs into the same run dir** clear stale clips for deterministic
  benchmarking (PRD §3.3).
- **STT:** intentionally absent in v0.1; `python/speech/whisper.py` documents
  the future op contract. Goal detection never depends on it (DoD #18).

### Known limitations (v0.1)

- OCR sampling still decodes the whole file (fps filter), although frame OCR is
  skipped while the ROI is visually unchanged. Decode speed now dominates and
  depends heavily on source codec and hardware; selective/keyframe decoding is
  still v0.2 scope.
- Only one scoreboard layout / ROI per run (PRD §6.3); ROI is drawn manually.
- Half-time graphics / replays that cover the scoreboard simply produce
  unreadable samples; they don't confuse the state machine but aren't
  specially handled.
- Tesseract conf=0 quirk makes confidence coarse (variant-position based).
- No auto-update, no signing/notarization, no crash reporting.

### 2026-09-02 — uv migration for the Python worker

The first `npm run python:setup` attempt on the user's Mac failed: system
`python3` was < 3.10 while pinned deps needed >= 3.10 (pip error listed every
rejected numpy version). Fixed by moving the Python side fully to uv:

- Deps moved from `python/requirements.txt` (deleted) to
  `python/pyproject.toml` with `requires-python = ">=3.10"` and range
  constraints (opencv >=4.8 <6, pytesseract, numpy >=1.26 <3).
- Python pinned via `python/.python-version` (3.12; uv uses an installed
  interpreter or auto-downloads).
- `python/setup.sh` is now a thin uv wrapper:
  - default: `uv sync --project python` → `python/.venv` (+ `uv.lock`),
  - `--portable`: `uv export` + `uv pip install --target python/vendor`
    (relocatable, for packaged apps).
- Interpreter discovery (`src/main/paths.ts`, `pipeline/analyze.ts`) now
  checks `python/.venv/bin/python` first (Windows `Scripts/python.exe`
  aware), then legacy root `.venv`, then `python3`.
- Verified in-container with uv 0.12.9: `uv sync`, e2e via default discovery
  (3/3 goals), portable mode via `TRYBUNX_PYTHON=/usr/bin/python3` (3/3
  goals), typecheck clean, 41/41 tests. Latest deps validated
  (opencv-python-headless 5.0.0, numpy 2.5.2).

---

## Remaining work / backlog

### Must do before calling v0.1 "done" on real data

- [ ] **Benchmark dataset** (PRD §33): collect 10–20 historical TrybunaTV VODs,
      manually annotate ground truth (`<video>.truth.json`), including
      no-goal matches, high-scoring matches, graphics changes, replays, loud
      crowd moments without goals, scoreboard disappearance, score corrections.
- [ ] **Tune thresholds on real footage**: `min_confidence`, confirmation
      reads/window, spike threshold, lookback, pre/post-roll. Expect OCR
      preprocessing to need broadcast-specific tweaks (real scoreboards vary a
      lot more than the synthetic one).
- [ ] **macOS hardware smoke test** (one-time, not doable in this container):
      brew prereqs → `npm run dev`; `npm run python:setup:portable && npm run
      dist:mac` → open the dmg, Gatekeeper bypass, run one analysis from the
      packaged app; confirm Finder-launched PATH handling finds
      ffmpeg/tesseract; verify output lands in `~/Documents/TrybunaTV`.
- [ ] **Real-recall/precision measurement** with `npm run benchmark` against
      the annotated dataset; record results here per config version.
- [ ] Cancel/kill verification on macOS (SIGTERM propagation to ffmpeg/python
      child processes; `AbortController` path is tested only on Linux).

### Should do (v0.1.x)

- [ ] Bundle ffmpeg/ffprobe binaries (LGPL builds) into
      `Resources/bin` on mac/win so the app has zero external prereqs; resolve
      via `TRYBUNX_FFMPEG_PATH` set by the main process at startup.
- [ ] OCR speedups: investigate hardware decode and selective/keyframe seeking;
      cache the Tesseract instance for legacy mode and test lower upscale values.
- [ ] Multi-workspace progress details (log tail in the UI while running).
- [ ] Retry-failed-stage button in the UI (PRD §9.4 step 5).
- [ ] Installer-level code signing + notarization for mac; cert config for win.
- [ ] Validate MKV/MOV inputs and odd pixel formats (10-bit, HDR) end-to-end.

### v0.2 (PRD §36)

- [ ] faster-whisper worker (Polish, `stt_window` op contract documented in
      `python/speech/whisper.py`), selective STT around candidate windows only.
- [ ] Keyword engine (gol/bramka/karny/…, elongation-tolerant matching,
      weights in config) feeding `keyword_goal` signal + confidence.
- [ ] Penalty / red-card / woodwork event types behind per-type confidence
      thresholds and clip policies.
- [ ] Faster-than-real-time coarse pass (keyframe seek + selective decode).
- [ ] Improved confidence model (calibrated against benchmark data).

### v0.3+ (PRD §36)

- [ ] Automatic scoreboard ROI detection, multiple layouts per match.
- [ ] Batch processing of a folder of VODs.
- [ ] Clip preview/approval workflow in the UI, richer review UI.
- [ ] Automatic clip titles, social-media export.
- [ ] Live/OBS edition once offline detection quality is proven (keep
      detection logic media-capture-agnostic — current pipeline design
      already isolates it in `src/main/detection` + `pipeline`).
