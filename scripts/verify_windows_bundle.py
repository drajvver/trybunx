"""Exercise relocated Windows runtime, offline OCR, tracking and video encoding."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    if "--child" not in sys.argv:
        with tempfile.TemporaryDirectory(prefix="Trybunx offline test ") as temp:
            relocated = Path(temp) / "App resources with spaces"
            shutil.copytree(root, relocated, ignore=shutil.ignore_patterns("ffmpeg.zip", "ffmpeg", "licenses"))
            env = {**os.environ, "PYTHONPATH": os.pathsep.join(
                [str(relocated / "python/vendor"), str(relocated / "python")]),
                "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                "PATH": os.environ.get("SystemRoot", r"C:\Windows") + r"\System32",
                "YOLO_CONFIG_DIR": str(Path(temp) / "yolo")}
            subprocess.run([str(relocated / "runtime/python.exe"), str(Path(__file__).resolve()),
                            str(relocated), "--child"], env=env, cwd=temp, check=True, timeout=300)
        return

    # Fail any attempted Python download, even if the machine is online.
    import socket
    def offline(*args, **kwargs):
        raise RuntimeError("Bundle verification forbids network access")
    socket.socket.connect = offline
    socket.create_connection = offline

    import cv2
    import numpy as np
    import worker
    image = np.full((100, 350, 3), 255, dtype=np.uint8)
    cv2.putText(image, "1 - 0", (20,75), cv2.FONT_HERSHEY_SIMPLEX, 2, (0,0,0), 4)
    score = root / "score.png"
    cv2.imwrite(str(score), image)
    assert worker.op_ping({})["pong"]
    from ocr.neural import NeuralScoreReader
    result = NeuralScoreReader("cpu").read_score(score.read_bytes(), 30)
    assert result.ok and result.score == "1:0", repr(result)

    ffmpeg = root / "bin/ffmpeg.exe"
    source = root / "test source.mp4"
    subprocess.run([str(ffmpeg), "-v", "error", "-f", "lavfi", "-i",
                    "color=c=green:s=640x360:r=12", "-t", "1", "-c:v", "libx264",
                    "-y", str(source)], check=True, timeout=30)
    from track.ball import track_ball_video
    track = track_ball_video({
        "input_path": str(source), "ffmpeg_path": str(ffmpeg), "start": 0, "end": 1,
        "sample_fps": 2, "model_path": str(root / "python/track/models/ball.onnx"),
        "ball_input_size": 640, "source_width": 640, "source_height": 360,
    }, lambda _: None, "smoke", [None])
    assert track["sample_count"] == 2, track
    (root / "pan.cmd").write_text("0 crop x 100;\n0.5 crop x 200;\n")
    output = root / "vertical.mp4"
    subprocess.run([str(ffmpeg), "-v", "error", "-i", str(source), "-vf",
                    "sendcmd=f=pan.cmd,crop=202:360:x=0:y=0,scale=1080:1920",
                    "-c:v", "libx264", "-preset", "ultrafast", "-y", str(output)],
                   cwd=root, check=True, timeout=60)
    probe = subprocess.check_output([str(root / "bin/ffprobe.exe"), "-v", "error",
                                     "-show_streams", "-of", "json", str(output)])
    video = json.loads(probe)["streams"][0]
    assert (video["width"], video["height"]) == (1080,1920)
    print("Relocated offline Windows bundle: OCR, tracking, FFmpeg and FFprobe passed.")


if __name__ == "__main__":
    main()
