# 16 - Task Contract Artifact Handoff

This spec supplements Spec 06 (Conductor flow) and Spec 07 (tools) with structured task contracts for multi-agent artifact handoff.

## Dispatch Plan Contract

`DispatchPlanItem` may include these optional fields:

```typescript
{
  expectedOutputs?: Array<{
    id: string
    type: ArtifactType
    required?: boolean
    description?: string
  }>
  inputs?: Array<{
    fromTaskId: string
    outputId: string
    required?: boolean
    description?: string
  }>
  acceptanceCriteria?: string[]
}
```

`expectedOutputs.id` and `inputs.outputId` are symbolic keys within one dispatch plan. They are not database artifact ids.

## Plan Compilation

AgentRunner compiles a plan before validation and execution:

- Preserve explicit `dependsOn`.
- Preserve existing deterministic text-based dependency inference.
- Add each `inputs.fromTaskId` to the task's `dependsOn`.
- Keep dependency order stable and de-duplicated.

## Plan Validation

AgentRunner rejects a plan when:

- `expectedOutputs.id` is duplicated within one task.
- `inputs.fromTaskId` references a missing task.
- `inputs.fromTaskId` references the same task.
- `inputs.outputId` does not match the upstream task's `expectedOutputs.id`.
- Existing validation rules fail: empty plan, duplicate task id, unavailable agent, conductor recursion, unknown dependency, duplicate dependency, self dependency, or cycle.

## write_artifact outputKey

`write_artifact` accepts optional `outputKey?: string`.

When a child task declares an expected output, the agent should call:

```json
{
  "type": "document",
  "title": "Product Requirements",
  "outputKey": "prd",
  "content": { "format": "markdown", "content": "..." }
}
```

The tool returns `outputKey` with `artifactId`. AgentRunner maps `taskId.outputKey` to the real artifact id.

For compatibility, if a task has exactly one required expected output and produces exactly one artifact without an `outputKey`, AgentRunner may bind that artifact to the single output.

## Child Prompt Contract

Child prompts include:

```xml
<required_inputs>
  <input fromTaskId="t1" outputId="prd" artifactId="art_xxx" type="document" required="true" />
</required_inputs>

<expected_outputs>
  <output id="ui_spec" type="document" required="true">UI style specification</output>
</expected_outputs>

<acceptance_criteria>
  <item>Must use the upstream PRD</item>
</acceptance_criteria>
```

The child agent must read required input artifacts before working, pass the declared `outputKey` when creating each expected output, and call `report_task_result` at the end.

When `acceptanceCriteria` is present, the child agent must copy each criterion into `report_task_result.acceptanceResults` with `passed` and `evidence`.

## Execution Semantics

- A task with unresolved required inputs is skipped before launching a child run.
- A task that completes without `report_task_result` is converted to `failed`.
- A task whose `report_task_result.status` is `failed` or `blocked` is converted to dispatch `failed`; blocked details remain in the error/report summary because `DispatchTaskStatus` has no separate `blocked` state.
- A task with acceptance criteria is converted to `failed` when any criterion is missing from `acceptanceResults` or has `passed=false`.
- `expectedOutputs` / `outputKey` are artifact handoff metadata, not completion gates. A task can complete without producing artifacts when `report_task_result.status='complete'`.
- If a downstream task declares a required `inputs` reference and the upstream result has no bound artifact for that output key, the downstream task is skipped before launch.
- Optional inputs may be missing; the prompt records them as missing.
- Downstream tasks follow existing skip behavior when dependencies are not complete.

## UI

The dispatch plan card displays compact contract metadata for each task:

- input references such as `t1.prd`
- expected outputs such as `prd:document`
- acceptance criteria count

The plan remains read-only in this change.
