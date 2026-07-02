# 17 - Conductor Plan Review

This spec supplements Spec 06 (Conductor flow), Spec 02 (StreamEvent), and Spec 09 (frontend architecture).

## Goal

AgentMeld pauses a Conductor run after Stage 1 planning and before Stage 2 DAG execution so the user can review the dispatch plan and either approve it, reject it, or **revise it conversationally** — describing the desired changes in natural language and letting the Conductor re-plan. Review stays inside the IM/chat paradigm rather than a structured DAG-editing form.

## Lifecycle

1. The Conductor calls `plan_tasks`.
2. AgentRunner parses the raw plan, runs `compileDispatchPlan`, and validates the compiled plan.
3. AgentRunner registers a pending plan review and publishes `dispatch.plan.pending`.
4. The frontend renders the plan **read-only** with 执行 (approve) / 拒绝 (reject) actions plus a hint to type revisions in the composer.
5. The user either:
   - **approves** — the registered plan executes as-is;
   - **rejects** — the dispatch is cancelled;
   - **revises** — sends a natural-language change request; the Conductor re-plans with that feedback and the new plan re-enters review (loop until approve/reject).
6. On approval, the server re-compiles and re-validates the already-registered plan (defensive).
7. AgentRunner publishes the normal `dispatch.plan` event and executes the approved plan.
8. On rejection or parent run abort, no child agent runs are launched.

## Pending Dispatch Plan

```typescript
interface PendingDispatchPlan {
  id: string
  conversationId: string
  agentId: string
  runId: string
  plan: DispatchPlanItem[]
  createdAt: number
}
```

Pending plans are in-memory process state, matching pending writes/questions. They are recoverable through a GET endpoint while the server process is alive, but they are not persisted across dev server restarts.

## Stream Events

```typescript
| { type: 'dispatch.plan.pending', pendingPlan: PendingDispatchPlan }
| { type: 'dispatch.plan.resolved', pendingId: string, runId: string, approved: boolean, revising?: boolean }
```

`dispatch.plan.pending` means a plan is waiting for user action. `dispatch.plan.resolved` with `revising: true` means the current plan was superseded by a revision request — the frontend drops the pending state (the card falls back to read-only) but keeps the run alive; the Conductor soon emits a fresh `dispatch.plan.pending` with the re-planned plan. `dispatch.plan` remains the execution-start event and is emitted only after approval.

## REST API

```text
GET  /api/conversations/:id/pending-dispatch-plans
POST /api/conversations/:id/pending-dispatch-plans/:planId
```

POST body:

```typescript
type ResolvePendingDispatchPlanBody =
  | { action: 'approve' }
  | { action: 'reject' }
  | { action: 'revise'; feedback: string }
```

`approve` carries **no plan body** — the server executes the already-registered (read-only) plan after re-validating it. `revise` carries the user's natural-language `feedback`. Invalid bodies return 400; a registered plan that fails re-validation on approve returns 400 and keeps the pending plan open.

## Conversational Revision

Plan changes are made by **describing them in the chat composer**, not by editing form fields. While a plan is pending review:

- The composer is enabled (even though the Conductor run is technically still running) and routes input to `revise` instead of starting a new run.
- The feedback is persisted and broadcast as a normal user message (so it appears in the thread and on other connected clients), without launching a new run.
- The Conductor re-runs its plan stage with the feedback as context (`buildReviseContext`) and produces a new plan, which re-enters review.

The server (Conductor) is the source of truth for the plan; the client never submits a structured plan.

## Rejection Semantics

Rejecting a plan is an explicit user decision to stop that Conductor dispatch. The system publishes `dispatch.plan.resolved` with `approved=false`, launches no child runs, and does not run aggregation.

## Non-goals

- Persisting pending plan reviews in SQLite.
- Adding a workflow/DAG framework such as LangGraph.
- Adding conversation-level plan approval settings.
- Structured / form-based or drag-and-drop DAG editing — revisions go through conversation.
