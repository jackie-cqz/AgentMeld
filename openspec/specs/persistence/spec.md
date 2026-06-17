# Persistence

## Purpose

Defines SQLite/Drizzle physical schema and key storage. Detailed schema notes live in `specs/08-db-schema.md`.

## Requirements

### Requirement: Database schema SHALL map domain entities

The SQLite schema MUST persist agents, conversations, messages, artifacts, workspaces, attachments, agent runs, context summaries, and app settings.

#### Scenario: New conversation is created
- **WHEN** a conversation is inserted
- **THEN** a workspace row is created or associated
- **AND** messages and runs can reference the conversation id.

### Requirement: JSON columns SHALL store typed unions

JSON columns such as `messages.parts`, `artifacts.content`, and usage payloads MUST correspond to TypeScript union types in shared code.

#### Scenario: Message parts are loaded
- **WHEN** the UI fetches messages
- **THEN** each part can be rendered by its discriminant without ad hoc parsing.

### Requirement: API keys SHALL follow defined precedence

Runtime keys MUST resolve in this order: per-agent key, app settings key, environment key, and provider-specific SDK fallback where documented.

#### Scenario: Agent has a custom key
- **WHEN** `agents.api_key` is non-empty
- **THEN** AgentRunner uses it instead of app settings or environment variables.

### Requirement: Base URLs SHALL be adapter-specific

`agents.api_base_url` MUST be interpreted according to adapter protocol: Anthropic-compatible for Claude Code and Codex/Responses-compatible for Codex.

#### Scenario: Codex base URL is set
- **WHEN** a Codex agent has `api_base_url`
- **THEN** it is passed to Codex SDK as `baseUrl`
- **AND** it must not be sourced from global CC Switch config.

### Requirement: App settings SHALL remain local single-user storage

Global API settings MUST be stored in the single-row `app_settings` table and SHALL not introduce OS keychain dependencies in the current local single-user model.

#### Scenario: User saves OpenAI key in settings
- **WHEN** the settings API receives the key
- **THEN** it normalizes empty strings to null
- **AND** stores the value in SQLite.

#### Scenario: User saves external deployment publishing settings
- **WHEN** the settings API receives `deployment_publish_enabled`, `deployment_publish_dir`, or `deployment_public_base_url`
- **THEN** it normalizes empty strings to null
- **AND** stores the values in the single `app_settings` row.
