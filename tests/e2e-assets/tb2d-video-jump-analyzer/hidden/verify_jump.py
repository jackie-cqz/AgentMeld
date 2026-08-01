import ast
import json
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


ALLOWED_THIRD_PARTY = {"cv2", "numpy", "toml"}
STDLIB = set(getattr(sys, "stdlib_module_names", set()))


tree = ast.parse(Path("jump_analyzer.py").read_text(encoding="utf-8"))
for node in ast.walk(tree):
    names = []
    if isinstance(node, ast.Import):
        names = [alias.name.split(".")[0] for alias in node.names]
    elif isinstance(node, ast.ImportFrom) and node.module:
        names = [node.module.split(".")[0]]
    for name in names:
        assert name in STDLIB or name in ALLOWED_THIRD_PARTY, f"forbidden dependency: {name}"

labels = json.loads(Path(".benchmark/hidden/labels.json").read_text(encoding="utf-8"))
errors = []
for filename, expected in labels.items():
    video = Path(".benchmark/hidden") / filename
    with tempfile.TemporaryDirectory() as raw:
        cwd = Path(raw)
        subprocess.run([sys.executable, str(Path.cwd() / "jump_analyzer.py"), str(video)], cwd=cwd, check=True)
        result = tomllib.loads((cwd / "output.toml").read_text(encoding="utf-8"))
    assert set(result) == {"jump_takeoff_frame_number", "jump_land_frame_number"}
    takeoff = result["jump_takeoff_frame_number"]
    land = result["jump_land_frame_number"]
    assert isinstance(takeoff, int) and isinstance(land, int) and takeoff < land
    errors.extend([abs(takeoff - expected["takeoff"]), abs(land - expected["land"])])

assert max(errors) <= 4, errors
assert sum(errors) / len(errors) <= 2.5, errors
print(f"verified {len(labels)} hidden videos; errors={errors}")

