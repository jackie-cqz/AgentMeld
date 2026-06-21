# P0 - DeepSeek Web Runtime, Event Stream, and Tool Closure

## Scope

This project phase explicitly excludes:

- Claude Code SDK adapter and Codex SDK adapter from `specs/05-adapter-interface.md`.
- Desktop Electron work from `specs/12-desktop-electron.md`.
- Mobile companion work from `specs/14-mobile-remote.md` and `openspec/specs/mobile-companion/spec.md`.

The runtime target is a web-only, local-first workspace using the existing `custom` adapter with DeepSeek/OpenAI-compatible APIs.

## Referenced Specs

- `openspec/specs/stream-events/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/tools/spec.md`
- `openspec/specs/artifacts/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/02-stream-events.md`
- `specs/03-message-parts.md`
- `specs/07-tools.md`
- `specs/13-conversation-context.md`

## Current State

Implemented:

- DeepSeek-compatible streaming through `src/server/adapters/custom-agent-adapter.ts`.
- `consumeStream` normalizes `messageId` and `runId`.
- Text, thinking, code, tool call, tool result, artifact create, and usage events are persisted or reflected in UI.
- `ask_user`, `bash`, `fs_write`, `write_artifact`, `deploy_artifact`, and `deploy_workspace` tools exist.
- Pending write, pending bash, pending question, and pending dispatch plan APIs exist.

Important gaps:

- `deploy.status` is handled by the frontend store, but `src/server/consume-stream.ts` does not persist it as a `deploy_status` message part.
- `artifact.create` injects `artifact_ref` into persisted DB parts, but no `part.start` event is emitted for that injected part, so live UI can miss the artifact card until reload or later bootstrap.
- `ask_user.pending` is published using `as never`, not represented in `StreamEvent`.
- The app store does not consume `ask_user.pending` or answer/resolved events.
- `compaction.start/progress/end` events are typed but not fully reflected in frontend state.
- `fs_write.pending` should be verified against the event stream; if it only appears through bootstrap, it fails the live pending review requirement.
- Failed deployment and aborted run events are not consistently converted into visible persisted message parts.

## Target Behavior

After this phase:

- Every user-visible runtime event has both a live SSE representation and a durable message/store representation when required by specs.
- DeepSeek/custom adapter remains the only production adapter path, but it exercises the same runtime event contract expected by the app.
- Pending decisions appear live without requiring refresh.
- Deployment status, artifact references, user questions, compaction progress, and tool failures are visible, replayable, and testable.

## Code Update Plan

### 1. Formalize pending question stream events

Update `src/shared/types.ts`:

- Add a shared `PendingQuestion` type instead of keeping it only in `src/server/pending-questions.ts`.
- Add stream events:
  - `ask_user.pending`
  - `ask_user.answered`
  - `ask_user.cancelled`

Expected shape:

```ts
type StreamEvent =
  | ...
  | (BaseEvent & { type: "ask_user.pending"; pendingQuestion: PendingQuestion })
  | (BaseEvent & { type: "ask_user.answered"; pendingId: string; answers: Record<string, string> })
  | (BaseEvent & { type: "ask_user.cancelled"; pendingId: string; runId: string });
```

Update `src/server/pending-questions.ts`:

- Remove `as never`.
- Publish `ask_user.pending` with typed payload.
- Publish `ask_user.answered` inside `answerQuestion`.
- Publish `ask_user.cancelled` inside `cancelPendingQuestionsForRun`.

Update tests:

- Extend `src/server/pending-queues.test.ts` or add `src/server/pending-questions.test.ts`.
- Assert that registering, answering, and cancelling emit typed events.

### 2. Persist deploy status into message parts

Update `src/server/consume-stream.ts`:

- In `getFlushEvents`, add `deploy.status`.
- In `applyPartsState`, handle `deploy.status`:
  - If a `deploy_status` part already exists for the same deployment id, replace/update it.
  - Otherwise append a new `deploy_status` part.

Expected part:

```ts
{
  type: "deploy_status",
  deployment: event.deployment
}
```

Update tests:

- Add a case in `src/server/consume-stream.test.ts` that feeds `deploy.status` and asserts persisted parts contain `deploy_status`.
- Cover failed deployment too.

### 3. Emit live artifact_ref part for artifact.create

Current behavior in `consume-stream.ts` persists an injected `artifact_ref`, but the frontend only receives `artifact.create`.

Update `consumeStream` flow:

- When `artifact.create` is processed and an `artifact_ref` part is injected, also publish a synthetic `part.start` event for that inserted part.
- Make sure ordering is stable:
  - Publish original `artifact.create`.
  - Publish synthetic `part.start` with the new part index.
  - Flush DB parts.

Alternative implementation:

- Let `applyPartsState` return both `parts` and `sideEvents`.
- `consumeStream` broadcasts side events after the original event.

Tests:

- Add test for `artifact.create` that records published events and asserts `part.start` for `artifact_ref` is emitted.
- Assert idempotency: duplicate `artifact.create` for same artifact does not create duplicate `artifact_ref`.

### 4. Make adapter-emitted artifact.create payload complete

Review `src/server/adapters/custom-agent-adapter.ts`:

- `write_artifact` tool already creates the artifact in DB.
- The adapter currently emits `artifact.create` based on the tool result. Ensure this event carries the complete artifact row, not a partial tool result.

Preferred implementation:

- After executing `write_artifact`, if the result value includes `artifactId`, load the artifact through repository/service.
- Emit `artifact.create` with the loaded artifact.
- If loading fails, emit a typed tool error instead of a malformed artifact event.

Tests:

- Extend `src/server/adapters/custom-adapter.test.ts` to assert `artifact.create.artifact.content` is a valid artifact content object.

### 5. Normalize aborted and failed runtime endings

Update `src/server/agent-runner.ts`:

- Ensure aborted runs do not mark message status as `complete`.
- Use a distinct message status if shared type supports it, or append an explicit text/tool result part saying the run was aborted.
- Ensure failed adapter setup errors become a visible assistant/system message with enough detail for debugging.

Tests:

- Extend `src/server/agent-runner.test.ts`:
  - aborted run produces visible final state.
  - adapter initialization failure produces error message and failed run status.

### 6. Connect compaction stream events to frontend state

Update `src/stores/app-store.ts`:

- Add state:
  - `compactionByConversation`
  - fields: `status`, `stage`, `processedMessages`, `totalMessages`, `summaryId`, `error`
- Handle:
  - `compaction.start`
  - `compaction.progress`
  - `compaction.end`

Update `src/components/context-stats-panel.tsx`:

- Replace local-only progress messaging with store-backed progress.
- Show last compaction result and failure reason.

Tests:

- Extend `src/stores/app-store.test.ts` with compaction event reducer cases.

## Acceptance Checklist

- [ ] `ask_user.pending`, `ask_user.answered`, and `ask_user.cancelled` are first-class typed stream events.
- [ ] Pending questions appear live in frontend without refresh.
- [ ] `deploy.status` is persisted as `deploy_status` part.
- [ ] `artifact.create` produces a live `artifact_ref` part.
- [ ] Adapter artifact events contain complete artifact rows.
- [ ] Aborted and failed runs are visible and not misreported as successful messages.
- [ ] Compaction progress is visible from SSE events.
- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
