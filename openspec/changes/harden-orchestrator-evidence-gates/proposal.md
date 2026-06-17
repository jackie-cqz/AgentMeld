# Harden Orchestrator Evidence Gates

## Why

Recent group-chat runs show that the orchestration loop can appear complete while the real user task remains unfinished. Child agents wrote partial files, skipped `report_task_result`, or narrowed a failed implementation task into a static review artifact. The final aggregate summary then reported progress without a reliable evidence trail.

Agent-Conference needs a stronger collaboration harness: planning must be explicit, execution must be evidence-based, and aggregation must preserve the original user goal when tasks fail or are retried.

## What Changes

- Add an Agent-Conference-managed `fs_list` tool so agents can inspect workspace directories without brittle shell listing commands.
- Restrict Orchestrator plan stage tools to planning and read-only reconnaissance.
- Extend dispatch task contracts with task kind, target paths, expected workspace changes, required commands, and required evidence.
- Extend `report_task_result` with structured files, commands, and tests evidence.
- Record Agent-Conference-managed `fs_write` and `bash` outcomes per run and evaluate task reports against declared evidence requirements.
- Strengthen replan and aggregation prompts so retry plans cannot silently narrow the original goal and final summaries must call out incomplete work.

## Impact

- Affects Orchestrator planning, task validation, child prompts, tool registry, task result evaluation, and focused tests.
- Keeps the existing AgentRunner and DAG execution model.
- Does not introduce worktree isolation in this change; it prepares the evidence contract needed for a later isolation change.
