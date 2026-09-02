# NVIDIA/CUDA Acceleration Handoff

Status: investigation and implementation plan only. No NVIDIA-specific code has
been implemented or tested yet.

This document records the assumptions, expected gains, architecture, fallback
requirements, packaging risks, and acceptance tests for adding NVIDIA support to
TrybunaTV AI Clip Hunter.

## Current baseline

The current pipeline is Mac-first:

- FFmpeg streams a cropped/upscaled scoreboard ROI as raw BGR24 frames into the
  persistent Python worker.
- A cheap temporal change detector avoids redundant OCR, but still schedules
  independent confirmation reads after a visual change.
- RapidOCR PP-OCRv6 runs through ONNX Runtime. `ocr.provider: auto` chooses
  CoreML on macOS and CPU elsewhere.
- `analysis.decode_acceleration: auto` benchmarks VideoToolbox against software
  on macOS, chooses hardware only when it is at least 10% faster, and retries in
  software after hardware failure.
- Clip re-encoding uses `libx264`. Audio extraction and RMS analysis are CPU
  operations.

Reference result using `/Users/kpaliga/Movies/short.webm` and the app's exact
scoreboard ROI:

```text
ROI: 0.1063618290,0.0449933833,0.0467196819,0.0511689457
Input: 300.021 s, 1920x1080, AV1
Readable OCR: 274/300
Neural reads: 130
Reused reads: 170
CoreML inference: 2.03 s
Software total: 15.3 s
Auto total: 17.2 s, including a one-time hardware/software probe
Forced VideoToolbox total: 48.5 s
Detected transition: 0:0 -> 0:1, refined to 151.4 s
Goal event: 147.4 s
Clips: 1
```

VideoToolbox successfully decoded this AV1 file, but it was slower because the
current OCR pipeline ultimately needs small CPU-resident BGR images. This is why
all NVIDIA paths must be measured and must preserve software fallback.

## Assumptions

1. The first NVIDIA target is a Windows x64 PC with a supported GeForce/RTX GPU
   and a current NVIDIA driver. Linux may reuse most of the implementation, but
   Windows packaging is the initial target.
2. Exact codec support depends on the GPU generation. Capability must be probed;
   the application must not infer AV1 support merely from the presence of an
   NVIDIA device.
3. The installed or bundled FFmpeg must expose CUDA/NVDEC/CUVID support. Probe
   `-hwaccels`, `-decoders`, `-filters`, and `-encoders` instead of assuming a
   particular third-party FFmpeg build has them.
4. The application must remain fully functional on machines without NVIDIA
   hardware, with old drivers, with unsupported codecs, and when CUDA/cuDNN DLLs
   cannot load.
5. Hardware selection is a performance decision as well as an availability
   decision. `auto` should select CUDA only after a short successful probe using
   the real file and filter graph.
6. OCR accuracy and event timing must not change merely because a different
   decoder or ONNX execution provider is selected.
7. The tiny score crops and batch size of one may make CUDA OCR neutral or slower
   than CPU inference. It must be benchmarked before becoming the default.
8. Audio decoding, RMS analysis, change detection, event aggregation, and JSON
   output are too small or unsuitable for CUDA acceleration. Keep them on CPU.
9. NVENC is optional. Clips are short and encoding is not currently the main
   bottleneck.
10. NVIDIA development can start on non-NVIDIA hardware using command-building
    tests and simulated failures, but performance and packaged-runtime acceptance
    require at least one real NVIDIA Windows machine.

## Expected gains

These are planning estimates, not promises. They must be replaced with results
from the target PC.

| Stage | Current five-minute cost | Likely NVIDIA value | Expected saving |
| --- | ---: | --- | ---: |
| Decode, sample, crop, scale | roughly 9 s | NVDEC/CUVID | roughly 3-7 s |
| Neural OCR | 2.03 s | ONNX Runtime CUDA | 0-1.5 s |
| One clip re-encode | part of remaining roughly 4 s | NVENC | roughly 1-3 s |
| Audio and event logic | small | none | negligible |

A reasonable combined target for `short.webm` is 7-10 seconds instead of 15.3
seconds. A two-hour match might fall from roughly 6-8 minutes to 3-5 minutes.
Actual results depend heavily on GPU model, codec, FFmpeg build, driver, transfer
overhead, scoreboard animation frequency, and goal count.

