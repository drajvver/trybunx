# Product Requirements Document — TrybunaTV AI Clip Hunter (VOD Edition)

**Version:** 0.2  
**Status:** Draft  
**Language:** English  
**Primary use case:** Automatic highlight extraction from completed sports broadcast VOD files  
**Initial sport:** Football / soccer

---

## 1. Product Summary

TrybunaTV AI Clip Hunter is a local **Electron desktop application** that analyzes a completed VOD recording of a football broadcast and automatically identifies important moments, starting with goals, then generates short video clips around those events.

The first version does **not** operate during a live broadcast and does **not** integrate with OBS in real time.

The system processes an existing video file after the broadcast has ended.

The MVP should prioritize reliability, explainability, low implementation complexity, and easy offline testing over real-time performance.

---

## 2. Problem Statement

Producing clips manually from a full football broadcast requires an operator to:

1. review the recording,
2. identify important moments,
3. find accurate timestamps,
4. cut the relevant fragments,
5. avoid duplicates,
6. save the resulting clips.

For a 90-minute match, this process is repetitive and time-consuming.

The objective of AI Clip Hunter is to automate the detection and extraction of important moments from the VOD while preserving enough confidence and metadata for later review and tuning.

---

## 3. Goals

### 3.1 Primary Goal

Automatically identify goals in a completed football VOD and generate one clip for each detected goal.

### 3.2 Secondary Goals

The system should be designed so that later versions can detect:

- penalties,
- red cards,
- woodwork,
- big chances,
- controversial situations,
- other configurable interesting moments.

### 3.3 Product Principles

The MVP should:

- work fully offline,
- not require OBS,
- not require real-time processing,
- avoid unnecessary ML complexity,
- use deterministic signals whenever possible,
- store intermediate detections for debugging,
- allow repeated testing on the same VOD,
- support tuning without changing application code,
- use Electron and TypeScript as the primary application stack,
- use Python only for analysis workflows where the Python ecosystem provides a material technical advantage.

---

## 4. Non-Goals for v0.1

The following are explicitly outside the scope of the first version:

- live-stream processing,
- OBS WebSocket integration,
- OBS Virtual Camera,
- NDI capture,
- rolling video buffers,
- real-time clipping,
- live notifications,
- automatic publishing to social media,
- cloud processing,
- automatic team-name recognition,
- full commentary transcription,
- a Python-based application shell or Python-based desktop UI,
- perfect classification of every football event,
- multi-sport support.

---

## 5. Primary User Flow

The expected workflow is:

```text
User selects VOD
      |
      v
System scans video and audio
      |
      v
Candidate events are detected
      |
      v
Signals are combined
      |
      v
Events are classified
      |
      v
Clips are generated
      |
      v
events.json + clips/
```

Example:

```text
match.mp4

      |
      +--> scoreboard OCR
      |
      +--> audio analysis
      |
      +--> optional speech analysis
      |
      v

event detection

      |
      v

Goal detected at 67:14

      |
      v

goal_67m14s.mp4
```

---

## 6. Input Requirements

### 6.1 Supported Input

The MVP should accept a local video file.

Preferred initial formats:

- MP4,
- MKV,
- MOV.

Actual compatibility may depend on FFmpeg support.

### 6.2 Minimum Input Requirements

The VOD must contain:

- video,
- at least one audio track.

For goal detection based on OCR, the broadcast should display a visible scoreboard with the current score for most of the match.

### 6.3 Input Assumptions

For v0.1:

- one scoreboard layout is configured per analysis session,
- the user may manually define the scoreboard ROI,
- team names do not need to be recognized,
- only numeric score values are required.

---

## 7. Output Requirements

Each analyzed VOD should create an output directory.

Example:

```text
output/
  match_2026_08_10/
    events.json
    analysis.json
    clips/
      goal_01_67m14s.mp4
      goal_02_81m05s.mp4
    logs/
      analysis.log
```

The application must preserve enough metadata to understand why each event was created.

---

## 8. High-Level Architecture

