# Add Task Contract Artifact Handoff

## Why

Group orchestration currently treats each sub-task mostly as free-form text plus `dependsOn`. That is enough for basic DAG scheduling, but it leaves artifact handoff implicit: downstream agents must infer which upstream artifacts to read, and the executor only knows that some artifact was created, not whether the task delivered the promised output.

Agent-Conference should make multi-agent collaboration more reliable by turning each dispatch task into an explicit contract: required inputs, expected outputs, and acceptance criteria.

## What Changes

- Extend dispatch plans with task-level `inputs`, `expectedOutputs`, and `acceptanceCriteria`.
- Extend `plan_tasks` so Orchestrator can declare artifact handoff contracts in structured form.
- Compile `inputs` into `dependsOn` and validate that input references match upstream expected outputs.
- Let `write_artifact` accept an optional `outputKey` that binds a produced artifact to an expected output id.
- Inject required inputs, expected outputs, and acceptance criteria into child prompts.
- Treat unresolved required inputs as scheduling skips; task completion itself is reported through `report_task_result`.
- Show task contracts in the dispatch plan card.

## Impact

- Affects Orchestrator planning, dispatch validation, child prompt construction, and artifact creation.
- Keeps the existing three-stage Orchestrator model: plan, execute DAG, aggregate.
- Does not introduce a workflow framework or persist DAG state in this change.
