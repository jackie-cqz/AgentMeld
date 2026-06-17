## ADDED Requirements

### Requirement: Agent creation SHALL start with a creation-mode choice
The agent builder SHALL keep one user-facing "Create Agent" entry point and, for new agents, show a first-step choice between conversational creation and detailed configuration.

#### Scenario: User starts creating an agent
- **WHEN** the user clicks the existing "Create Agent" button
- **THEN** the dialog shows creation-mode choices for conversational creation and detailed configuration
- **AND** no agent is persisted until the user completes one of those flows and confirms creation.

#### Scenario: User chooses detailed configuration
- **WHEN** the user selects detailed configuration from the first step
- **THEN** the existing detailed agent form is shown
- **AND** the form keeps the current default custom adapter, provider, model, tool preset, and validation behavior.

#### Scenario: User edits an existing agent
- **WHEN** the dialog is opened with an existing agent
- **THEN** the creation-mode choice is skipped
- **AND** the existing detailed edit form is shown with the agent's saved values.

### Requirement: Conversational creation SHALL produce a reviewed draft
The conversational creation path SHALL collect the user's plain-language agent intent, generate an agent configuration draft, and show the draft for review before persistence.

#### Scenario: User describes a desired agent
- **WHEN** the user submits a plain-language description in the conversational creation path
- **THEN** the system generates a draft containing name, description, capabilities, system prompt, adapter/model fields, vision support, and tool selections
- **AND** the draft is displayed to the user before save.

#### Scenario: Draft has assumptions
- **WHEN** generation uses defaults or inferred choices for provider, model, tools, or behavior
- **THEN** the review UI shows those assumptions or rationale before the user confirms creation.

#### Scenario: User confirms a draft
- **WHEN** the user confirms the reviewed draft
- **THEN** the app persists the agent through the existing agent creation API/service
- **AND** the saved agent is a non-orchestrator user-created agent.

#### Scenario: User wants full control after draft generation
- **WHEN** the user chooses to edit details from the draft review
- **THEN** the detailed configuration form opens prefilled with the draft values
- **AND** saving still uses the existing detailed form validation and persistence path.

### Requirement: Conversational drafts SHALL respect existing adapter and tool constraints
The conversational draft generator SHALL enforce the same adapter, provider, model, and tool constraints as the detailed agent builder.

#### Scenario: Draft creates a custom agent
- **WHEN** the draft adapter is Custom
- **THEN** the draft includes a non-empty provider and model id
- **AND** tool names are selected only from the agent builder's available custom-agent tools.

#### Scenario: Draft creates an SDK adapter agent
- **WHEN** the draft adapter is Claude Code or Codex
- **THEN** the draft persists no custom tool names
- **AND** the review UI explains that SDK tools come from the adapter runtime.

#### Scenario: Draft selects tool permissions
- **WHEN** tool permissions are inferred from user intent
- **THEN** the selection is derived from deterministic local rules or existing presets
- **AND** the review UI shows the granted permissions before the user saves.

#### Scenario: Draft considers orchestrator-only tools
- **WHEN** the draft generator maps tools for a user-created agent
- **THEN** orchestrator-only tools such as `plan_tasks` are excluded.
