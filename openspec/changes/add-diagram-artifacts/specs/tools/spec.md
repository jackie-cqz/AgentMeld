## MODIFIED Requirements

### Requirement: Tool definitions SHALL be registered centrally

Agent-Conference-managed tools MUST be registered through `toolRegistry` with name, description, JSON schema, and handler.

#### Scenario: Custom agent enables a tool
- **WHEN** an agent's `toolNames` includes `fs_read`
- **THEN** CustomAgentAdapter resolves the tool definition from `toolRegistry`.

#### Scenario: Agent creates a diagram artifact
- **WHEN** `write_artifact` receives `type="diagram"`
- **THEN** the tool validates Mermaid source content through the shared artifact content builder
- **AND** returns an actionable validation error instead of storing invalid Mermaid source
- **AND** stores the result as a typed artifact.