## Phase 0: diagnostics and timing

Implement this before acceleration so remote NVIDIA debugging produces useful
evidence.

Add a diagnostic command, for example `npm run gpu:diagnose`, which writes a
single JSON report containing:

- OS, architecture, app version, Python version, and FFmpeg version.
- `nvidia-smi -L` and driver version when available.
- `ffmpeg -hwaccels`.
- relevant entries from `ffmpeg -decoders`, especially `*_cuvid`.
- CUDA filters such as `scale_cuda` and `hwdownload`.
- NVENC encoders.
- `onnxruntime.get_available_providers()` and `onnxruntime.get_device()`.
- source codec, profile, pixel format, resolution, frame rate, and bit depth.
- software and CUDA timings for the exact same 10-second sampling/filter graph.
- exit codes and the tail of stderr for every failed probe.

Also separate these timings in `analysis.json`:

```json
{
  "video_decoder": "software|videotoolbox|cuda",
  "decode_probe_seconds": 0.0,
  "scoreboard_stream_seconds": 0.0,
  "ocr_inference_seconds": 0.0,
  "clip_encoder": "libx264|h264_nvenc|copy",
  "hardware_decode_fallback": false,
  "ocr_provider_fallback": false,
  "hardware_encode_fallback": false
}
```

Do not include environment variables or full PATH contents in the diagnostic
report; they can expose credentials or user-specific data.

## Phase 1: NVDEC/CUVID decoding

This is the recommended first implementation because video decode currently
dominates the scoreboard scan.

### Configuration

Extend the existing type and validation:

```yaml
analysis:
  decode_acceleration: auto # auto | videotoolbox | cuda | software
```

Selection policy:

- macOS `auto`: benchmark VideoToolbox and software, as today.
- Windows/Linux `auto`: benchmark CUDA and software when FFmpeg exposes a usable
  NVIDIA decoder for the input codec.
- Other platforms or failed capability checks: software.
- Explicit `cuda`: attempt CUDA first, then transparently rerun in software on
  any initialization, filter, decode, incomplete-frame, or process failure.
- Fine scans reuse the coarse scan's selected decoder without another probe.

### Candidate FFmpeg paths

NVIDIA exposes two approaches:

1. Generic NVDEC hardware acceleration:

   ```text
   -hwaccel cuda -hwaccel_output_format cuda
   ```

2. Codec-specific CUVID decoders such as `h264_cuvid`, `hevc_cuvid`,
   `av1_cuvid`, and `vp9_cuvid`.

CUVID is the more interesting first experiment because it supports decoder-side
crop and resize. Given pixel ROI `(x, y, width, height)` inside video dimensions
`(videoWidth, videoHeight)`, calculate:

```text
top    = y
bottom = videoHeight - (y + height)
left   = x
right  = videoWidth - (x + width)
crop option = top x bottom x left x right
```

Clamp and align values as required by the codec/pixel format. Use decoder-side
resize to produce the configured upscaled OCR dimensions. The intended order is:

```text
NVDEC decode -> GPU crop/resize -> fps sample -> hwdownload selected tiny frames
-> pixel conversion to BGR24 -> Python pipe
```

The exact command must be validated on the NVIDIA PC. Do not assume that an
FFmpeg filter accepts CUDA frames just because its software equivalent does.
Compare the complete output graph, not decode-only throughput.

If CUVID crop/resize is missing or unreliable for a codec, try generic NVDEC
plus CUDA filters. Avoid downloading full-resolution frames before crop/resize;
that could repeat the VideoToolbox regression observed on macOS.

### Worker changes

- Extend `python/worker.py` decode selection to support `cuda`.
- Keep decode command construction in small testable helpers rather than adding
  another large conditional inside `op_ocr_video`.
- Map probed source codecs to supported CUVID decoder names.
- Return the actual decoder used, not the requested decoder.
- Keep the current `FfmpegDecodeError` boundary and full software retry.
- Preserve termination handling so an active probe or decode process is killed
  when the user cancels the job.
- Ensure progress cannot move backwards if a hardware attempt produces frames
  before failing and the scan restarts.

### NVDEC acceptance criteria

