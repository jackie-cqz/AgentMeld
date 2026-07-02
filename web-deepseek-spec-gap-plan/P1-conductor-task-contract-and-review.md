# P1 - Conductor Task Contract, Evidence Gates, and Plan Review

## Scope

This phase focuses on the web-only DeepSeek Conductor path.

Excluded:

- Claude/Codex SDK adapter execution.
- Desktop Electron packaging.
- Mobile companion dispatch.

## Referenced Specs

- `openspec/specs/conductor/spec.md`
- `openspec/specs/tools/spec.md`
- `openspec/specs/artifacts/spec.md`
- `specs/06-conductor-flow.md`
- `specs/07-tools.md`
- `specs/16-task-contract-handoff.md`
- `specs/17-conductor-plan-review.md`
- `llm-prompts.md`
- `message-flow-with-prompts-new.md`

## Current State

Implemented:

- Conductor can choose direct answer or plan.
- `plan_tasks` supports `expectedOutputs`, `inputs`, `acceptanceCriteria`, and `maxAttempts`.
- Pending plan approval exists.
- DAG execution, dependency waves, retries, conflict detection, and aggregate stage exist.
- DeepSeek/custom adapter can be used for plan and aggregate stages.

Main gaps:

- `report_task_result` does not accept structured `artifacts`, `files`, `commands`, or `tests`.
- `ParsedTask` has evidence-oriented fields, but the plan tool schema does not expose all of them consistently.
- `DispatchPlanItem` used by UI review is less rich than `ParsedTask`, so pending plan review loses important contract details.
- `dispatch.plan` execution state is not fully published or consumed.
- Plan revision should carry natural-language feedback, not a fake replacement plan task.
- Child task artifact handoff depends on `report.artifacts`, but reports currently always record `artifacts: {}`.

## Target Behavior

After this phase:

- Conductor plans have explicit task contracts.
- Each child task can report artifacts, file evidence, command evidence, test evidence, and acceptance criteria results.
- Conductor validates the report before marking a task complete.
- Downstream tasks receive artifact handoff inputs from upstream output keys.
- Plan approval/revision UI displays and preserves the full task contract.

## Code Update Plan

### 1. Expand report_task_result schema

Update `src/server/tools/conductor-tools.ts`.

Add fields to `reportTaskResultTool.parameters` and `reportSchema`:

```ts
artifacts?: Record<string, string>;
files?: Array<{
  path: string;
  action?: "created" | "modified" | "deleted" | "read";
  summary?: string;
}>;
commands?: Array<{
  command: string;
  exitCode: number;
  passed?: boolean;
  summary?: string;
}>;
tests?: Array<{
  command: string;
  passed: boolean;
  summary?: string;
}>;
```

Rules:

- `artifacts` maps `expectedOutputs[].id` or `outputKey` to `artifactId`.
- `files.path` must be workspace-relative or normalized through existing workspace path utilities.
- `commands` and `tests` must be bounded by count and summary length.
- Failed or blocked reports may omit artifacts but should provide blockers.

Update `recordTaskReport` payload:

- Store the new fields in memory.
- Preserve backward compatibility for existing tests.

### 2. Expose full task contract in plan_tasks

Update `planTasksTool.parameters`:

- Add `targetPaths`.
- Add `requiredCommands`.
- Add `requiredEvidence`.
- Tighten descriptions so DeepSeek understands when to use each field.

Update `planArgsSchema` and `parsePlanArgs`:

- Parse those fields.
- Apply defaults:
  - `dependsOn: []`
  - `inputs: []`
  - `expectedOutputs: []`
  - `acceptanceCriteria: []`
  - `maxAttempts: 1`
  - `targetPaths: []`
  - `requiredCommands: []`
  - `requiredEvidence: []`

Tests:

- Extend `src/server/tools/conductor-tools.test.ts`.
- Cover defaults, max bounds, invalid dependency, duplicate output id, and evidence fields.

### 3. Make DispatchPlanItem match the rich contract

Update `src/shared/types.ts`:

- Expand `DispatchPlanItem` to include:
  - `title`
  - `prompt`
  - `dependsOn`
  - `inputs`
  - `expectedOutputs`
  - `acceptanceCriteria`
  - `maxAttempts`
  - `targetPaths`
  - `requiredCommands`
  - `requiredEvidence`

Update producers:

- `src/server/conductor-service.ts`
- `src/server/dispatch-plan-manager.ts`
- `src/app/api/dispatch-plans/[id]/resolve/route.ts`
- `src/app/api/conversations/[id]/pending-dispatch-plans/route.ts`

Update consumers:

- `src/stores/app-store.ts`
- `src/components/pending-approval-panel.tsx`

### 4. Publish dispatch execution lifecycle

Add or standardize events:

- `dispatch.plan` once execution begins.
- `dispatch.task.start`
- `dispatch.task.retry`
- `dispatch.task.end`
- `dispatch.aggregate.start`
- `dispatch.aggregate.end`

If avoiding new event names, at minimum enrich existing events in `src/shared/types.ts` and publish:

- full plan at execution start.
- per-task status updates with task id, agent id, child run id, attempt number, dependency state, and error.

Update `src/server/conductor-service.ts`:

- Publish execution plan before first child wave.
- Publish child task start after child run is created so `childRunId` is not empty.
- Publish retry status before each retry.
- Publish skipped task state when dependency failure blocks execution.

Tests:

- Add Conductor tests that record eventBus output and assert event order.

### 5. Implement strict output handoff

Update `src/server/conductor-service.ts`:

- When a task declares `expectedOutputs`, require corresponding entries in `report.artifacts` unless `required: false`.
- Verify every reported artifact id exists and belongs to the same conversation.
- Store output bindings as:

```ts
taskId.outputId -> artifactId
```

- When downstream task has `inputs`, inject artifact references into its child prompt.
- If required input is missing, mark task skipped/failed before starting child run.

Update child prompt builder:

- `src/server/child-prompt-builder.ts`
- Include exact artifact id, title, type, and output key.
- Tell the child agent not to invent ids.

Tests:

- Upstream report with artifact satisfies downstream input.
- Missing required output blocks downstream task.
- Optional missing output does not block downstream task.
- Invalid artifact id fails evaluation.

### 6. Replace fake revise plan flow with feedback-driven revision

Current UI can send a synthetic revised plan task. Replace this with the spec flow.

Update API:

- Keep `src/app/api/dispatch-plans/[id]/resolve/route.ts` for approve/reject.
- Add support for:

```json
{
  "action": "revise",
  "feedback": "..."
}
```

Server behavior:

- Resume/re-run Conductor PLAN stage with original user request plus reviewer feedback.
- Produce a new pending plan id.
- Preserve old pending plan as rejected/revised.

Update UI:

- `src/components/pending-approval-panel.tsx`
- Replace revisedPlan JSON hack with feedback textarea.

Tests:

- Revising creates a new pending plan.
- Old pending plan is resolved as revised/rejected.
- Feedback appears in the revised plan prompt.

## Acceptance Checklist

- [ ] `report_task_result` supports artifacts, files, commands, and tests.
- [ ] Plan contracts preserve expected outputs, inputs, acceptance criteria, attempts, and evidence fields from backend to UI.
- [ ] Dispatch lifecycle events are live and replayable.
- [ ] Downstream tasks receive verified upstream artifact handoff.
- [ ] Missing required artifacts fail or skip dependent tasks deterministically.
- [ ] Plan revision uses human feedback, not fake replacement tasks.
- [ ] Conductor tests cover happy path, missing output, retry, skipped dependency, and revision.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
