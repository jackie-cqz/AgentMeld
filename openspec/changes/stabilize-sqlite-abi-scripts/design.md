# Design: SQLite ABI Ensure Scripts

## Flow

```text
Node command
  -> node scripts/ensure-node-sqlite.mjs
  -> open better-sqlite3 :memory:
  -> if ABI mismatch: pnpm rebuild better-sqlite3
  -> retry check
  -> run command

Electron command
  -> node scripts/ensure-electron-sqlite.mjs
  -> run Electron-as-Node sqlite check
  -> if ABI mismatch: pnpm electron:rebuild
  -> retry check
  -> run command through run-electron-node.mjs
```

## Decisions

- The check MUST instantiate `new Database(':memory:')` and run a trivial query, because package import alone does not load the native binding.
- Node commands own Node ABI: `dev`, `test`, `test:watch`, `e2e`, `e2e:ui`.
- Electron commands own Electron ABI: `build`, `start`, `db:generate`, `db:push`, `db:studio`, `db:seed`.
- `electron:rebuild` remains as the force-rebuild primitive, but normal commands call it only when the Electron check fails with an ABI/load error.
- The package-level `pnpm` config block is removed to avoid misleading warnings; `pnpm-workspace.yaml` remains the build-approval source.

## Validation

- Run the Node ensure script and verify it can open an in-memory database.
- Run the Electron ensure script and verify it can open an in-memory database under `ELECTRON_RUN_AS_NODE`.
- Run `pnpm test` to confirm Vitest no longer fails before database-backed tests.
- Run `pnpm typecheck` and `pnpm lint`.
