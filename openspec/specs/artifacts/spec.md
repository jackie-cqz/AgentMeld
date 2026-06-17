# Artifacts

## Purpose

Defines generated artifacts, versioning, previews, and export behavior. Detailed artifact content notes live in `specs/04-artifacts.md`.

## Requirements

### Requirement: Artifacts SHALL have independent lifecycle

Artifacts MUST be stored independently from messages and linked to conversations, creators, type, version, and optional parent artifact id.

#### Scenario: UI opens an artifact card
- **WHEN** a user selects an artifact reference
- **THEN** the preview panel loads the artifact by id
- **AND** message content is not used as the source of truth.

### Requirement: Artifact content SHALL be typed

Artifact content MUST be a discriminated union keyed by artifact type so renderers can validate and branch without markdown parsing.

#### Scenario: HTML artifact renders
- **WHEN** an artifact has web app content
- **THEN** the preview renders it in a sandboxed iframe.

### Requirement: PPT artifacts SHALL support rich semantic slide blocks

PPT artifact content SHALL accept a richer structured slide model in addition to the legacy simple `title` / `bullets` / `layout` slide shape. The richer model MUST remain JSON-serializable, MUST be renderable in the preview panel, and MUST be exportable to `.pptx`.

#### Scenario: Agent creates a rich PPT deck
- **WHEN** `write_artifact` receives a PPT artifact containing semantic slide blocks such as metrics, columns, timelines, quotes, callouts, or bullet groups
- **THEN** Agent-Conference stores a typed PPT artifact content payload
- **AND** the preview panel renders the blocks using the deck theme and layout rules
- **AND** the artifact remains editable as JSON in the artifact panel.

#### Scenario: Legacy PPT deck is opened
- **WHEN** an existing PPT artifact contains only legacy simple slides
- **THEN** Agent-Conference renders and exports it without data migration
- **AND** normalizes the legacy fields to equivalent semantic blocks at render/export time.

### Requirement: PPT export SHALL expose editable and visual-priority modes

PPT artifacts SHALL export to a real `.pptx` file. Editable export MUST preserve semantic text and shapes where possible. Visual-priority export MUST be an explicit mode; when a renderer is configured, it MUST produce image-backed slides for custom visual markup that cannot be faithfully represented as editable PowerPoint elements. When no renderer is available, it MUST fail clearly without affecting editable export.

#### Scenario: User downloads editable PPTX
- **WHEN** a user exports a PPT artifact without selecting visual-priority mode
- **THEN** Agent-Conference generates a `.pptx` using semantic slide blocks through the PowerPoint export pipeline
- **AND** text and basic shapes remain editable in PowerPoint where supported by the block type.

#### Scenario: Visual export renderer is unavailable
- **WHEN** visual-priority export is requested but the configured renderer is unavailable
- **THEN** Agent-Conference returns a clear export error
- **AND** editable export remains available for the same PPT artifact.

### Requirement: PPT artifact assets SHALL avoid unbounded binary JSON

PPT artifact content MUST NOT store large binary slide assets directly in the JSON payload. Images and custom visual resources SHALL be referenced by bounded URLs, existing attachment/artifact identifiers, or workspace-backed paths that can be resolved safely.

#### Scenario: Agent creates a slide with an image
- **WHEN** a PPT slide references an image asset
- **THEN** the artifact content stores a safe reference rather than raw unbounded binary bytes
- **AND** preview/export code resolves the asset through existing safe artifact, attachment, or workspace access paths.

### Requirement: Web app preview SHALL be addressable

Each `web_app` artifact MUST have an HTTP preview route that renders the same HTML package used by the preview panel under sandboxing headers.

#### Scenario: User opens preview URL
- **WHEN** the user opens `/api/artifacts/{id}/preview`
- **THEN** a `web_app` artifact is returned as sandboxed HTML
- **AND** non-web artifacts are rejected.

### Requirement: Artifact writes SHALL record ownership

Every artifact created by an agent MUST record the originating conversation and agent id.

#### Scenario: Tool creates an artifact
- **WHEN** `write_artifact` succeeds
- **THEN** the inserted artifact row includes `conversationId` and `createdByAgentId`.

### Requirement: Artifact edits SHALL be append-only

Editing an artifact SHALL create a new artifact version linked to the previous version instead of mutating historical content when edit flows are implemented.

#### Scenario: Future edit creates a version
- **WHEN** an artifact edit flow is implemented
- **THEN** it creates a new row with `parentArtifactId`
- **AND** increments `version`.
