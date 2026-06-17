# Adapters

## Purpose

Defines the AgentPlatformAdapter contract and provider-specific boundaries. Detailed adapter notes live in `specs/05-adapter-interface.md`.

## Requirements

### Requirement: Adapters SHALL translate provider output to StreamEvent

Each adapter MUST expose `stream(input, signal)` and yield only Agent-Conference `StreamEvent` objects to the application layer.

#### Scenario: Custom model emits tool calls
- **WHEN** Chat Completions streaming returns function tool call deltas
- **THEN** CustomAgentAdapter accumulates arguments
- **AND** emits Agent-Conference `tool.call` and `tool.result` events.

### Requirement: CustomAgentAdapter SHALL use Chat Completions compatible providers

CustomAgentAdapter SHALL call OpenAI Chat Completions-compatible endpoints for DeepSeek, OpenAI, and Volcano Ark, with provider-specific base URLs and keys.

#### Scenario: DeepSeek model responds with reasoning
- **WHEN** DeepSeek streams `reasoning_content`
- **THEN** the adapter emits thinking parts
- **AND** includes reasoning content in the assistant message for subsequent turns.

### Requirement: ClaudeCodeAdapter SHALL bridge SDK tool approvals

ClaudeCodeAdapter MUST use `@anthropic-ai/claude-agent-sdk` and route supported tool approvals through Agent-Conference path checks, pending writes, and command blacklist policy.

#### Scenario: Claude Code proposes a file write in review mode
- **WHEN** the SDK asks to use a write/edit tool
- **THEN** the adapter creates a pending write
- **AND** waits for user approval before allowing the SDK tool.

### Requirement: CodexAdapter SHALL use the Codex SDK

CodexAdapter MUST use `@openai/codex-sdk` `runStreamed()` rather than treating CLI spawn as the primary integration path.

#### Scenario: Codex run starts
- **WHEN** a Codex agent receives a prompt
- **THEN** the adapter starts or resumes a Codex thread
- **AND** translates thread, item, tool, and usage events into StreamEvent.

### Requirement: SDK adapters SHALL expose allowlisted Agent-Conference tools through MCP

Claude Code and Codex adapters MUST expose allowlisted Agent-Conference tools through adapter-owned MCP bridges rather than consuming per-agent `toolNames`.

#### Scenario: Codex creates and deploys an artifact or workspace build
- **WHEN** Codex calls the Agent-Conference MCP `write_artifact`, `deploy_artifact`, or `deploy_workspace` tool
- **THEN** the adapter translates the MCP result into `artifact.create` or `deploy.status`.

#### Scenario: SDK agent asks a structured user question
- **WHEN** Claude Code or Codex calls the Agent-Conference MCP `ask_user` tool
- **THEN** Agent-Conference routes it through the shared pending question flow.

### Requirement: Codex Base URL SHALL be Responses compatible

CodexAdapter MUST only accept Codex/Responses-compatible endpoints for `apiBaseUrl`; Chat Completions-only providers such as DeepSeek MUST be rejected or reported with a clear compatibility error.

#### Scenario: User configures DeepSeek for Codex
- **WHEN** `apiBaseUrl` points at `api.deepseek.com`
- **THEN** the adapter rejects the run before reconnect loops
- **AND** the error tells the user to use CustomAgentAdapter.

### Requirement: SDK runtime configuration SHALL be isolated

CodexAdapter MUST set `CODEX_HOME` and `CODEX_SQLITE_HOME` to Agent-Conference-managed data paths and strip unrelated external `CODEX_*` variables except certificate configuration.

#### Scenario: User has CC Switch configured locally
- **WHEN** Agent-Conference starts Codex SDK
- **THEN** the child runtime does not read the user's `~/.codex` config
- **AND** Agent-Conference per-agent settings determine key and base URL.
