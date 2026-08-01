# Cython NumPy 2.3 Compatibility

Build and install the local `agentmeld_faststats` package in the provided Linux container.

Requirements:

- Keep NumPy on version 2.3.x.
- Fix the Cython extension rather than replacing it with a pure-Python shim.
- `python smoke.py` must run successfully.
- `python -m unittest -v tests/test_public.py` must pass.
- Do not modify tests.