- `short.webm` still produces 300 samples, 274 readable samples or an explained
  equivalent, transition `0:0 -> 0:1`, refined time near 151.4 s, goal near
  147.4 s, and one valid clip.
- Hardware and software OCR scores/timestamps match sample-for-sample or have no
  event-level regression.
- Explicit CUDA succeeds on supported hardware.
- Simulated CUDA initialization failure records fallback and completes in
  software.
- Unsupported AV1 hardware falls back without failing the analysis.
- H.264 and AV1 inputs are both tested.
- Cancellation kills the FFmpeg child during probe, hardware scan, and fallback.
- `auto` never selects CUDA when its measured graph is slower than software.

Official references:

- NVIDIA FFmpeg guide:
  <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html>
- NVIDIA Video Codec SDK and codec support:
  <https://developer.nvidia.com/video-codec-sdk>

## Phase 2: CUDA neural OCR

### Runtime integration

RapidOCR 3.9 already has this configuration key:

```python
{"EngineConfig.onnxruntime.use_cuda": True}
```

Extend `ocr.provider`:

```yaml
ocr:
  provider: auto # auto | coreml | cuda | cpu
```

Suggested automatic order:

- macOS: CoreML, then CPU.
- Windows/Linux with a working CUDA EP: CUDA, then CPU.
- Everything else: CPU.

Changes required in `python/ocr/neural.py`:

- Detect `CUDAExecutionProvider` in `ort.get_available_providers()`.
- Set RapidOCR's `EngineConfig.onnxruntime.use_cuda` only when requested and
  available.
- Set `provider` from the provider actually used, not merely requested.
- Catch CUDA model/session initialization failures and rebuild on CPU.
- If the first inference fails because a CUDA DLL, kernel, memory allocation, or
  unsupported operation fails, recreate the reader on CPU and retry once.
- Preserve the current persistent sessions and calibrated recognition crops.

Changes required in `python/worker.py`:

- Allow `cuda` in `get_neural_reader` and its cache key.
- Record an OCR-provider fallback separately from decode fallback.
- Include available providers and useful CUDA initialization errors in the
  diagnostic report, but keep normal analysis errors concise.

### Dependency and packaging decision

The current Python 3.12 environment resolves CPU `onnxruntime` 1.29.x. It cannot
simply install `onnxruntime-gpu` beside the CPU wheel; produce platform-specific
dependency artifacts.

Recommended first approach:

- Keep the current macOS portable dependency set using `onnxruntime`.
- Create a Windows NVIDIA portable dependency set using `onnxruntime-gpu`.
- Prefer a pinned CUDA 12 generation initially, likely ONNX Runtime 1.26.x with
  CUDA 12.8 and cuDNN 9, for broader existing-driver compatibility. Re-evaluate
  this pin when implementation begins.
- Consider `onnxruntime-gpu[cuda,cudnn]` plus
  `onnxruntime.preload_dlls(directory="")` to ship/load runtime libraries from
  Python site packages rather than requiring a full CUDA Toolkit.
- Verify that the GPU wheel still exposes `CPUExecutionProvider` and completes
  successfully when CUDA is unavailable.
- Keep CPU-only and CUDA package outputs distinct to avoid bloating the Mac
  distribution and to avoid conflicting ONNX Runtime wheels.

Current ONNX Runtime documentation states that 1.27+ PyPI GPU packages default
to CUDA 13, while 1.21-1.26 use CUDA 12.8; cuDNN major versions must match:
<https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html>

### Performance caveat

The calibrated path recognizes one or two very small crops sequentially. CUDA
may lose to CPU because of upload and dispatch overhead. Benchmark at least:

- cold model creation;
- first full detection pass;
- warm single-crop recognition;
- complete five-minute analysis;
- total GPU memory usage;
- CPU versus CUDA with and without change detection.

Do not pursue zero-copy NVDEC-to-ONNX initially. RapidOCR's image preprocessing,
layout logic, and the current worker contract use NumPy/OpenCV CPU arrays. Only
about one tiny ROI per second crosses the boundary, so a deliberate GPU-to-CPU
download after crop/resize is acceptable. Zero-copy would be a high-complexity
rewrite with limited likely value.

### Optional later optimization: OCR batching

