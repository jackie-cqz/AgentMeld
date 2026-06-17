# Change: Stabilize SQLite ABI Scripts

## Why

`better-sqlite3` is a native module tied to the active Node ABI. Agent-Conference intentionally alternates between system Node for dev/test and Electron's embedded Node for desktop build/db scripts. The current setup is easy to break because `ensure-node-sqlite.mjs` only imports `better-sqlite3`; the native binding is loaded later when a `Database` is opened, so ABI mismatches can slip through until Vitest or a route touches the database.

Developers should not need to remember when to run `pnpm rebuild better-sqlite3` or `pnpm electron:rebuild`.

## What Changes

- Verify `better-sqlite3` by opening an in-memory database, not by importing the package.
- Add separate Node and Electron ABI ensure scripts.
- Run the Node ABI ensure step before dev, test, test watch, and e2e commands.
- Run the Electron ABI ensure step before build, start, and db commands that use `ELECTRON_RUN_AS_NODE`.
- Remove the obsolete `package.json#pnpm.onlyBuiltDependencies` block because build approval now lives in `pnpm-workspace.yaml`.
- Update desktop documentation so the command ownership is explicit.

## Out Of Scope

- Changing the Electron major version.
- Replacing `better-sqlite3`.
- Adding a second native module copy to avoid ABI flip-flop entirely.
- Changing database schema or persistence semantics.
