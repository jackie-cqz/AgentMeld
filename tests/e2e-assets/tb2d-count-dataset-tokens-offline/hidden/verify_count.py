import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from transformers import AutoTokenizer


def expected_count(dataset: Path, tokenizer_path: Path) -> int:
    import json

    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, local_files_only=True)
    total = 0
    for line in dataset.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record["domain"] != "science":
            continue
        text = f"Question: {record['question']}\nAnswer: {record['response']}"
        total += len(tokenizer.encode(text, add_special_tokens=False))
    return total


parser = argparse.ArgumentParser()
parser.add_argument("--tokenizer", default="tokenizer-cache")
args = parser.parse_args()
tokenizer_path = Path(args.tokenizer)
hidden = Path(".benchmark/hidden/alternate-slice.jsonl")

with tempfile.TemporaryDirectory() as raw:
    output = Path(raw) / "answer.txt"
    subprocess.run([sys.executable, "count_tokens.py", "--input", str(hidden), "--output", str(output)], check=True)
    actual = output.read_text(encoding="utf-8").strip()
    assert actual.isdigit() and "," not in actual
    assert int(actual) == expected_count(hidden, tokenizer_path)
print("verified offline token count on hidden slice")