```text
                    VOD FILE
                       |
           +-----------+-----------+
           |                       |
         VIDEO                   AUDIO
           |                       |
     Frame Sampler            Audio Extractor
           |                       |
     Scoreboard ROI             RMS / Peak
           |                       |
          OCR                 Audio Events
           |                       |
     Score Changes                 |
           |                       |
           +-----------+-----------+
                       |
                 Candidate Engine
                       |
                 Event Aggregation
                       |
                  Classification
                       |
                 Clip Generator
                       |
                  Local Output
```

Speech-to-text is an optional second-stage component and should not be required for the initial goal-only MVP.

---

## 9. Application Architecture and Technology Boundaries

### 9.1 Primary Application Stack

The product should be implemented primarily as an **Electron application using TypeScript**.

Electron is responsible for:

- the desktop UI,
- file selection,
- scoreboard ROI configuration,
- analysis job creation,
- job progress and cancellation,
- configuration management,
- filesystem access,
- FFmpeg and ffprobe orchestration,
- event aggregation and rule-based scoring,
- deduplication,
- clip generation,
- output management,
- logs and diagnostics.

Python must **not** be the default orchestration layer for the application.

### 9.2 Python Usage Policy

Python may be used only for workflows where it is technically justified by the available computer-vision, speech, or machine-learning ecosystem.

Expected examples include:

- OCR engines that require or strongly benefit from Python libraries,
- OpenCV-based image preprocessing when an equivalent Node implementation is not sufficiently reliable,
- `faster-whisper`,
- ONNX / PyTorch inference where the selected model or library is materially easier or more stable in Python,
- future ML-based event classifiers.

Python should not be used for:

- desktop UI,
- file dialogs,
- general application state,
- filesystem orchestration,
- configuration loading,
- FFmpeg command orchestration,
- clip naming,
- output-directory management,
- rule-based event aggregation,
- job history,
- basic logging.

If a workflow can be implemented cleanly and reliably in TypeScript/Node without a material loss in capability, it should remain in the Electron application.

### 9.3 Python Worker Model

When Python is required, it should run as an isolated worker process started by the Electron main process.

Recommended boundary:

```text
Electron / TypeScript
        |
        | structured request
        v
Python analysis worker
        |
        | structured result
        v
Electron / TypeScript
```

The first implementation may use:

- `child_process.spawn`,
- JSON Lines over stdin/stdout,
- temporary JSON files for large batch results,
- file paths for media/frame inputs rather than raw video transfer over IPC.

Example request:

```json
{
  "job_id": "job_0012",
  "operation": "ocr_scoreboard",
  "video_path": "/media/match.mp4",
  "roi": {
    "x": 0.04,
    "y": 0.03,
    "width": 0.18,
    "height": 0.08
  },
  "sample_interval_ms": 1000
}
```

Example result:

```json
{
  "job_id": "job_0012",
  "status": "completed",
  "samples": [
    {
      "timestamp": 4037.0,
      "score": "1:0",
      "confidence": 0.97
    }
  ]
}
```

### 9.4 Process Isolation

A Python worker failure must not crash the Electron application.

The Electron application should:

1. detect an unexpected worker exit,
2. record the worker error,
3. mark the affected analysis stage as failed,
4. continue in a degraded mode when possible,
5. allow the user to retry the failed stage.

For example:

```text
Whisper worker failed
Scoreboard OCR available

=> goal detection continues without STT
```

### 9.5 FFmpeg Boundary

FFmpeg and ffprobe should be invoked directly by the Electron main process.

Python should not wrap FFmpeg unless a specific analysis library requires it internally.

Node/Electron should own:

- media probing,
- audio extraction,
- frame extraction requests,
- final clip cutting,
- output validation.

### 9.6 Shared Data Contracts

The Electron application and optional Python workers must communicate through versioned, language-neutral data contracts.

Preferred formats:

- JSON,
- JSON Lines,
- files referenced by path.

Shared domain objects should include at minimum:

- `AnalysisJob`,
- `OCRSample`,
- `AudioEvent`,
- `SpeechSegment`,
- `DetectionSignal`,
- `DetectedEvent`,
- `ClipRequest`,
- `AnalysisResult`.

