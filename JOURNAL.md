# TrybunaTV AI Clip Hunter — Project Journal

Single source of truth for what has been built, verified, decided, and what
remains. PRD reference: `prd.md` (v0.2 of the document, VOD edition).

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

**Mac quickstart:**

```bash
brew install node ffmpeg tesseract        # prereqs
git clone <repo> && cd trybunx
npm install
npm run python:setup                      # dev: .venv   (or python:setup:portable)
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

- OCR sampling decodes the whole file (fps filter) — a 90 min 1080p VOD takes
  roughly 10–20 min for the coarse pass on 4 cores, plus audio pass; fine
  scans are cheap. Faster-than-real-time is v0.2 scope (PRD §36).
- Only one scoreboard layout / ROI per run (PRD §6.3); ROI is drawn manually.
- Half-time graphics / replays that cover the scoreboard simply produce
  unreadable samples; they don't confuse the state machine but aren't
  specially handled.
- Tesseract conf=0 quirk makes confidence coarse (variant-position based).
- No auto-update, no signing/notarization, no crash reporting.

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
- [ ] OCR speedups: skip extraction entirely when the ROI is unchanged
      (frame-hash prefilter), cache tesseract instance per worker, consider
      `--oem 1` and downscale experiments (upscale=3 is the current default).
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
