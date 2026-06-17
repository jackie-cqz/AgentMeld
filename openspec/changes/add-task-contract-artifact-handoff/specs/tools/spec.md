# Tools Delta

## MODIFIED Requirements

### Requirement: Tool definitions SHALL be registered centrally

Agent-Conference-managed tools MUST be registered through `toolRegistry` with name, description, JSON schema, and handler.

#### Scenario: Agent binds an artifact to an expected output
- **WHEN** `write_artifact` receives an `outputKey`
- **THEN** the tool returns that `outputKey` alongside the created `artifactId`
- **AND** AgentRunner MAY use it to satisfy the current dispatch task's expected output contract.
