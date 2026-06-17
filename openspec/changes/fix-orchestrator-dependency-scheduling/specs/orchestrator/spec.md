# Orchestrator Delta

## MODIFIED Requirements

### Requirement: Orchestrator SHALL plan before dispatch

The orchestration flow MUST parse, compile, and validate a task plan before launching child agent runs.

#### Scenario: Plan tool omits structured dependencies present in task text
- **WHEN** the orchestrator calls `plan_tasks`
- **AND** a task references earlier task outputs in prose but omits `dependsOn`
- **THEN** AgentRunner compiles the plan by adding high-confidence missing dependencies
- **AND** dispatches the compiled plan rather than the raw model output.

### Requirement: Child tasks SHALL respect dependency order

AgentRunner MUST execute compiled dispatch tasks as a DAG and skip dependent tasks when prerequisites fail or do not produce required artifacts.

#### Scenario: Artifact-producing upstream task creates no artifact
- **WHEN** a child task appears to require artifact output
- **AND** the child run ends with status `complete` but no artifact ids
- **THEN** AgentRunner treats that task result as `failed`
- **AND** skips downstream dependent tasks.

### Requirement: Child task context SHALL include upstream artifacts

Child task prompts MUST include artifacts from all completed upstream dependencies needed by the task.

#### Scenario: Task has transitive dependencies
- **WHEN** task `t4` depends on `t3`, `t3` depends on `t2`, and `t2` depends on `t1`
- **THEN** task `t4` sees artifact summaries from `t1`, `t2`, and `t3` in `upstream_artifacts`.
