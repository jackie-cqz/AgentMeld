# Orchestrator Delta

## MODIFIED Requirements

### Requirement: Orchestrator SHALL plan before dispatch

The orchestration flow MUST produce a compiled and validated task plan before launching child agent runs. When plan review is enabled, the compiled plan MUST be reviewed or approved by the user before child dispatch begins.

#### Scenario: Plan waits for user review
- **WHEN** the orchestrator calls `plan_tasks`
- **THEN** AgentRunner treats `plan_tasks` as the terminal event for the plan stage
- **AND** stops consuming further plan-stage Orchestrator output
- **AND** compiles and validates the plan
- **AND** publishes a pending plan review
- **AND** waits without launching child agent runs.

#### Scenario: Approved plan starts dispatch
- **WHEN** the user approves a pending plan
- **THEN** AgentRunner re-compiles and re-validates the submitted plan
- **AND** publishes `dispatch.plan`
- **AND** launches child runs according to the approved compiled DAG.

#### Scenario: Edited plan is invalid
- **WHEN** the user submits an edited plan with invalid agents, dependencies, inputs, outputs, or cycles
- **THEN** the API rejects the edit
- **AND** the pending plan remains available for correction.

#### Scenario: Plan is rejected
- **WHEN** the user rejects a pending plan
- **THEN** AgentRunner does not launch child runs
- **AND** the Orchestrator run ends without entering the execute or aggregate stages.

### Requirement: Child tasks SHALL respect dependency order

AgentRunner MUST execute only the approved compiled plan. The original LLM plan MUST NOT be executed if the user edits it during review.

#### Scenario: User changes dependencies before approval
- **WHEN** a pending plan's dependencies are edited
- **AND** the edited plan passes validation
- **THEN** DAG execution follows the edited dependency graph.
