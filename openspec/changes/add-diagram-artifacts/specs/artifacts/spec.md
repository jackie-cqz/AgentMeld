## ADDED Requirements

### Requirement: Diagram artifacts SHALL render editable Mermaid source

Diagram artifacts SHALL store bounded text source in a typed JSON payload and render the source as a visual diagram in the artifact preview panel. The source MUST remain editable as text and edits MUST create new artifact versions.

#### Scenario: Agent creates a Mermaid diagram
- **WHEN** `write_artifact` receives a diagram artifact with Mermaid source
- **THEN** Agent-Conference stores a typed diagram artifact content payload
- **AND** normalizes common Mermaid flowchart label syntax before storage
- **AND** the preview panel renders the Mermaid diagram
- **AND** the preview panel allows zooming and scrolling large diagrams
- **AND** the source remains editable in the artifact panel.

#### Scenario: Mermaid source has a preventable syntax issue
- **WHEN** a diagram artifact contains invalid Mermaid source such as malformed style syntax or unsupported diagram declarations
- **THEN** Agent-Conference rejects the content before storage
- **AND** returns a clear error that the agent or user can use to correct the source.

#### Scenario: User exports a diagram
- **WHEN** a user exports a diagram artifact
- **THEN** Agent-Conference returns the Mermaid source as a `.mmd` file.
