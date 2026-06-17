# Platform Security

## Purpose

Defines cross-platform shell, path, sandbox, and process safety rules. Detailed platform notes live in `specs/11-platform.md`.

## Requirements

### Requirement: Platform detection SHALL drive shell behavior

Agent-Conference MUST select shell command conventions and tool descriptions based on the current host platform.

#### Scenario: Host is POSIX
- **WHEN** Agent-Conference executes an Agent-Conference-managed bash command
- **THEN** it SHOULD use the user's login zsh/bash shell when available
- **AND** it MUST fall back to a POSIX-compatible shell invocation when the user shell cannot be resolved safely.

#### Scenario: Host is Windows
- **WHEN** bash-like tool descriptions are built
- **THEN** they use PowerShell-oriented examples and Windows blacklist language.

### Requirement: Path safety SHALL be platform-aware

Workspace path checks MUST handle case sensitivity, path separators, drive roots, and sensitive directories according to host platform.

#### Scenario: Windows path case differs
- **WHEN** a path differs only by drive-letter case
- **THEN** containment checks still evaluate correctly.

### Requirement: Command blacklist SHALL be shared

POSIX and Windows banned command patterns MUST be defined in one shared server security module and used by both tools and SDK approval bridges where applicable.

#### Scenario: Claude Code asks to run a banned command
- **WHEN** the Bash tool approval includes a matching command
- **THEN** the adapter denies the tool use.

### Requirement: Child processes SHALL be cleaned up

Long-running child processes spawned by tool or SDK boundaries MUST be aborted or terminated when the owning run or app shuts down.

#### Scenario: User aborts a run
- **WHEN** the run AbortSignal fires
- **THEN** active tool or SDK work receives cancellation.

### Requirement: SDK child process environment SHALL preserve required host basics

SDK child process environments MUST preserve required values such as PATH and HOME/USERPROFILE while applying adapter-specific isolation.

#### Scenario: Codex runs on Windows
- **WHEN** HOME is missing and USERPROFILE exists
- **THEN** the child env receives a HOME fallback.
