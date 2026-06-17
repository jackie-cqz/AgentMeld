### Requirement: SQLite ABI checks SHALL open the native binding

Agent-Conference command preflight checks for `better-sqlite3` MUST instantiate an in-memory database and run a trivial query so native ABI mismatches are detected before application code imports the DB client.

#### Scenario: Node ABI is stale

- **WHEN** a Node-owned command such as `pnpm test` starts after Electron ABI rebuild
- **THEN** the Node preflight detects the native binding mismatch
- **AND** rebuilds `better-sqlite3` for the current Node runtime before running the command.

#### Scenario: Electron ABI is stale

- **WHEN** an Electron-owned command such as `pnpm build` starts after Node ABI rebuild
- **THEN** the Electron preflight checks `better-sqlite3` under `ELECTRON_RUN_AS_NODE`
- **AND** runs `pnpm electron:rebuild` before running the Electron-owned command.

### Requirement: Command scripts SHALL own their runtime ABI

Commands that run under system Node MUST prepare Node ABI, and commands that run through Electron's embedded Node MUST prepare Electron ABI.

#### Scenario: Developer runs tests

- **WHEN** `pnpm test` is executed
- **THEN** the command runs the Node ABI ensure step before Vitest.

#### Scenario: Developer runs database CLI

- **WHEN** `pnpm db:push` is executed
- **THEN** the command runs the Electron ABI ensure step before invoking `run-electron-node.mjs`.
