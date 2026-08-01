import hashlib
import json
import shutil
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "generated"
INPUT = OUTPUT / "public/input"
HIDDEN = OUTPUT / "hidden"
XOR_KEY = 0x42


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


shutil.rmtree(OUTPUT, ignore_errors=True)
INPUT.mkdir(parents=True)
HIDDEN.mkdir(parents=True)

with tempfile.TemporaryDirectory() as raw:
    source = Path(raw) / "inventory.db"
    connection = sqlite3.connect(source)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, value INTEGER NOT NULL)")
    connection.executemany(
        "INSERT INTO items(id, name, value) VALUES (?, ?, ?)",
        [(index, f"item{index}", index * 100) for index in range(1, 6)],
    )
    connection.commit()
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    connection.executemany(
        "INSERT INTO items(id, name, value) VALUES (?, ?, ?)",
        [(index, f"item{index}", index * 100) for index in range(6, 12)],
    )
    connection.execute("UPDATE items SET value = value + 1 WHERE id IN (1, 4, 9)")
    connection.commit()

    shutil.copy2(source, INPUT / "inventory.db")
    wal = Path(f"{source}-wal")
    shm = Path(f"{source}-shm")
    encrypted = bytes(byte ^ XOR_KEY for byte in wal.read_bytes())
    (INPUT / "inventory.db-wal").write_bytes(encrypted)
    shutil.copy2(shm, INPUT / "inventory.db-shm")
    connection.close()

hashes = {path.name: digest(path) for path in sorted(INPUT.iterdir())}
(HIDDEN / "fixture-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
print(json.dumps({"output": str(INPUT), "hashes": hashes}, indent=2))
