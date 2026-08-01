import json
from pathlib import Path

import pandas as pd


root = Path(__file__).resolve().parents[1]
records = json.loads((root / "setup/source_c_records.json").read_text(encoding="utf-8"))
destination = root / "generated/public/data/source_c/users.parquet"
destination.parent.mkdir(parents=True, exist_ok=True)
pd.DataFrame(records).to_parquet(destination, index=False)
