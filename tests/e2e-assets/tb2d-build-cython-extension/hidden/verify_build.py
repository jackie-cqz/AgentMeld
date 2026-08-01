import importlib.machinery
import pathlib
import subprocess
import sys

import numpy


assert numpy.__version__.startswith("2.3."), numpy.__version__
subprocess.run([sys.executable, "-m", "pip", "install", "--no-build-isolation", "."], check=True)

from agentmeld_faststats import faststats, mean64

module_path = pathlib.Path(faststats.__file__)
assert any(str(module_path).endswith(suffix) for suffix in importlib.machinery.EXTENSION_SUFFIXES), module_path
assert abs(mean64([2.0, 4.0, 8.0, 10.0]) - 6.0) < 1e-12
try:
    mean64([])
except ValueError:
    pass
else:
    raise AssertionError("empty input must raise ValueError")
print(f"verified compiled extension at {module_path} with NumPy {numpy.__version__}")