Python-specific classes must not become the canonical domain model.

### 9.7 Rationale

This architecture keeps the product maintainable as a desktop application while preserving access to Python's stronger ML and computer-vision ecosystem.

It also prevents the project from becoming a Python application with an Electron wrapper.

The intended ownership is:

```text
Electron / TypeScript
    |
    +-- product shell
    +-- workflow orchestration
    +-- domain logic
    +-- media orchestration
    +-- clip generation
    +-- persistence
    |
    +-- optional Python workers
            |
            +-- OCR / CV
            +-- Whisper
            +-- ML inference
```

---

## 10. Processing Model

The system should use a multi-pass offline pipeline.

### Pass 1 — Cheap Analysis

Scan the entire VOD using inexpensive signals:

- scoreboard OCR,
- audio RMS,
- audio peaks,
- optional simple scene or motion information.

The purpose of this pass is to identify candidate time windows.

### Pass 2 — Detailed Analysis

Run more expensive processing only where useful.

Examples:

- higher-frequency OCR,
- Whisper speech-to-text,
- keyword matching,
- detailed event classification.

### Pass 3 — Clip Generation

After event timestamps and classifications are finalized, generate output clips.

This separation allows the application to analyze the VOD faster than real time on suitable hardware and avoids running expensive models unnecessarily.

---

## 11. Video Processing

### 10.1 Frame Sampling

The entire video does not need to be decoded frame-by-frame for OCR.

Initial configuration:

```yaml
ocr_interval_ms: 1000
```

This means approximately one OCR sample per second.

For a 90-minute match:

```text
90 x 60 = 5,400 OCR samples
```

### 10.2 Fine Scan

When a possible score change is detected, the system may rescan the surrounding region more frequently.

Example:

```text
candidate score change: 67:18

fine scan:
67:14 -> 67:20
interval: 200 ms
```

This should improve event timing without increasing the cost of analyzing the entire match.

---

## 12. Scoreboard ROI

The OCR engine must analyze only a configured scoreboard region.

The user should be able to define:

```yaml
scoreboard_roi:
  x: 100
  y: 40
  width: 320
  height: 90
```

The ROI may be stored as:

- absolute pixels, or
- normalized coordinates.

Normalized coordinates are preferred for future compatibility with multiple resolutions.

---

## 13. OCR Pipeline

Recommended processing pipeline:

```text
video frame
    |
crop ROI
    |
resize
    |
grayscale
    |
contrast / threshold
    |
OCR
    |
score parser
```

The OCR engine should return only score information.

Examples:

```text
0:0
1:0
1:1
2:1
```

Team names are not required in v0.1.

---

## 14. Score State Machine

The system must not treat every OCR result as valid.

### 13.1 Initial State

The first stable score detected in the VOD establishes the baseline.

Example:

```text
first stable OCR:
1:0
```

This must **not** create a goal event.

### 13.2 OCR Stabilization

A new score should only be accepted after repeated confirmation.

Example:

```text
Frame 1: 1:0
Frame 2: 8:0
Frame 3: 1:0
```

`8:0` must be rejected.

Example valid transition:

```text
1:0
2:0
2:0
2:0
```

This may produce:

```text
confirmed_score_change
```

### 13.3 Transition Validation

The system should validate whether a transition is logically possible.

Examples:

```text
1:0 -> 2:0     VALID
1:0 -> 1:1     VALID
1:0 -> 3:0     SUSPICIOUS
1:0 -> 8:0     INVALID
2:1 -> 1:1     INVALID
```

For v0.1, normal accepted transitions should increase exactly one team's score by one.

Suspicious transitions may trigger a local fine scan before being accepted or rejected.

---

## 15. Audio Analysis

Audio analysis should run across the entire file.

The system should extract mono analysis audio, for example:

```text
16 kHz
mono
PCM
```

Audio analysis does not need broadcast-quality audio.

### 14.1 Analysis Windows

Recommended window size:

```text
100-250 ms
```

For each window, calculate:

- RMS,
- peak,
- rolling average,
- delta from local baseline.

### 14.2 Baseline

