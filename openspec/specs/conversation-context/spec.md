# Conversation Context

## Purpose

Defines cross-run history serialization, pinned message injection, and context compaction. Detailed context rules live in `specs/13-conversation-context.md`.

## Requirements

### Requirement: Custom agents SHALL receive bounded chat history

CustomAgentAdapter runs MUST receive serialized conversation history within a model-aware token budget for ordinary user turns.

#### Scenario: Conversation has long history
- **WHEN** AgentRunner builds adapter input
- **THEN** it trims history to fit the model context window and output reserve.

### Requirement: SDK agents SHALL use session resume plus summaries

Claude Code and Codex adapters SHALL rely on SDK session continuation and may receive Agent-Conference context summaries prefixed to new user prompts.

#### Scenario: Codex session continues
- **WHEN** a conversation already has a cached Codex thread id
- **THEN** CodexAdapter resumes the thread instead of replaying full chat history.

### Requirement: Pinned messages SHALL be preserved in context

Pinned messages MUST remain available to context construction even when older unpinned history is summarized or trimmed.

#### Scenario: User pins a message
- **WHEN** context is built after compaction
- **THEN** the pinned message is represented separately from the summary.

### Requirement: Sub-agent prompts SHALL not duplicate global history

Orchestrator-dispatched child runs MUST use their isolated task prompt and skip generic conversation history injection.

#### Scenario: Orchestrator dispatches a child task
- **WHEN** `overridePrompt` is set
- **THEN** AgentRunner does not call `buildHistoryFor` for that child run.

### Requirement: Context compaction SHALL clear SDK sessions

Compacting conversation history MUST clear SDK session caches whose internal state no longer matches the database history.

#### Scenario: Conversation is compacted
- **WHEN** compaction writes a new summary and deletes old messages
- **THEN** Claude Code and Codex session ids for that conversation are cleared.

### Requirement: Context compaction SHALL fail visibly

Compaction MUST NOT silently replace an unavailable model with an unstructured concatenation fallback.

#### Scenario: DeepSeek key is missing
- **WHEN** the user starts compaction without an applicable per-agent, app-settings, or environment key
- **THEN** the service emits `compaction.error`
- **AND** the UI displays the configuration error.

### Requirement: Context budget SHALL be inspectable

The UI SHALL expose an estimated next-run context composition.

#### Scenario: User opens context statistics
- **WHEN** the conversation contains summarized, pinned, recent, and omitted messages
- **THEN** the panel shows summary inclusion, pinned count, recent count, omitted count, and estimated tokens.
