# Core Domain

## Purpose

Defines Agent-Conference's durable entities and ownership boundaries. Detailed field notes live in `specs/01-core-entities.md`.

## Requirements

### Requirement: Core entities SHALL remain normalized

Agent-Conference SHALL model Agent, Conversation, Message, Artifact, Workspace, Tool, and AgentRun as separate domain concepts with explicit references instead of embedding unrelated lifecycle data into a single record.

#### Scenario: Message references an artifact
- **WHEN** an agent creates an artifact during a run
- **THEN** the message contains an `artifact_ref` part
- **AND** the artifact content and version metadata remain in the artifacts table.

### Requirement: Agents SHALL route through an adapter name

Every runnable agent MUST declare an `adapterName` of `custom`, `claude-code`, `codex`, or `mock`, and AgentRunner SHALL use that value to resolve the adapter.

#### Scenario: Codex agent is configured
- **WHEN** an agent has `adapterName='codex'`
- **THEN** `modelProvider` is ignored
- **AND** `toolNames` is forced to an empty list because Codex uses SDK-provided tools.

### Requirement: Conversations SHALL own workspace policy

Each conversation SHALL have exactly one workspace record that determines effective cwd, filesystem approval mode, pinned message ids, and local vs sandbox workspace semantics.

#### Scenario: Local workspace conversation runs a tool
- **WHEN** a tool receives a relative path
- **THEN** the path is resolved under the conversation's effective cwd
- **AND** writes outside that tree are rejected.

### Requirement: Agent runs SHALL be auditable

Each agent execution MUST create an AgentRun record with trigger message, parent run if any, status, timestamps, and usage when reported.

#### Scenario: Adapter throws
- **WHEN** an adapter stream fails
- **THEN** the AgentRun status becomes `failed`
- **AND** the user sees an error message in the conversation.