The baseline should be calculated dynamically.

Example:

```text
baseline = average of previous 10 seconds
current  = current RMS
delta    = current - baseline
```

A large positive delta may generate:

```text
audio_spike
```

A fixed global dB threshold should not be the only criterion.

---

## 16. Goal Detection Strategy

For the initial MVP, a confirmed scoreboard change should be the strongest signal.

The recommended hierarchy is:

```text
confirmed score change
        |
        v
goal candidate
        |
        +--> inspect nearby audio
        |
        v
estimate actual event time
        |
        v
GOAL event
```

A score change should be sufficient to create a goal candidate even if speech-to-text is unavailable.

---

## 17. Event Timestamp Estimation

The scoreboard usually changes after the actual goal.

Therefore, the time of the score change should not automatically be used as the goal timestamp.

Example:

```text
score change detected:
67:18.0

search audio:
67:06 -> 67:18

largest excitement peak:
67:14.2

estimated event time:
67:14.2
```

The exact algorithm should be configurable.

Possible strategy:

1. detect confirmed score change,
2. inspect audio in a configurable lookback window,
3. identify the strongest relevant audio peak,
4. use that time as the estimated event time,
5. fall back to score-change time minus a default offset if no useful peak exists.

Example configuration:

```yaml
goal_audio_lookback_seconds: 12
goal_fallback_offset_seconds: 4
```

---

## 18. Event Model

Each event should have a structured representation.

Example:

```json
{
  "id": "event_0007",
  "type": "GOAL",
  "event_time": 4034.2,
  "detected_from_score_change": 4038.0,
  "confidence": 0.94,
  "score_before": "1:0",
  "score_after": "2:0",
  "signals": {
    "score_change": true,
    "audio_spike": true,
    "audio_delta_db": 13.8,
    "keyword_goal": false
  }
}
```

The event time and detection time must be stored separately.

---

## 19. Event Aggregation

Signals should be clustered by timestamp.

Recommended starting window:

```yaml
event_window_seconds: 8
```

Example:

```text
4032.1 audio spike
4033.5 keyword "shot"
4035.2 keyword "goal"
4038.0 score change
```

These signals may represent one event.

Offline processing makes it possible to examine both earlier and later signals before finalizing an event.

---

## 20. Event Classification

Initial supported classification:

```text
GOAL
UNKNOWN_INTERESTING
```

Later versions may add:

```text
PENALTY
RED_CARD
WOODWORK
BIG_CHANCE
```

Classification and clip creation should be separate concepts.

For example:

```text
classification = GOAL
confidence = 0.94
clip_policy = CREATE
```

Future event types may require different confidence thresholds.

---

## 21. Confidence

Confidence should describe how strongly available signals support the event.

Example rule-based starting point:

```text
confirmed score change      +0.70
strong audio peak           +0.15
goal keyword                +0.10
multiple agreeing signals   +0.05
```

The exact formula is not fixed for v0.1 and should remain configurable.

A confirmed valid scoreboard transition should have enough weight to create a goal event on its own.

---

## 22. Deduplication

The system must avoid generating duplicate goal events.

Deduplication should use event semantics instead of a single global cooldown.

For goals, the primary deduplication key should include:

```text
score_before
score_after
```

Example:

```text
1:0 -> 2:0
```

If the same transition is detected multiple times within a short period, it must produce only one event.

Suggested additional deduplication window:

```yaml
goal_dedup_seconds: 20
```

The deduplication window must not block a logically different score transition.

Example:

```text
1:0 -> 2:0
2:0 -> 2:1
```

These are always separate events.

---

## 23. Clip Generation

The Clip Generator should use FFmpeg.

Standard goal clip configuration:

```yaml
goal_pre_roll_seconds: 14
goal_post_roll_seconds: 12
max_clip_seconds: 30
```

Example:

```text
event_time = 4034.2

clip:
4020.2 -> 4046.2
```

The resulting clip is 26 seconds.

### 22.1 Boundary Handling

If an event occurs near the beginning or end of the file, clip boundaries must be clamped to valid media timestamps.

Example:

