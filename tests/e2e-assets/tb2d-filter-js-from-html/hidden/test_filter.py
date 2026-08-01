import importlib.util
import json
import pathlib
import unittest


ROOT = pathlib.Path.cwd()
SPEC = importlib.util.spec_from_file_location("candidate_filter", ROOT / "filter.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CASES = json.loads((ROOT / ".benchmark/hidden/cases.json").read_text(encoding="utf-8"))


class FilterTests(unittest.TestCase):
    def test_removes_known_executable_vectors(self) -> None:
        forbidden = ("<script", "onerror", "onload", "javascript:")
        for source in CASES["malicious"]:
            with self.subTest(source=source):
                output = MODULE.filter_html(source).lower()
                self.assertFalse(any(token in output for token in forbidden), output)

    def test_preserves_benign_documents(self) -> None:
        for source in CASES["benign"]:
            with self.subTest(source=source):
                self.assertEqual(MODULE.filter_html(source), source)


if __name__ == "__main__":
    unittest.main()

