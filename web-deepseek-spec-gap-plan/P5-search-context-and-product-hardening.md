# P5 - Search, Context Engineering, Agent Builder, and Product Hardening

## Scope

This phase covers the remaining web MVP hardening after runtime, Orchestrator, Store, UI, and artifact/deployment work.

Excluded:

- Desktop Electron.
- Mobile companion.
- Claude/Codex SDK adapters.

## Referenced Specs

- `openspec/specs/conversation-context/spec.md`
- `openspec/specs/agent-builder/spec.md`
- `openspec/specs/persistence/spec.md`
- `openspec/specs/platform-security/spec.md`
- `specs/13-conversation-context.md`
- `specs/10-agent-builder.md`
- `specs/08-db-schema.md`
- `specs/11-platform.md`
- `specs/16-message-search.md`
- `api-key-management.md`

## Current State

Implemented:

- Context summary table and compaction service exist.
- `buildHistoryFor` supports recent messages, pinned messages, summary, and agent-scoped context.
- Pin and withdraw APIs exist.
- Settings persistence includes API keys and deployment fields.
- Agent Builder supports custom agents, providers, base URL, API key override, and tool selection.
- Platform path and command safety utilities exist.

Main gaps:

- Message search from `specs/16-message-search.md` is not implemented.
- Context compaction has a likely OpenAI base URL typo and frontend progress gap.
- Agent Builder defaults are not DeepSeek-first.
- Settings masked API key flow may overwrite stored keys with masked placeholders.
- No user-facing diagnostics page for API key/model/provider health.
- Some platform/security requirements are implemented for tools but not consistently covered by tests.

## Completion State

Completed on 2026-06-18 for the web MVP:

- SQLite FTS5 message search with LIKE fallback, filters, pagination, global search UI, cross-conversation navigation, and message highlight.
- Context budget preview and explicit `compaction.error` state.
- DeepSeek-first compaction configuration with per-agent key/base URL precedence and corrected OpenAI endpoint.
- DeepSeek-first Agent Builder defaults, six role presets, richer harness prompt, and server-side tool allowlist validation.
- Masked-key preservation, explicit clear controls, key-source display, and non-persisting DeepSeek connection diagnostics.
- Security regression coverage for traversal, destructive commands, approval, workspace quotas, deployment publishing, and artifact paths.
- Repository-wide TypeScript typecheck passes and ESLint has no errors.

## Target Behavior

After this phase:

- Users can search messages and jump to results.
- Context engineering is observable and reliable for long conversations.
- Agent creation is DeepSeek-first and role-oriented.
- Settings are safe to edit without corrupting API keys.
- The web MVP has enough diagnostics to debug model/tool failures without reading logs.

## Code Update Plan

### 1. Implement message search backend

Files to add:

- `src/server/search-service.ts`
- `src/app/api/search/route.ts`
- tests:
  - `src/server/search-service.test.ts`
  - `src/app/api/search/route.test.ts`

DB options:

- Preferred: SQLite FTS5 if available through `better-sqlite3`.
- Fallback: LIKE-based search for environments without FTS5.

Schema:

- Add FTS virtual table or bootstrap-created table in `src/db/bootstrap.ts`.
- Index searchable message text parts only.
- Exclude streaming messages until they become complete.

Search fields:

- conversation id
- message id
- role
- agent id
- createdAt
- matched text/snippet
- part index

API:

```http
GET /api/search?q=...&conversationId=...&role=...&limit=20&cursor=...
```

Rules:

- Empty or whitespace query returns validation error or empty result as specs define.
- Limit max query length.
- Escape FTS special syntax safely.
- Support Chinese substring fallback if tokenizer is insufficient.

### 2. Implement search frontend

Files:

- `src/stores/app-store.ts`
- `src/stores/selectors.ts`
- `src/components/search-panel.tsx`
- `src/components/app-shell.tsx`
- `src/components/chat-panel.tsx`

UI:

- Command/search entry in sidebar or top toolbar.
- Search result list grouped by conversation.
- Result snippet with highlight.
- Click result:
  - opens conversation.
  - scrolls/highlights message.

