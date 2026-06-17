# Orchestrator Delta

## MODIFIED Requirements

### Requirement: Orchestrator SHALL plan before dispatch

The Orchestrator plan stage MUST be limited to planning and read-only reconnaissance tools. The plan MAY declare structured execution evidence required for each task.

#### Scenario: Plan stage begins
- **WHEN** AgentRunner starts the Orchestrator plan stage
- **THEN** the available tools are limited to `plan_tasks`, `ask_user`, `fs_list`, `fs_read`, `read_artifact`, and `read_attachment` when those tools exist on the orchestrator.
- **AND** write tools and general shell execution are not available in that stage.

#### Scenario: Plan declares required evidence
- **WHEN** the orchestrator calls `plan_tasks`
- **AND** a task declares target paths, required commands, or required evidence
- **THEN** AgentRunner preserves those declarations in the compiled plan
- **AND** includes them in child task context.

### Requirement: Child tasks SHALL respect dependency order and semantic reports

AgentRunner MUST evaluate child task reports against declared acceptance criteria and evidence requirements before treating a task as complete.

#### Scenario: Child omits required command evidence
- **WHEN** a task declares a required command
- **AND** the child reports completion without recorded successful execution or matching command evidence
- **THEN** the dispatch task is treated as `failed`.

#### Scenario: Child writes only partial target files
- **WHEN** a task declares target paths
- **AND** the child reports completion without changing or verifying every target path
- **THEN** the dispatch task is treated as `failed`.

### Requirement: Aggregation SHALL summarize child outputs

Aggregation MUST preserve the original user goal and explicitly report incomplete work when any required child task failed, skipped, or lacked evidence.

#### Scenario: Retry narrows the goal
- **WHEN** a replan follows failed implementation work
- **THEN** the remediation plan must focus on missing or failed acceptance for the original goal
- **AND** must not replace implementation work with a narrower review-only task unless the user approves that scope change.
