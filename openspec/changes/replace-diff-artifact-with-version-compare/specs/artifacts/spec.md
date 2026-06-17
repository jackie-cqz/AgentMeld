### Requirement: Artifact version diffs SHALL be generated from stored versions

Artifact diffs MUST be derived from two stored artifact versions rather than authored as standalone agent-created patch artifacts.

#### Scenario: User compares two document versions

- **WHEN** a user selects two versions of a document artifact
- **THEN** Agent-Conference compares the stored markdown content from those versions
- **AND** renders the diff without invoking an agent.

#### Scenario: User compares two web app versions

- **WHEN** a user selects two versions of a web app artifact
- **THEN** Agent-Conference compares the union of stored source files
- **AND** renders one deterministic diff section per file.

### Requirement: Legacy diff artifacts SHALL remain read-only compatible

Existing artifacts with type `diff` MUST remain previewable for compatibility, but they SHALL be treated as historical read-only artifacts.

#### Scenario: User opens a legacy diff artifact

- **WHEN** an artifact with type `diff` is opened
- **THEN** the preview panel renders the stored hunks
- **AND** the UI indicates that it is a legacy read-only diff artifact
- **AND** no apply action is offered.
