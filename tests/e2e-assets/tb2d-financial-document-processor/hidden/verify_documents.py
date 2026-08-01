import csv
import json
from pathlib import Path


expected = json.loads(Path(".benchmark/hidden/expected.json").read_text(encoding="utf-8"))
assert Path("documents").is_dir() and not any(Path("documents").iterdir())
assert sorted(path.name for path in Path("invoices").iterdir() if path.name != "summary.csv") == sorted(expected["invoices"])
assert sorted(path.name for path in Path("other").iterdir()) == sorted(expected["other"])

with Path("invoices/summary.csv").open(newline="", encoding="utf-8-sig") as handle:
    rows = list(csv.DictReader(handle))
assert rows and list(rows[0]) == ["filename", "total_amount", "vat_amount"]
by_name = {row["filename"]: row for row in rows}
for filename, amounts in expected["invoices"].items():
    assert abs(float(by_name[filename]["total_amount"]) - amounts["total_amount"]) < 0.001
    assert abs(float(by_name[filename]["vat_amount"]) - amounts["vat_amount"]) < 0.001
assert abs(float(by_name["total"]["total_amount"]) - expected["totals"]["total_amount"]) < 0.001
assert abs(float(by_name["total"]["vat_amount"]) - expected["totals"]["vat_amount"]) < 0.001
print(f"verified {len(expected['invoices'])} invoices and {len(expected['other'])} other documents")

