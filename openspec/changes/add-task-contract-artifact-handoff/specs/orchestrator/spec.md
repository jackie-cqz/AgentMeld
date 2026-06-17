# Orchestrator Delta

## MODIFIED Requirements

### Requirement: Orchestrator SHALL plan before dispatch

The orchestration flow MUST produce a compiled and validated task plan before launching child agent runs. The plan MAY include structured task contracts for artifact handoff.

#### Scenario: Plan declares task inputs and outputs
- **WHEN** the orchestrator calls `plan_tasks`
- **AND** a task declares `inputs` from an upstream `expectedOutputs.id`
- **THEN** AgentRunner compiles that input reference into the task dependency set
- **AND** validates that the referenced upstream task and output id exist.

#### Scenario: Plan references an unknown output
- **WHEN** a task input references an output id not declared by the upstream task
- **THEN** AgentRunner rejects the plan before publishing `dispatch.plan`.

### Requirement: Child tasks SHALL respect dependency order

AgentRunner MUST execute dispatch tasks as a DAG and skip dependent tasks when prerequisites fail or required inputs cannot be resolved.

#### Scenario: Required input is missing
- **WHEN** a task declares a required input from an upstream output
- **AND** the upstream task completed without binding an artifact to that output
- **THEN** AgentRunner skips the downstream task
- **AND** the dispatch end error explains the missing input.

### Requirement: Child task context SHALL include upstream artifacts

Child task prompts MUST include resolved required input artifacts and expected output instructions when the plan declares task contracts.

#### Scenario: Downstream task receives an input contract
- **WHEN** task `t2` declares an input from `t1.prd`
- **AND** task `t1` produced an artifact bound to output key `prd`
- **THEN** task `t2` sees the artifact id in a structured input block
- **AND** the prompt instructs the agent to read that artifact before working.
