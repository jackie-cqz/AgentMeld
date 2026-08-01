import json
from pathlib import Path

import pandas as pd


expected = json.loads(Path(".benchmark/hidden/expected.json").read_text(encoding="utf-8"))
merged = pd.read_parquet("merged_users.parquet").sort_values("user_id")
assert list(merged["user_id"]) == expected["user_ids"]
assert list(merged.columns) == expected["required_columns"]
for key, value in expected["selected_values"].items():
    user_id, field = key.split(".", 1)
    actual = merged.loc[merged["user_id"] == int(user_id), field].iloc[0]
    assert actual == value, (key, actual, value)

conflicts = json.loads(Path("conflicts.json").read_text(encoding="utf-8"))
assert conflicts["total_conflicts"] == len(conflicts["conflicts"])
assert conflicts["total_conflicts"] > 0
print(f"verified {len(merged)} merged users and {conflicts['total_conflicts']} conflicts")