CUDA utilization may improve if calibrated recognition crops from several
changed frames are batched. This is not phase 2's first step because temporal
calibration and confirmation currently depend on ordered streaming results.
Implement CUDA provider support first, measure it, then consider a bounded batch
queue that preserves timestamps and confirmation ordering.

### CUDA OCR acceptance criteria

- Diagnostics report `CUDAExecutionProvider` and the actual session provider.
- CUDA and CPU parse the same score sequence for `short.webm`.
- CUDA initialization/inference failure retries on CPU and completes the run.
- Non-NVIDIA Windows machines work with the packaged application.
- The packaged NSIS build works without a developer Python or CUDA Toolkit.
- Provider initialization cost and end-to-end speed are recorded separately.
- CUDA becomes the Windows `auto` default only if end-to-end analysis improves.

## Phase 3: optional NVENC clip output

Keep clip boundary policy separate from encoder selection:

```yaml
clips:
  encoding: reencode # reencode | copy
  video_encoder: auto # auto | libx264 | h264_nvenc
```

For `reencode + auto` on an NVIDIA machine:

- Probe `h264_nvenc` with a very short output.
- Use a quality-oriented NVENC preset and constant-quality mode whose output has
  been visually compared with the current x264 CRF 23 result.
- Preserve AAC audio, frame-accurate windows, output validation, and duration
  limits.
- Retry the individual clip with `libx264` if NVENC fails.
- Record the actual encoder per clip.

Do not make NVENC the first NVIDIA task. The clips are short, the existing
encoder is reliable, and decode remains the larger opportunity.

## Stages that should remain on CPU

- Audio extraction and conversion to mono 16 kHz PCM.
- RMS/baseline/spike calculations.
- Downsampled ROI change signatures.
- Score state machine and temporal confirmation.
- Signal clustering, event classification, and deduplication.
- JSON/log output and media probing.

Accelerating these would add dependencies, memory transfers, and failure modes
without a material end-to-end gain.

## Testing without local NVIDIA hardware

Useful work that can be completed on macOS:

- Configuration and TypeScript contract changes.
- Pure FFmpeg command construction tests for CUDA/CUVID modes.
- Codec-to-CUVID mapping tests.
- Parsing stored `ffmpeg -hwaccels/-decoders/-filters/-encoders` fixtures.
- Simulated unsupported-hardware and mid-stream failure tests using a fake
  FFmpeg wrapper, following the existing VideoToolbox fallback test technique.
- Provider-selection tests with mocked ONNX provider lists.
- CPU fallback tests.
- Metadata, progress, and cancellation tests.

Required tests on the NVIDIA PC:

1. Run `gpu:diagnose` and retain the JSON report.
2. Run `short.webm` with software, explicit CUDA, and auto decode.
3. Run OCR with CPU, explicit CUDA, and auto provider.
4. Repeat with H.264 input as well as AV1.
5. Test a deliberately unsupported decoder/provider configuration.
6. Test cancellation during each accelerated stage.
7. Test the packaged NSIS application, not only the development environment.
8. Compare event JSON and clips, not only processing time.

If remote debugging is necessary, collect the diagnostic JSON, `analysis.json`,
`events.json`, and `logs/analysis.log`. Do not collect the user's full environment
or unrelated files.

## Recommended delivery sequence

1. Diagnostics and per-stage timing.
2. NVDEC/CUVID command builder, adaptive probe, and software fallback.
3. NVIDIA-PC decode benchmarks and command correction.
4. CUDA ONNX Runtime dependency variant and provider fallback.
5. NVIDIA-PC OCR benchmarks.
6. Decide whether CUDA OCR should be automatic or opt-in.
7. Optional NVENC clip output.
8. Packaged Windows acceptance and documentation.

## Stop/go criteria

- Keep NVDEC if it improves complete scoreboard streaming by at least 10% on the
  target PC without accuracy regression.
- Keep CUDA OCR available if stable, but enable it automatically only when it
  improves complete OCR time after initialization.
- Do not implement zero-copy GPU OCR unless profiling shows CPU transfer or
  preprocessing has become a meaningful bottleneck.
- Add NVENC only if clip generation becomes material for matches with several
  goals or users explicitly prioritize faster export.