```text
event = 5 seconds
pre-roll = 14 seconds

actual clip start = 0
```

### 22.2 Encoding

Prefer stream copy when technically safe and sufficiently accurate.

If exact cut boundaries require re-encoding, only the final clip should be re-encoded.

The implementation should prioritize correct output over avoiding re-encoding.

---

## 24. Speech-to-Text

Speech-to-text is optional for the first goal-only MVP.

Recommended engine for later versions:

```text
faster-whisper
```

Recommended language:

```text
Polish
```

### 23.1 Selective STT

Whisper should not necessarily process the full 90-minute VOD.

Preferred architecture:

```text
cheap scan
   |
candidate windows
   |
Whisper only around candidates
```

Example:

```text
candidate:
67:14

STT window:
67:04 -> 67:24
```

This significantly reduces processing cost.

---

## 25. Keyword Engine

When STT is enabled, the system should support configurable keywords.

Example:

```yaml
keywords:
  goal:
    weight: 30
    patterns:
      - gol
      - gool
      - goool
      - bramka

  penalty:
    weight: 25
    patterns:
      - karny
      - rzut karny

  red_card:
    weight: 40
    patterns:
      - czerwona kartka
```

Matching should tolerate elongated speech and minor transcription differences.

Examples:

```text
gol
gool
goool
gooooool
```

These should be normalized to the same logical keyword.

---

## 26. Configuration

The application should keep tuning parameters outside the source code.

Recommended format:

```text
config.yaml
```

Example:

```yaml
analysis:
  ocr_interval_ms: 1000
  fine_ocr_interval_ms: 200
  event_window_seconds: 8

ocr:
  confirmation_reads: 3
  confirmation_window_seconds: 3

audio:
  sample_rate: 16000
  rms_window_ms: 200
  baseline_seconds: 10

goal_detection:
  audio_lookback_seconds: 12
  fallback_offset_seconds: 4
  dedup_seconds: 20

clips:
  goal_pre_roll_seconds: 14
  goal_post_roll_seconds: 12
  max_clip_seconds: 30
```

---

## 27. Logging

All meaningful intermediate detections should be logged.

Example:

```text
[67:16.000] OCR 1:0
[67:17.000] OCR 2:0
[67:18.000] OCR 2:0
[67:19.000] OCR 2:0
[67:19.000] SCORE_CHANGE 1:0 -> 2:0
[67:14.200] AUDIO_SPIKE +13.8 dB
[67:19.020] EVENT GOAL confidence=0.94 event_time=67:14.200
[67:19.500] CLIP_REQUEST 67:00.200 -> 67:26.200
```

Detailed logging is required because the detection algorithm will need tuning on real historical broadcasts.

---

## 28. Analysis Metadata

In addition to `events.json`, each run should produce analysis metadata.

Example:

```json
{
  "input_file": "match.mp4",
  "duration_seconds": 5524.8,
  "video_resolution": "1920x1080",
  "analysis_started_at": "2026-09-02T14:00:00Z",
  "ocr_samples": 5525,
  "score_changes_detected": 4,
  "goal_events_created": 4,
  "clips_created": 4,
  "processing_seconds": 821.4
}
```

This data will help benchmark performance and regression-test later versions.

---

## 29. Electron UI Requirements

The v0.1 product should include a minimal Electron desktop interface.

The UI is not expected to be a full editing suite.

It must support the core workflow:

```text
Select VOD
   |
Configure scoreboard ROI
   |
Start analysis
   |
View progress
   |
Review detected events
   |
Open / preview generated clips
```

### 29.1 Required Screens or States

The application should provide:

- VOD file selection,
- basic media metadata,
- scoreboard ROI selection or configuration,
- analysis settings,
- Start Analysis action,
- progress by analysis stage,
- cancel action,
- detected-event list,
- generated-clip list,
- Open Output Folder action,
- readable error state.

### 29.2 ROI Selection

The user should be able to open a representative video frame and draw the scoreboard ROI.

The ROI should be persisted with the analysis configuration.

### 29.3 Analysis Progress

Progress should be stage-based.

Example:

