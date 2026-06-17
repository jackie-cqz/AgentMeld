# Frontend Delta

## MODIFIED Requirements

### Requirement: Deployment cards SHALL expose preview and package actions

Deployment cards MUST show whether a deployment is local-only or externally published, and MUST expose the public URL plus local fallback when available.

#### Scenario: Externally published deployment
- **WHEN** a deployment record has `deploymentType = external_static`
- **THEN** the deployment card labels it as an external static publish
- **AND** opens/copies `previewPath`
- **AND** shows the local preview fallback if present.
