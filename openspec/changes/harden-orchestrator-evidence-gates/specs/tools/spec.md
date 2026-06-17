# Tools Delta

## ADDED Requirements

### Requirement: Agents SHALL list workspace directories through Agent-Conference

Agent-Conference MUST provide an `fs_list` tool that lists directory entries inside the conversation workspace using the same workspace boundary checks as file tools.

#### Scenario: Agent lists the workspace root
- **WHEN** an agent calls `fs_list` with an empty path
- **THEN** Agent-Conference returns directories and files under the effective workspace cwd
- **AND** the result includes relative path, absolute path, parent path, and sorted entries.

#### Scenario: Agent attempts to list outside the workspace
- **WHEN** an agent calls `fs_list` with a path that resolves outside the workspace
- **THEN** Agent-Conference rejects the call.

### Requirement: Tool execution evidence SHALL be available to task evaluation

Agent-Conference-managed file and shell tools MUST record per-run evidence that AgentRunner can use when evaluating Orchestrator-dispatched child tasks.

#### Scenario: Child writes a file
- **WHEN** a child run successfully applies `fs_write`
- **THEN** Agent-Conference records the written path for that child run.

#### Scenario: Child runs a command
- **WHEN** a child run calls `bash`
- **THEN** Agent-Conference records the command, cwd, exit code, timeout flag, and tool error state for that child run.

### Requirement: Child task reports SHALL include structured evidence

`report_task_result` SHOULD accept structured file, command, and test evidence in addition to acceptance results and blockers.

#### Scenario: Child reports files and commands
- **WHEN** a child run calls `report_task_result`
- **AND** includes changed files and commands run
- **THEN** AgentRunner can compare those claims against recorded tool evidence.

## MODIFIED Requirements

### Requirement: Agent-Conference SHALL inject tool-call guidance for available tools

Tool guidance MUST include `fs_list` examples when the tool is available and SHOULD prefer it for directory inspection before falling back to shell-specific listing commands.

#### Scenario: Agent has file tools
- **WHEN** an agent has `fs_list`, `fs_read`, and `fs_write`
- **THEN** the injected prompt includes examples for listing, reading, and writing workspace files.