```text
Preparing media             complete
Scanning scoreboard         72%
Analyzing audio             complete
Building events             pending
Generating clips            pending
```

The UI should not freeze while analysis is running.

### 29.4 Job Cancellation

The user must be able to cancel an active analysis job.

Cancellation should terminate:

- active FFmpeg processes,
- active Python workers owned by the job,
- pending analysis stages.

Already-generated output may remain on disk but must be marked as belonging to an incomplete job.

---

## 30. Error Handling

The system should fail clearly when:

- the input file cannot be decoded,
- no video track exists,
- no audio track exists,
- the scoreboard ROI is invalid,
- FFmpeg cannot generate the output clip,
- OCR cannot initialize.

The application should distinguish fatal errors from degraded functionality.

Example:

```text
Audio analysis unavailable
OCR available

=> continue in OCR-only mode
```

Speech-to-text failure should never prevent goal detection in the v0.1 architecture.

---

## 31. Suggested Project Structure

```text
clip_hunter/
|
+-- package.json
+-- electron-builder.yml
+-- tsconfig.json
|
+-- src/
|   |
|   +-- main/
|   |   +-- index.ts
|   |   +-- ipc.ts
|   |   |
|   |   +-- jobs/
|   |   |   +-- analysis_job.ts
|   |   |   +-- job_runner.ts
|   |   |
|   |   +-- media/
|   |   |   +-- ffprobe.ts
|   |   |   +-- ffmpeg.ts
|   |   |   +-- frames.ts
|   |   |   +-- audio.ts
|   |   |
|   |   +-- detection/
|   |   |   +-- score_state.ts
|   |   |   +-- audio_events.ts
|   |   |   +-- goal_detector.ts
|   |   |   +-- event_aggregator.ts
|   |   |   +-- dedup.ts
|   |   |
|   |   +-- clips/
|   |   |   +-- generator.ts
|   |   |
|   |   +-- workers/
|   |       +-- python_worker.ts
|   |
|   +-- renderer/
|   |   +-- app.tsx
|   |   +-- components/
|   |   +-- screens/
|   |
|   +-- shared/
|       +-- contracts.ts
|       +-- config.ts
|       +-- models.ts
|
+-- python/
|   +-- worker.py
|   +-- requirements.txt
|   |
|   +-- ocr/
|   |   +-- engine.py
|   |   +-- preprocessing.py
|   |
|   +-- speech/
|       +-- whisper.py
|
+-- config/
|   +-- default.yaml
|
+-- output/
+-- tests/
```

The `python/` directory should remain optional from the perspective of application architecture. It contains specialized analysis workers, not the product shell.

---

## 32. MVP Development Plan

### Milestone 1 — Deterministic Clipping

Input:

```text
VOD + manually supplied timestamp
```

Output:

```text
correctly cut MP4 clip
```

Requirements:

- FFmpeg integration,
- pre-roll,
- post-roll,
- max clip length,
- boundary handling.

---

### Milestone 2 — Scoreboard Detection

Add:

- video frame sampling,
- ROI configuration,
- OCR,
- score parsing,
- score stabilization,
- valid score-transition detection.

Output:

```text
list of confirmed score changes
```

---

### Milestone 3 — Automatic Goal Clips

Connect confirmed score changes to clip generation.

Pipeline:

```text
VOD
 |
OCR
 |
score change
 |
estimated event timestamp
 |
FFmpeg
 |
goal clip
```

At this milestone the system is already a usable first product.

---

### Milestone 4 — Audio Timing

Add:

- RMS analysis,
- rolling baseline,
- audio spike detection,
- goal timestamp refinement.

Purpose:

Improve clip timing so that the action appears naturally inside the generated clip.

---

### Milestone 5 — Evaluation and Tuning

Build a benchmark dataset from historical broadcasts.

For every VOD, store ground truth such as:

```json
{
  "events": [
    {
      "type": "GOAL",
      "timestamp": 4034.5
    }
  ]
}
```

Run the same pipeline repeatedly and measure:

- recall,
- precision,
- timestamp error,
- duplicate rate,
- clip correctness.

