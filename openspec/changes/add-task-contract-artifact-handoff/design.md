# Design

## Task Contract Shape

`DispatchPlanItem` gains optional contract fields:

```ts
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

`id` and `outputId` are symbolic keys within a single dispatch plan. They are not artifact ids. Runtime maps `(taskId, outputId)` to the actual artifact id created by a child run.

## Plan Compilation

`compileDispatchPlan` preserves existing dependency inference and also adds dependencies implied by `inputs.fromTaskId`.

`validateDispatchPlan` rejects:

- duplicate output ids within a task
- `inputs.fromTaskId` that does not exist
- `inputs.outputId` that does not match an upstream `expectedOutputs.id`
- input self-dependencies
- existing invalid dependency cases such as cycles and unknown agents

## Artifact Handoff

`write_artifact` accepts optional `outputKey`. The tool returns it with the new artifact id. The adapter still publishes `artifact.create` as today.

`consumeStream` records the output key from `tool.result` and attaches it to the next `artifact.create` event from that tool call. Child task results carry:

```ts
outputArtifacts: Record<string, string>
```

Where the key is `outputKey` and the value is `artifactId`.

If a task creates an artifact for a declared expected output, the run should pass the matching `outputKey`. For compatibility, if a task has exactly one required expected output and creates exactly one artifact without an output key, the executor may bind that artifact to the output automatically.

## Child Prompt

Child prompts include:

- `<required_inputs>` with resolved upstream artifact ids
- `<expected_outputs>` with output ids/types/descriptions
- `<acceptance_criteria>`

Agents are instructed to read required input artifacts before working and to pass `outputKey` when creating declared outputs.

## Scheduling Semantics

- A task with unresolved required inputs is skipped before launching.
- Expected outputs are handoff metadata, not task completion gates.
- Task completion is reported through `report_task_result`.
- Optional inputs may be missing; the child prompt records them as missing.
- Downstream tasks keep using the existing blocker logic.

## UI

The dispatch plan card shows compact contract metadata: input references, expected outputs, and acceptance criteria count. It remains read-only in this change.
