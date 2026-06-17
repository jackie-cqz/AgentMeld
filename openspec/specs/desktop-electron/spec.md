# Desktop Electron

## Purpose

Defines desktop packaging, runtime paths, and Electron-specific constraints. Detailed desktop notes live in `specs/12-desktop-electron.md`.

## Requirements

### Requirement: Desktop build SHALL use Next standalone output

Electron packaging MUST run against Next standalone server output and keep required runtime files available outside asar when filesystem APIs require real paths.

#### Scenario: Packaged app starts
- **WHEN** Electron launches the Next server
- **THEN** `.next/standalone` is available as a real unpacked directory.

### Requirement: Native and SDK packages SHALL remain external

Packages that rely on native bindings or child runtime lookup MUST be listed in `serverExternalPackages`.

#### Scenario: Codex SDK is bundled
- **WHEN** Next builds the server bundle
- **THEN** `@openai/codex-sdk` and `@openai/codex` remain runtime dependencies.

### Requirement: Desktop data SHALL live in userData

Electron mode MUST store database and Agent-Conference-managed data under `app.getPath('userData')` rather than the source checkout.

#### Scenario: Desktop app starts in production
- **WHEN** the server bootstraps
- **THEN** `AGENT_CONFERENCE_DATA_DIR` points at the desktop app data directory.

### Requirement: API key storage SHALL match web local mode

Desktop mode MUST use the same SQLite `app_settings` key storage semantics and SHALL not add OS keychain storage until a separate spec changes the security model.

#### Scenario: User saves an Anthropic key on desktop
- **WHEN** settings are saved
- **THEN** the key is stored in the desktop SQLite database.

### Requirement: Desktop packaging SHALL include Codex runtime dependencies

The packaging flow MUST carry Codex optional platform runtime dependencies needed by `@openai/codex-sdk`.

#### Scenario: User runs Codex agent from packaged app
- **WHEN** CodexAdapter starts a thread
- **THEN** the SDK can locate its platform Codex binary dependency.

#### Scenario: Electron prebuild deduplicates traced Codex runtime
- **WHEN** `scripts/electron-prebuild.mjs` finds both the top-level Codex platform alias package and the matching traced `.pnpm/@openai+codex@...-<platform>` store package
- **THEN** the top-level alias package remains available
- **AND** the duplicate traced store package is removed before Electron packaging.