---

### Milestone 6 — Extended Event Detection

Only after goal detection is reliable, add:

- Whisper,
- keyword matching,
- red cards,
- penalties,
- woodwork,
- big chances.

---

## 33. Test Dataset

A representative validation set should contain multiple historical TrybunaTV broadcasts.

Recommended initial dataset:

```text
10-20 full matches
```

The dataset should include:

- matches with no goals,
- matches with one goal,
- high-scoring matches,
- scoreboard graphics changes,
- replays,
- loud crowd reactions without goals,
- commentary excitement without goals,
- temporary scoreboard disappearance,
- half-time graphics,
- score corrections if available.

Ground truth must be manually annotated.

---

## 34. Metrics

### 32.1 Goal Recall

```text
correctly detected real goals
-----------------------------
all real goals
```

Initial target:

```text
>= 90%
```

### 32.2 Goal Precision

```text
correct goal detections
-----------------------
all generated goal detections
```

Initial target:

```text
>= 95%
```

### 32.3 Duplicate Rate

Target:

```text
0 duplicate clips for the same score transition
```

### 32.4 Timestamp Accuracy

Measure:

```text
abs(predicted_event_time - ground_truth_event_time)
```

Initial target:

```text
median error <= 3 seconds
```

### 32.5 Clip Coverage

A generated clip should include the actual goal moment.

Target:

```text
>= 95% of correctly detected goals
```

---

## 35. Definition of Done — v0.1

The MVP is considered complete when it can process the agreed benchmark dataset and:

1. accept a full local football VOD,
2. complete analysis without crashing,
3. correctly establish the initial score without generating an event,
4. detect valid scoreboard score changes,
5. reject obvious OCR score anomalies,
6. generate at most one goal event per real score transition,
7. generate one MP4 clip for each detected goal,
8. keep every generated clip at or below 30 seconds,
9. include the actual goal moment in at least 95% of correctly detected goal clips,
10. achieve at least 90% goal recall on the benchmark dataset,
11. achieve at least 95% goal precision on the benchmark dataset,
12. generate `events.json`,
13. generate analysis logs,
14. allow detection thresholds and timing parameters to be changed through configuration without source-code modifications.
15. run as an Electron desktop application,
16. keep core workflow orchestration and clip generation in TypeScript/Node,
17. isolate any Python-based OCR/STT/ML work behind a worker-process boundary,
18. remain usable for goal detection when optional STT functionality is unavailable.

---

## 36. Future Versions

### v0.2

Potential additions:

- faster-than-real-time optimization,
- selective Whisper analysis,
- keyword engine,
- penalty detection,
- red-card detection,
- woodwork detection,
- improved confidence model.

### v0.3

Potential additions:

- automatic scoreboard ROI detection,
- support for multiple scoreboard layouts,
- batch processing,
- richer review UI,
- clip preview and approval workflow,
- automatic title generation,
- social-media export.

### Later

Once the offline detection quality is proven, the same event-detection logic may be adapted to live processing.

A future live version may add:

- OBS integration,
- rolling buffers,
- live event state,
- real-time resource management,
- delayed clip generation.

The offline VOD version should therefore keep detection logic independent from media-capture logic wherever practical.

---

## 37. Key Architectural Decision

The first product should be built as an **offline VOD analyzer**, not a live broadcast companion.

The product shell should be an **Electron/TypeScript desktop application**. Python is an implementation detail for specialized analysis tasks, not the primary application runtime.

The central product problem is:

```text
Can we reliably identify important moments?
```

It is not initially:

```text
Can we process them in real time?
```

Separating those problems reduces implementation risk and makes the detection system objectively testable on a fixed historical dataset.

The recommended first production-quality detection path is:

```text
VOD
 |
+--> Scoreboard OCR
|       |
|       +--> confirmed score transition
|
+--> Audio analysis
        |
        +--> excitement peaks

           |
           v

      Goal Detector

           |
           v

      Event timestamp

           |
           v

          FFmpeg

           |
           v

       Goal clip
```

Speech-to-text and more advanced event classification should only be added after this baseline performs reliably.