Store:

- `searchState`:
  - query
  - filters
  - status
  - results
  - error
  - highlightedMessageId

Tests:

- API tests for query/filter/pagination.
- Store tests for search results and highlight state.

### 3. Harden context engineering

Files:

- `src/server/conversation-context.ts`
- `src/app/api/conversations/[id]/compact/route.ts`
- `src/components/context-stats-panel.tsx`

Tasks:

- Fix OpenAI base URL typo if still present.
- Make DeepSeek the default compaction provider when available.
- Ensure compaction uses settings and per-agent key precedence consistently.
- Add explicit error handling for missing API key.
- Add context budget preview:
  - estimated tokens
  - included summary
  - included pinned messages
  - recent message count
  - omitted message count
- Make compaction events drive UI via P0/P2 store.

Tests:

- Summary included when present.
- Pinned messages retained.
- Old messages dropped first.
- Missing API key returns visible error.
- Compaction event sequence start -> progress -> end.

### 4. DeepSeek-first Agent Builder hardening

Files:

- `src/components/create-agent-dialog.tsx`
- `src/server/agent-service.ts`
- `src/server/agent-service.test.ts`

Tasks:

- Default provider: `deepseek`.
- Default model: project-selected DeepSeek chat model.
- Default adapter: `custom`.
- Default prompt scaffold:
  - role
  - output style
  - tool usage rules
  - ask_user rule when blocked
  - artifact/report requirements for Orchestrator children
- Tool presets:
  - general
  - coding
  - review
  - deployment
  - research
- Hide or clearly disable Claude/Codex adapters.

Validation:

- Custom adapter requires provider and model.
- OpenAI-compatible provider requires base URL and API key source.
- Tool names must exist in registry.

### 5. Settings API key safety

Files:

- `src/components/settings-dialog.tsx`
- `src/server/settings-service.ts`
- `src/app/api/settings/route.ts`
- `src/server/settings-service.test.ts`
- `src/app/api/settings-api.test.ts`

Tasks:

- Treat masked values like `********abcd` as "unchanged".
- Add explicit clear action for each key.
- Never send masked key as update value unless user typed it intentionally; better: track dirty fields.
- Show key source:
  - env
  - app settings
  - per-agent override
- Add "test connection" endpoint if desired:
  - validates provider/base URL/key/model
  - returns success/error without storing the key.

### 6. Platform/security regression coverage

Files:

- `src/server/security.test.ts`
- `src/server/workspace-utils.test.ts`
- `src/server/tools/tools.test.ts`

Add or verify tests:

- `fs_write` rejects path traversal.
- `fs_read` rejects path traversal.
- `bash` rejects banned destructive patterns.
- `bash` approval flow works for risky commands.
- workspace quota limits work.
- deployment publishing refuses unsafe paths.
- artifact preview refuses unsafe nested paths.

## Acceptance Checklist

- [x] `/api/search` exists and passes service/API tests.
- [x] Frontend search can jump to and highlight messages.
- [x] Context compaction uses correct provider/key/base URL and exposes progress/errors.
- [x] Agent Builder defaults to DeepSeek and useful tool presets.
- [x] Settings cannot accidentally save masked API keys.
- [x] Platform/security regression tests cover path, command, quota, and deployment safety.
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` has no errors.
- [x] Full test suite passes: 37 files / 371 tests.
- [x] Next.js 16 production build passes and includes `/api/search` plus `/api/settings/test-connection`.

## Validation Note

Validated on 2026-06-18:

- TypeScript: passed with `tsc --noEmit`.
- ESLint: zero errors; existing unrelated warnings remain.
- Vitest: 37 files / 371 tests passed.
- Next.js production build: passed.
- Local app: `http://localhost:3002` returned HTTP 200.
- Live search route: `/api/search?q=Agent&limit=1` returned an FTS hit with highlighted snippet.
- In-app browser automation could not start because of the local Windows login sandbox; HTTP, route, Store, and production-build checks were used instead.
