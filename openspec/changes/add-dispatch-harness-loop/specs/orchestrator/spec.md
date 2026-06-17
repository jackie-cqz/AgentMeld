## ADDED Requirements

### Requirement: Child Tasks SHALL Continue Until Complete Or Blocked

AgentRunner MUST continue a dispatched child task when a child attempt ends without required completion evidence and the failure is recoverable.

#### Scenario: Child omits task report
- **WHEN** a child task attempt ends without `report_task_result`
- **AND** the task has remaining harness attempts
- **THEN** AgentRunner runs the same assigned agent again
- **AND** the continuation prompt includes the missing report error and prior task context.

#### Scenario: Child reaches attempt limit
- **WHEN** a child task still lacks required evidence after the bounded attempt limit
- **THEN** AgentRunner marks the dispatch task `failed`
- **AND** downstream dependents are skipped or replanned according to the DAG outcome.

### Requirement: Required Commands SHALL Be Executed By Agent-Conference

AgentRunner MUST execute `requiredCommands` for a child task before accepting it as complete.

#### Scenario: Required command succeeds
- **WHEN** a child task declares a required command
- **AND** Agent-Conference runs the command with exit code `0`
- **THEN** the command evidence is available to task result evaluation.

#### Scenario: Required command fails
- **WHEN** Agent-Conference runs a required command and it exits non-zero or times out
- **THEN** the task attempt is incomplete
- **AND** the next continuation prompt includes the failed command and output.
