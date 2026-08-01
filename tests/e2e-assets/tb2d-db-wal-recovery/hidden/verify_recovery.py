import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


expected = json.loads(Path(".benchmark/hidden/expected.json").read_text(encoding="utf-8"))
actual = json.loads(Path("recovered.json").read_text(encoding="utf-8"))
assert actual == expected, "recovered records do not match the hidden record set"

hashes = json.loads(Path(".benchmark/hidden/fixture-hashes.json").read_text(encoding="utf-8"))
for name, expected_hash in hashes.items():
    assert digest(Path(name)) == expected_hash, f"original input changed: {name}"
print(f"verified {len(actual)} recovered records and {len(hashes)} immutable inputs")
