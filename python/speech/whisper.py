"""Speech-to-text (optional, v0.2+).

faster-whisper based worker operation. Intentionally NOT registered in v0.1:
goal detection must never depend on STT availability (PRD sections 24 and 30).

Future op contract (registered when enabled):
    op: "stt_window"
    params: {
      "audio_path": str,      # 16 kHz mono WAV extracted by the host
      "start": float, "end": float,
      "language": "pl",
      "model": "small"
    }
    result: { "segments": [{ "start": float, "end": float, "text": str }] }
"""
