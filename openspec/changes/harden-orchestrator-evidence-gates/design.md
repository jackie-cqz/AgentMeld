# Design

## Plan Mode Boundary

The Orchestrator plan stage gets a constrained tool set:

- `plan_tasks`
- `ask_user`
- `fs_list`
- `fs_read`
- `read_artifact`
- `read_attachment`

This keeps planning read-only while still allowing codebase reconnaissance. Write tools and general shell execution remain execution-stage tools.

## Task Contract Additions

`DispatchPlanItem` gains optional fields:

```ts
taskKind?: 'code' | 'test' | 'review' | 'design' | 'doc' | 'analysis'
targetPaths?: string[]
expectedWorkspaceChanges?: string[]
requiredCommands?: Array<{ command: string; description?: string }>
requiredEvidence?: string[]
```

The fields are declarative. They let Orchestrator state what a task is expected to touch and how completion must be proven. They are not a replacement for `acceptanceCriteria`; they are execution evidence hints that AgentRunner can verify from tool traces.

## Evidence Capture

Agent-Conference records tool outcomes per run for managed tools:

- `fs_write`: relative path, absolute path, bytes, applied mode.
- `bash`: command, cwd, exit code, timeout flag, whether the tool returned an error.

The evidence store is in-process and cleared after each child run is evaluated, matching the existing dispatch file-write tracking lifecycle.

## Report Shape

`report_task_result` accepts optional structured evidence:

```ts
filesChanged?: Array<{ path: string; action?: 'created' | 'modified' | 'deleted' | 'verified' }>
commandsRun?: Array<{ command: string; exitCode: number | null; summary?: string }>
tests?: Array<{ command: string; passed: boolean; summary?: string }>
```

Agents still call the tool exactly once. `status='complete'` is accepted only when required acceptance criteria and required evidence are satisfied.

## Evaluation Rules

For tasks that declare evidence:

- Each `targetPaths` item must appear in `filesChanged` or be covered by an actual `fs_write` path.
- Each `requiredCommands.command` must appear in `commandsRun` or in actual `bash` evidence with `exitCode === 0` and `timedOut === false`.
- Each `requiredEvidence` string must be mentioned by an acceptance result or report summary.
- Any actual managed `bash` command with non-zero exit or timeout blocks completion unless the report is non-complete or explicitly identifies the command as a blocker.

These checks are deliberately conservative and focused on Agent-Conference-managed tools. SDK-native file edits remain a known limitation until worktree/shadow workspace isolation is added.

## Replan and Aggregate Semantics

Replan prompts include the original goal and failed evidence. The Orchestrator is instructed to remediate failed or missing acceptance only, not to narrow the goal unless the user explicitly approves.

Aggregate prompts include task contract and evidence summaries. Final output must report incomplete work when any required task failed, skipped, or lacked evidence.
