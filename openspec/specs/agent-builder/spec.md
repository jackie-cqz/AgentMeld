# Agent Builder

## Purpose

Defines how users create and edit non-orchestrator agents from the UI. Detailed behavior lives in `specs/10-agent-builder.md`.

## Requirements

### Requirement: User-created agents SHALL default to Custom adapter

New agents MUST default to `adapterName='custom'` unless the user selects Claude Code or Codex SDK adapter.

#### Scenario: User opens create dialog
- **WHEN** no existing agent is being edited
- **THEN** adapter kind defaults to Custom
- **AND** provider defaults to DeepSeek.

### Requirement: New custom agents SHALL start with an editable harness prompt

The create dialog MUST prefill `systemPrompt` with a concise Custom agent scaffold that explains goal handling, context loading, tool use, artifact output, workspace safety, and final response expectations.

#### Scenario: User opens create dialog
- **WHEN** no existing agent is being edited
- **THEN** the System Prompt field contains the default Custom agent scaffold
- **AND** the user can edit or replace it before saving.

### Requirement: Custom agents SHALL require provider and model

Custom agents MUST have `modelProvider` and a non-empty `modelId`; SDK agents SHALL ignore `modelProvider`.

#### Scenario: User clears custom model id
- **WHEN** adapter kind is Custom
- **THEN** form submission is rejected.

### Requirement: SDK agents SHALL use built-in tool sets

Claude Code and Codex agents MUST persist `toolNames=[]` because their tools come from the SDK runtime rather than Agent-Conference `toolRegistry`.

#### Scenario: User switches from Custom to Codex
- **WHEN** the form is submitted
- **THEN** the saved agent has no custom tool names.

### Requirement: Custom agents SHALL expose structured question tooling

The agent builder MUST allow custom agents to enable `ask_user`, and newly created custom agents SHOULD include it in the default tool set.

#### Scenario: User creates a custom agent
- **WHEN** the create dialog opens for a Custom adapter agent
- **THEN** `ask_user` is available in the tool checklist
- **AND** it is selected by default.

### Requirement: Custom agents SHALL provide tool presets

The agent builder MUST provide one-click tool presets for common custom-agent roles, including all-purpose, local-code, artifact, and review workflows.

#### Scenario: User selects local-code preset
- **WHEN** the user clicks the local-code tool preset
- **THEN** the selected tools include `deploy_workspace`, `read_artifact`, `fs_read`, `fs_write`, and `bash`
- **AND** artifact creation tools are not selected unless the user adds them manually.

#### Scenario: User creates a custom agent
- **WHEN** the create dialog opens for a Custom adapter agent
- **THEN** the default preset is all-purpose
- **AND** both artifact tools and local workspace file/command tools are selected.

### Requirement: Codex agent configuration SHALL reject unsupported base URLs

The agent builder MUST validate known unsupported Codex base URLs before saving or running the agent.

#### Scenario: DeepSeek URL is entered for Codex
- **WHEN** the Base URL host is `api.deepseek.com`
- **THEN** the UI shows a Codex/Responses compatibility error.

### Requirement: API key hints SHALL match adapter fallback

The UI MUST display key fallback hints that match AgentRunner's key resolution for selected adapter/provider.

#### Scenario: Codex key field is empty
- **WHEN** a Codex agent is saved without per-agent key
- **THEN** runtime falls back to app OpenAI key, `CODEX_API_KEY`, or `OPENAI_API_KEY`.
