# Design

## Review Lifecycle

1. Orchestrator runs Stage 1 and calls `plan_tasks`; AgentRunner treats that call as the terminal plan-stage event and stops consuming further Stage 1 output.
2. AgentRunner parses, compiles, and validates the plan.
3. AgentRunner registers a pending dispatch plan and publishes `dispatch.plan.pending`.
4. The frontend renders the plan in review mode.
5. The user approves the plan as-is, edits and approves, or rejects it.
6. The API validates the submitted plan by re-running compilation and semantic validation.
7. Approval resolves AgentRunner's await point with the compiled plan.
8. AgentRunner publishes the normal `dispatch.plan` event and enters the existing DAG executor.
9. Rejection resolves the await point as rejected; no child runs are launched.

## Pending Store

Add `src/server/pending-dispatch-plans.ts`, matching the HMR-safe in-memory pattern of `pending-questions` and `pending-writes`.

Each entry contains:

```ts
{
  id: string
  conversationId: string
  agentId: string
  runId: string
  plan: DispatchPlanItem[]
  createdAt: number
}
```

The store also keeps a resolver and a validator callback supplied by AgentRunner. The validator returns the compiled plan or throws a clear validation error. Invalid edits keep the pending entry open.

## Events

Add two StreamEvent variants:

```ts
| { type: 'dispatch.plan.pending'; pendingPlan: PendingDispatchPlan }
| { type: 'dispatch.plan.resolved'; pendingId: string; runId: string; approved: boolean }
```

The existing `dispatch.plan` remains the start-of-execution event. It is emitted only after approval and contains the compiled approved plan.

## API

Add REST routes:

- `GET /api/conversations/:id/pending-dispatch-plans`
- `POST /api/conversations/:id/pending-dispatch-plans/:planId`

The POST body is:

```ts
{ action: 'approve', plan: DispatchPlanItem[] } | { action: 'reject' }
```

All request bodies are validated with zod. Server-side plan validation still uses the AgentRunner-supplied validator so edited plans cannot bypass dependency, agent, output, input, or cycle checks.

## Frontend

Extend `DispatchState` with review metadata:

```ts
reviewStatus?: 'pending' | 'approved' | 'rejected'
pendingPlanId?: string
```

Store handling:

- `dispatch.plan.pending` creates a DispatchState attached to the latest Orchestrator message.
- `dispatch.plan.resolved` marks the review approved or rejected.
- `dispatch.plan` keeps the existing execution state and task statuses.

`DispatchPlanCard` becomes editable only while `reviewStatus === 'pending'`. It supports:

- task text editing
- agent reassignment
- comma-separated `dependsOn`
- JSON editing for `expectedOutputs`, `inputs`, and `acceptanceCriteria`
- approve and reject actions

After approval, the card returns to read-only execution progress.

## Failure Semantics

- Invalid edited plans return HTTP 400 and leave the pending plan open.
- Rejected plans publish `dispatch.plan.resolved` with `approved=false` and launch no child runs.
- If the parent run is aborted while waiting, the pending plan is cancelled and removed.
