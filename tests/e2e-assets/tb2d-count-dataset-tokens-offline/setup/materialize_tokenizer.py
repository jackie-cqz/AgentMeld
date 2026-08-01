import json
import shutil
from pathlib import Path

from transformers import AutoTokenizer


ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "public/tokenizer-lock.json").read_text(encoding="utf-8"))
DESTINATION = ROOT / "generated/public/tokenizer-cache"

if LOCK["revision"].startswith("TBD"):
    raise RuntimeError("tokenizer-lock.json must contain a pinned Hugging Face revision")

if (DESTINATION.joinpath("tokenizer_config.json").exists()):
    AutoTokenizer.from_pretrained(DESTINATION, local_files_only=True)
    print(f"reused pinned tokenizer at {DESTINATION}")
else:
    shutil.rmtree(DESTINATION, ignore_errors=True)
    DESTINATION.mkdir(parents=True)
    tokenizer = AutoTokenizer.from_pretrained(LOCK["model"], revision=LOCK["revision"])
    tokenizer.save_pretrained(DESTINATION)
    print(f"materialized {LOCK['model']}@{LOCK['revision']} at {DESTINATION}")
