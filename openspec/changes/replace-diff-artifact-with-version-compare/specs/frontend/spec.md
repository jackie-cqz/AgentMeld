### Requirement: Artifact preview SHALL support version comparison

When an artifact has multiple versions, the preview panel MUST let users compare two versions and render deterministic read-only diffs for supported artifact types.

#### Scenario: User opens compare mode

- **WHEN** the preview panel has loaded more than one version
- **THEN** the UI exposes a compare action
- **AND** defaults to comparing the current version against the previous version when possible.

#### Scenario: Version comparison is unsupported

- **WHEN** the selected versions cannot be compared as stored text
- **THEN** the UI shows an explicit unsupported state
- **AND** does not ask an agent to create a diff artifact.
