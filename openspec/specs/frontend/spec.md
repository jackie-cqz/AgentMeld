# Frontend

## Purpose

Defines client state, event application, and major UI boundaries. Detailed frontend notes live in `specs/09-frontend-architecture.md`.

## Requirements

### Requirement: Frontend SHALL consume server APIs and SSE

The frontend MUST use REST routes and SSE stream events; it SHALL not import or call LLM SDKs directly.

#### Scenario: User sends a message
- **WHEN** the UI posts to the messages API
- **THEN** server-side AgentRunner invokes the adapter
- **AND** UI updates arrive through SSE events.

### Requirement: Store reducers SHALL apply StreamEvent deterministically

Zustand reducers MUST update conversation, message, artifact, pending write, pending bash command, dispatch, and usage state from `StreamEvent` payloads.

#### Scenario: `part.delta` arrives
- **WHEN** the event references an existing part
- **THEN** the store appends content to that part without reordering other parts.

#### Scenario: A failed run leaves an open tool call
- **WHEN** `run.end` arrives with `status='failed'` or `status='aborted'`
- **THEN** the store marks streaming messages from that run as terminal
- **AND** appends local error `tool_result` parts for any unmatched `tool_use` call ids.

#### Scenario: A pending user question arrives
- **WHEN** `ask_user.pending` arrives
- **THEN** the store upserts the pending question by id
- **AND** adds its id to the conversation pending-question bucket.

#### Scenario: Context compaction reports progress
- **WHEN** `compaction.start`, `compaction.progress`, or `compaction.end` arrives
- **THEN** the store updates the compaction state for that conversation without modifying message order.

### Requirement: Frontend entity state SHALL be normalized

Messages, runs, and artifacts MUST be stored in by-id maps with conversation id buckets. Components SHALL consume derived selectors rather than retaining duplicate entity arrays.

#### Scenario: Bootstrap data is loaded
- **WHEN** the bootstrap API returns per-conversation message, run, and artifact arrays
- **THEN** the frontend normalizes them into entity maps and stable id buckets
- **AND** missing conversation buckets become empty arrays.

### Requirement: Artifact preview SHALL be separate from chat rendering

The UI MUST render artifact previews in a dedicated panel and render chat artifact references as cards or links.

#### Scenario: User clicks artifact ref
- **WHEN** an `artifact_ref` part is selected
- **THEN** the preview panel opens the referenced artifact.

### Requirement: Preview URLs SHALL be one-click actions

For `web_app` artifacts and ready deployment status parts, the UI MUST provide open and copy actions for the preview URL. Deployment cards SHOULD distinguish local previews from externally published static deployments.

#### Scenario: Deployment card is ready
- **WHEN** a `deploy_status` part has `status='ready'`
- **THEN** the chat renders a deployment card with open and copy controls.

#### Scenario: Deployment card has external publish metadata
- **WHEN** a `deploy_status` part has `deploymentType='external_static'`
- **THEN** the card labels it as an external static publish
- **AND** shows the local preview fallback when available.

### Requirement: Pending decisions SHALL be inspectable

Pending questions, file writes, bash commands, and dispatch plans MUST render in the active conversation without requiring a refresh.

#### Scenario: A file write needs approval
- **WHEN** `fs_write.pending` arrives
- **THEN** the UI shows the target path, agent/run metadata, and a line diff
- **AND** approve and reject actions remain available while the diff is expanded.

#### Scenario: An orchestrator plan is executing
- **WHEN** dispatch plan and task lifecycle events arrive
- **THEN** the message displays task status, assigned agent, dependencies, and expected outputs.

### Requirement: Agent builder SHALL expose adapter-specific fields

Create/edit agent UI MUST show provider, model, tool, key, and base URL fields according to selected adapter semantics.

#### Scenario: User selects Codex adapter
- **WHEN** `adapterKind='codex'`
- **THEN** provider and Agent-Conference tool checkboxes are hidden
- **AND** Base URL copy says it must support Codex/Responses.
