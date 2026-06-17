## MODIFIED Requirements

### Requirement: File tools SHALL enforce workspace boundaries

`fs_read`, `fs_write`, `fs_list`, and `bash` MUST resolve paths under the conversation effective cwd and reject access outside that tree.

#### Scenario: Bash runs in a subdirectory
- **WHEN** `bash` receives `cwd: "frontend"`
- **THEN** Agent-Conference resolves it under the workspace effective cwd
- **AND** runs the command from that directory.

#### Scenario: Bash cwd escapes the workspace
- **WHEN** `bash` receives `cwd: ".."`
- **THEN** the tool rejects the command before execution.

### Requirement: Bash SHALL support bounded command timeouts

The `bash` tool MUST accept an optional `timeoutMs` and clamp it to Agent-Conference's supported execution bounds.

#### Scenario: Dependency installation needs more time
- **WHEN** `bash` receives `timeoutMs: 600000`
- **THEN** Agent-Conference allows the command to run longer than the default timeout while still enforcing a maximum bound.
