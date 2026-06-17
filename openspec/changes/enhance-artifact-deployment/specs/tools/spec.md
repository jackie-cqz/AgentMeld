# Tools Delta

## MODIFIED Requirements

### Requirement: Web app artifacts SHALL be deployable to preview URLs

Agent-Conference MUST provide a `deploy_artifact` tool that accepts a web app artifact id and returns a deployment status record with a stable preview path. Successful local deployments MUST materialize static files under Agent-Conference-managed data storage and expose source/container package download paths.

#### Scenario: Agent deploys a web app artifact
- **WHEN** `deploy_artifact` receives a valid `web_app` artifact id
- **THEN** it returns a ready deployment record
- **AND** the record points at a stable `/deployments/{deploymentId}` path
- **AND** the record includes source and container download paths.
- **AND** the record instructs the agent not to invent public hostnames for the preview path.

#### Scenario: Agent deploys a non-web artifact
- **WHEN** `deploy_artifact` receives a document, image, diff, code file, or missing artifact id
- **THEN** it returns a failed deployment record with a user-visible reason.

#### Scenario: Web app contains unsafe file paths
- **WHEN** a web app artifact file path attempts absolute paths or parent traversal
- **THEN** deployment fails with a user-visible reason
- **AND** no files are written outside Agent-Conference deployment storage.
