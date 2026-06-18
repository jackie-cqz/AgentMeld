# P3 - Frontend UI Component Completion

## Completion Status

Completed for the web-only DeepSeek MVP. Pending questions, dispatch progress, file diffs, structured tool cards, document/web-app artifact editing, DeepSeek-first agent defaults, and masked-key-safe settings are implemented.

## Scope

This phase completes the web UI needed by the DeepSeek MVP.

Excluded:

- Desktop-specific windows, menus, tray, and native dialogs.
- Mobile companion UI.
- Claude/Codex adapter configuration UI beyond clearly marking them unavailable/deferred.

## Referenced Specs

- `openspec/specs/frontend/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/tools/spec.md`
- `openspec/specs/artifacts/spec.md`
- `openspec/specs/agent-builder/spec.md`
- `openspec/specs/conversation-context/spec.md`
- `specs/09-frontend-architecture.md`
- `specs/10-agent-builder.md`
- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/07-tools.md`
- `specs/13-conversation-context.md`
- `agent-conference-preview.png`

## Current State

Implemented:

- Three-column app shell.
- Sidebar with tabs and icons.
- Resizable right Artifact Workspace.
- Chat panel with message bubbles and streaming parts.
- Artifact panel with document/image/web app/source/version views.
- Pending approval panel for writes, bash, and dispatch plan.
- Context stats panel.
- Create/edit agent dialog.

Main gaps:

- Pending question UI is not connected to store/SSE.
- Dispatch execution progress lacks component-level UI.
- Pending write review lacks full diff view.
- Tool card lacks structured bash metadata display.
- Artifact panel edit/version workflow is incomplete.
- Agent Builder defaults still lean OpenAI/gpt naming instead of DeepSeek-first.
- Settings UI exposes API keys but not all web-relevant deployment/context settings.

## Target Behavior

After this phase:

- The app feels like a complete agent collaboration workspace for the web MVP.
- Users can inspect agent thinking, tool calls, approvals, artifacts, deployment status, and context state without reading logs.
- UI components are driven by normalized selectors from P2.
- DeepSeek is the default user-facing model path.

## Code Update Plan

### 1. PendingQuestionCard integration

Files:

- `src/components/pending-question-card.tsx`
- `src/components/pending-approval-panel.tsx`
- `src/stores/selectors.ts`
- `src/app/api/pending-questions/[id]/answer/route.ts`

Tasks:

- Render pending questions from store.
- Support single question and multiple questions.
- Support options and free-form text if schema allows.
- Disable submit while answering.
- Remove card on `ask_user.answered` or `ask_user.cancelled`.
- Show agent name and run context.

Component behavior:

- Question title/header.
- Option buttons or select/radio group.
- Textarea fallback.
- Submit and cancel where supported.

Tests:

- Store reducer removes question on answer.
- Component submits correct payload.

### 2. DispatchProgress component

Create:

- `src/components/dispatch-progress.tsx`

Render:

- Plan title/summary.
- Task list with status:
  - pending
  - running
  - retrying
  - complete
  - failed
  - skipped
  - blocked
- Agent avatar/name.
- Dependency chips.
- Attempt count.
- Required outputs.
- Linked child run/message if available.

Integrate:

- In `src/components/message-parts.tsx` for dispatch parts/events.
- In `src/components/pending-approval-panel.tsx` after approval.
- Optional compact card in chat bubble.

### 3. Pending write diff review

Files:

- `src/components/pending-approval-panel.tsx`
- optionally create `src/components/file-diff-view.tsx`

Tasks:

- Show old/new content diff.
- Support unified diff and split view if simple enough.
- Show file path, size, agent, run, and reason.
- Approve/reject buttons remain sticky.
- For large files, collapse unchanged blocks and show size warning.

Implementation note:

- Use a small local line diff implementation or a lightweight existing package only if already available.
- Keep the first implementation simple: line-by-line LCS or unified changed blocks is enough.

### 4. ToolCard structured rendering

Files:

- `src/components/tool-card.tsx`
- `src/components/message-parts.tsx`

Tasks:

- Render tool name with status icon.
- For `bash` results:
  - command
  - exitCode
  - timedOut
  - truncated
  - stdout/stderr tabs or sections
  - copy output button
- For `fs_write`:
  - path
  - approved/rejected/auto-applied
  - bytes written
- For `ask_user`:
  - question summary
  - answer result
- For `deploy_*`:
  - preview URL
  - source download URL
  - status

### 5. Artifact panel editing and version workflow

Files:

- `src/components/artifact-panel.tsx`
- `src/app/api/artifacts/[id]/route.ts`
- `src/app/api/artifacts/[id]/versions/route.ts`

Tasks:

- Make "Edit" open an editable source/document view, not just source inspection.
- Save creates a new artifact version through existing PATCH/versions route.
- Version history shows parent/child relation and allows switching selected artifact version.
- Add clear states:
  - preview
  - source
  - edit
  - versions
  - deploy
- For document artifacts, edit markdown/text content.
- For web_app artifacts, edit files in a simple file selector + textarea.
- For image artifacts, keep read-only initially.
- For ppt artifacts, render JSON/source until PPT renderer is implemented in a later artifact phase.

### 6. DeepSeek-first Agent Builder

Files:

- `src/components/create-agent-dialog.tsx`
- `src/server/agent-service.ts`
- `src/shared/types.ts`

Tasks:

- Default provider to `deepseek`.
- Default model id to the chosen DeepSeek model used by this project.
- Default adapter remains `custom`.
- Prefill system prompt with a useful scaffold instead of blank.
- Default tool preset should match the role:
  - general assistant: `write_artifact`, `read_artifact`, `ask_user`
  - builder/coder: `fs_list`, `fs_read`, `fs_write`, `bash`, `write_artifact`, `read_artifact`
  - deployer: `bash`, `deploy_artifact`, `deploy_workspace`, `fs_list`, `fs_read`
- Keep Claude/Codex adapter options visible only as disabled/deferred with a short label, or hide them for now.

### 7. Settings dialog web MVP cleanup

Files:

- `src/components/settings-dialog.tsx`
- `src/server/settings-service.ts`

Tasks:

- Prevent masked API keys from being saved back as real values.
- Add explicit DeepSeek key field prominence.
- Add openai-compatible base URL/key guidance if supported by agent-level settings.
- Expose deployment publish settings only if P4 implements publishing.
- Expose context compaction defaults if specs require user control.

Tests:

- Saving settings without editing masked key does not overwrite stored key.

## Acceptance Checklist

- [x] Pending questions appear and can be answered from UI.
- [x] Dispatch progress is visible at task level.
- [x] Pending writes show real diffs.
- [x] Tool cards render bash/fs/deploy/ask_user results structurally.
- [x] Artifact panel supports edit-save-new-version for document and web_app.
- [x] Agent Builder is DeepSeek-first.
- [x] Settings dialog does not corrupt masked API keys.
- [x] UI remains responsive at desktop and narrow widths.
- [x] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass.
