### Requirement: write_artifact SHALL NOT accept agent-authored diff artifacts

The `write_artifact` tool schema and LLM-facing description MUST expose only normal deliverable artifact types: `web_app`, `document`, `image`, and `ppt`.

#### Scenario: Agent attempts to create a diff artifact

- **WHEN** `write_artifact` receives `type='diff'`
- **THEN** argument validation fails before an artifact row is inserted.

#### Scenario: Agent needs to show changes between artifact versions

- **WHEN** an agent creates a new version of an existing artifact
- **THEN** it SHOULD use `parentArtifactId`
- **AND** Agent-Conference's version compare UI produces the diff from stored versions.
