# Message Parts

## Purpose

Defines the structured content model for messages. Detailed part variants live in `specs/03-message-parts.md`.

## Requirements

### Requirement: Messages SHALL store content as parts

Message content MUST be an ordered `MessagePart[]`; rich content MUST not be hidden inside one markdown string when a structured part exists.

#### Scenario: Agent calls a tool
- **WHEN** an adapter emits a tool call and result
- **THEN** the message stores `tool_use` and `tool_result` parts
- **AND** the UI renders them as tool activity.

#### Scenario: A bash tool call contains a long command
- **WHEN** a `tool_use` part has `toolName='bash'` and string `args.command`
- **THEN** the UI renders the command in a dedicated copyable terminal-style block
- **AND** the command remains readable through wrapping or scrolling instead of being clipped.

#### Scenario: A bash tool result includes output
- **WHEN** the matching `tool_result` carries `result.output` or an error string
- **THEN** the UI renders that output in a dedicated copyable terminal-style block
- **AND** shows exit code, timeout, and truncation metadata when available.

### Requirement: Thinking content SHALL be distinct from text content

Reasoning or planning output SHALL use `thinking` parts rather than regular `text` parts when the adapter can identify it.

#### Scenario: DeepSeek returns reasoning content
- **WHEN** a streamed delta includes `reasoning_content`
- **THEN** CustomAgentAdapter appends it to a `thinking` part
- **AND** preserves it for follow-up DeepSeek tool turns.

### Requirement: Attachments SHALL be referenced by id

Uploaded images and files MUST be stored as attachment records and referenced from message parts by attachment id.

#### Scenario: User sends an image
- **WHEN** a user message includes an image attachment
- **THEN** the message contains an `image_attachment` part
- **AND** adapters decide whether and how to pass the image to the model.

### Requirement: Artifact references SHALL not duplicate artifact content

Messages SHALL reference artifacts via `artifact_ref` parts instead of embedding artifact JSON or source code in message parts.

#### Scenario: Artifact is created from a tool result
- **WHEN** `write_artifact` returns an artifact id
- **THEN** AgentRunner injects an `artifact_ref` part into the current message.

### Requirement: Deployment status SHALL be structured

Messages SHALL represent deploy preview results with a `deploy_status` part instead of plain text so the UI can render open/copy actions.

#### Scenario: Deployment finishes
- **WHEN** an adapter emits `deploy.status`
- **THEN** AgentRunner injects a `deploy_status` part into the current message
- **AND** the part includes status, source id, title, preview path, optional source type, and optional error.
