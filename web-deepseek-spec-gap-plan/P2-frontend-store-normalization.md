# P2 - Frontend Store Normalization and SSE State Model

## Completion Status

Completed. The frontend now uses normalized entity maps and conversation id buckets as the single runtime source of truth. Bootstrap normalization, split event reducers, selectors, pending question state, dispatch state, compaction state, and reducer tests are implemented.

## Scope

This phase implements the frontend architecture needed for the web-only DeepSeek MVP.

Excluded:

- Desktop shell state.
- Mobile companion state.
- Claude/Codex SDK-specific runtime state.

## Referenced Specs

- `openspec/specs/frontend/spec.md`
- `openspec/specs/stream-events/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/orchestrator/spec.md`
- `specs/09-frontend-architecture.md`
- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/17-orchestrator-plan-review.md`

## Current State

Implemented:

- Zustand store exists in `src/stores/app-store.ts`.
- Bootstrap payload includes conversations, agents, messages, artifacts, runs, settings, and pending queues.
- Store handles many stream events.
- Pending writes, bash commands, and dispatch plans are stored.
- Sidebar tab, right panel, and artifact panel width state exist.

Main gaps:

- Store remains array-based:
  - `messagesByConversation: Record<string, Message[]>`
  - `artifactsByConversation: Record<string, Artifact[]>`
  - `runsByConversation: Record<string, AgentRun[]>`
- Specs expect normalized state and selectors.
- No central dispatch progress state.
- No pending question state.
- No compaction progress state.
- No search state.
- No pending attachment/reply/highlight/open-file state.
- Event reducer is becoming too large and fragile.

## Target Behavior

After this phase:

- Store is normalized and resilient to high-frequency streaming events.
- Components consume selectors instead of manually scanning large arrays.
- Pending decisions, dispatch execution, compaction, search, artifact panel, and messages are all represented in state.
- Bootstrap and SSE use the same reducer path where possible.

## Code Update Plan

### 1. Define normalized store shape

Update `src/stores/app-store.ts`.

New core shape:

```ts
interface AppState {
  conversationsById: Record<string, Conversation>;
  conversationIds: string[];

  agentsById: Record<string, Agent>;
  agentIds: string[];

  messagesById: Record<string, Message>;
  messageIdsByConversation: Record<string, string[]>;

  artifactsById: Record<string, Artifact>;
  artifactIdsByConversation: Record<string, string[]>;

  runsById: Record<string, AgentRun>;
  runIdsByConversation: Record<string, string[]>;

  activeConversationId: string | null;
  selectedArtifactId: string | null;
}
```

Temporary compatibility:

- Keep old selectors or computed helper functions while migrating components.
- Remove old array maps only after all components use selectors.

### 2. Add UI workflow state

Add:

```ts
pendingWritesById
pendingWriteIdsByConversation
pendingBashById
pendingBashIdsByConversation
pendingQuestionsById
pendingQuestionIdsByConversation
pendingDispatchPlansById
pendingDispatchPlanIdsByConversation
dispatchesByRunId
compactionByConversation
searchState
attachmentsDraftByConversation
replyTargetByConversation
highlightedMessageId
openFilesByConversation
activeArtifactTabByConversation
```

Keep the state minimal where the UI does not yet need full implementation, but reserve stable names matching specs.

### 3. Split reducer logic by event family

Create files:

- `src/stores/reducers/message-events.ts`
- `src/stores/reducers/run-events.ts`
- `src/stores/reducers/tool-events.ts`
- `src/stores/reducers/artifact-events.ts`
- `src/stores/reducers/dispatch-events.ts`
- `src/stores/reducers/pending-events.ts`
- `src/stores/reducers/compaction-events.ts`

Main store should call:

```ts
applyStreamEvent(draft, event)
```

Benefits:

- Easier tests.
- Easier to keep event contract aligned with specs.
- Store file becomes maintainable.

### 4. Normalize bootstrap payload

Update `src/server/conversation-service.ts` only if needed, but prefer keeping API compatible initially.

Frontend should normalize bootstrap response:

- Convert arrays/maps to `byId` + id arrays.
- Ensure stable ordering by `createdAt`.
- Handle missing buckets as empty arrays.

Add helper:

- `src/stores/normalize-bootstrap.ts`

Tests:

- Input with two conversations, messages, artifacts, runs.
- Output stable id maps.
- Missing conversation buckets become empty arrays.

### 5. Implement selectors

Create `src/stores/selectors.ts`.

Required selectors:

- `selectActiveConversation`
- `selectConversationMessages`
- `selectConversationArtifacts`
- `selectConversationRuns`
- `selectLatestUserMessageId`
- `selectSelectedArtifact`
- `selectConversationPendingWrites`
- `selectConversationPendingBashCommands`
- `selectConversationPendingQuestions`
- `selectConversationPendingDispatchPlans`
- `selectDispatchStateForRun`
- `selectCompactionState`
- `selectSearchResults`

Update components to use selectors:

- `src/components/chat-panel.tsx`
- `src/components/artifact-panel.tsx`
- `src/components/sidebar.tsx`
- `src/components/pending-approval-panel.tsx`
- `src/components/context-stats-panel.tsx`
- `src/components/message-parts.tsx`

### 6. Event handling requirements

Reducer must support:

- `run.start`
- `run.usage`
- `run.end`
- `message.added`
- `message.removed`
- `message.start`
- `message.end`
- `message.usage`
- `part.start`
- `part.delta`
- `part.end`
- `tool.call`
- `tool.result`
- `artifact.create`
- `artifact.update`
- `deploy.status`
- `dispatch.plan`
- `dispatch.plan.pending`
- `dispatch.plan.resolved`
- task execution events from P1
- `fs_write.pending`
- `fs_write.resolved`
- `bash.pending`
- `bash.resolved`
- `ask_user.pending`
- `ask_user.answered`
- `ask_user.cancelled`
- `compaction.start`
- `compaction.progress`
- `compaction.end`

### 7. Add reducer tests before component migration

Update or replace `src/stores/app-store.test.ts`.

Test groups:

- Bootstrap normalization.
- Message streaming.
- Artifact create plus artifact_ref insertion.
- Deploy status update.
- Pending write/bash/question queues.
- Dispatch plan and task progress.
- Compaction progress.
- Run failure synthetic tool result behavior.

## Acceptance Checklist

- [x] Store uses normalized by-id maps and stable id buckets.
- [x] Existing UI still renders conversations, messages, artifacts, runs, agents, and settings.
- [x] Pending questions are represented in store.
- [x] Dispatch execution progress is represented in store.
- [x] Compaction progress is represented in store.
- [x] Components use selectors rather than direct array scanning where practical.
- [x] Reducer tests cover all stream event families.
- [x] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
