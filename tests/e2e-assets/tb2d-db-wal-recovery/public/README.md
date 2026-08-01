# SQLite WAL Recovery

The workspace contains `inventory.db`, `inventory.db-wal`, and `inventory.db-shm`.

The base database does not expose all committed records because the WAL bytes were transformed. Recover every record into `recovered.json`, sorted by `id`, without changing the original three input files.

Output shape:

```json
[{"id": 1, "name": "item1", "value": 101}]
```

