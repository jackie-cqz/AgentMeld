# Hurdle Jump Analyzer

Create `jump_analyzer.py`.

Usage:

```text
python jump_analyzer.py <video.mp4>
```

Write `output.toml` containing exactly:

```toml
jump_takeoff_frame_number = 30
jump_land_frame_number = 55
```

Only `toml`, `cv2`, and `numpy` may be imported outside the Python standard library. The first video frame contains no runner.

