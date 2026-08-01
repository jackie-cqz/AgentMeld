import json
import math
import shutil
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "generated"
SPECS = json.loads((ROOT / "setup/video-specs.json").read_text(encoding="utf-8"))
shutil.rmtree(OUTPUT, ignore_errors=True)
(OUTPUT / "public").mkdir(parents=True)
(OUTPUT / "hidden").mkdir(parents=True)
labels = {}


for spec in SPECS:
    destination = OUTPUT / spec["visibility"] / spec["name"]
    writer = cv2.VideoWriter(str(destination), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (640, 360))
    for frame_index in range(spec["frames"]):
        frame = np.full((360, 640, 3), 238, dtype=np.uint8)
        cv2.line(frame, (0, 300), (639, 300), (80, 80, 80), 3)
        cv2.rectangle(frame, (380, 225), (390, 300), (40, 40, 40), -1)
        cv2.rectangle(frame, (390, 225), (470, 234), (40, 40, 40), -1)
        if frame_index > 0:
            x = min(610, spec["start_x"] + frame_index * spec["speed"])
            y_offset = 0
            if spec["takeoff"] <= frame_index <= spec["land"]:
                phase = (frame_index - spec["takeoff"]) / (spec["land"] - spec["takeoff"])
                y_offset = int(spec["jump_height"] * math.sin(math.pi * phase))
            cv2.circle(frame, (x, 260 - y_offset), 16, (20, 90, 220), -1)
            cv2.rectangle(frame, (x - 10, 276 - y_offset), (x + 10, 300 - y_offset), (20, 90, 220), -1)
        writer.write(frame)
    writer.release()
    if spec["visibility"] == "hidden":
        labels[spec["name"]] = {"takeoff": spec["takeoff"], "land": spec["land"]}

(OUTPUT / "hidden/labels.json").write_text(json.dumps(labels, indent=2), encoding="utf-8")
print(f"generated {len(SPECS)} synthetic videos")

