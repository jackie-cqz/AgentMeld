# Fix Orchestrator Dependency Scheduling

## Why

Group orchestration can start downstream agents too early when the orchestrator describes dependencies in task text but omits the structured `dependsOn` field. The executor correctly follows the DAG it receives, but a malformed plan can still make reviewer or implementation tasks run before upstream artifacts exist.

## What Changes

- Add a plan compilation step before validation and execution.
- Infer high-confidence missing dependencies from task text and plan order.
- Treat review tasks as depending on earlier artifact-producing tasks.
- Provide downstream agents with artifacts from the full transitive dependency closure, not only direct dependencies.
- Fail artifact-producing tasks that finish without creating an artifact so downstream tasks are skipped instead of using stale context.
- Add focused regression tests for the incident pattern.

## Impact

- Affects Orchestrator planning and sub-agent context construction.
- Keeps `plan_tasks` schema unchanged.
- Makes execution more conservative when task text and `dependsOn` disagree.
