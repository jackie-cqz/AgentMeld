# Add Orchestrator Plan Review

## Why

The Orchestrator currently executes a generated dispatch plan as soon as it passes deterministic validation. That is fast, but it gives users no chance to correct a poor task split, fix agent assignment, adjust dependencies, or tighten artifact handoff contracts before child agents start doing work.

Agent-Conference should let users review and edit the Orchestrator plan at the collaboration boundary: after planning, before DAG execution.

## What Changes

- Add a pending dispatch plan review state between Stage 1 PLAN and Stage 2 EXECUTE.
- Publish pending plan review events over SSE and expose REST endpoints to list and resolve pending plans.
- Let the UI edit task instructions, agent assignment, dependencies, expected outputs, inputs, and acceptance criteria before approval.
- Re-compile and validate the edited plan on the server before launching child agent runs.
- Allow rejecting a pending plan, ending the Orchestrator run without child tasks.
- Keep dispatch execution and aggregation unchanged after approval.

## Impact

- Affects Orchestrator execution, StreamEvent payloads, Zustand dispatch state, and the dispatch plan card UI.
- Uses the existing in-memory pending queue pattern from pending writes/questions.
- Does not add a DB table, external workflow engine, or new dependency.
