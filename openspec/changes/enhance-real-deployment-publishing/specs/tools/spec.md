# Tools Delta

## MODIFIED Requirements

### Requirement: deploy_artifact SHALL create deployable web app outputs

`deploy_artifact` MUST create a local static deployment for `web_app` artifacts and SHOULD publish it to a configured external static directory when publishing is enabled.

#### Scenario: Static directory publishing is configured
- **WHEN** `deploy_artifact` deploys a `web_app`
- **AND** app settings include an enabled publish directory and public base URL
- **THEN** Agent-Conference copies public deployment files to `<publishDir>/<deploymentId>/`
- **AND** the deployment status record uses the public URL as `previewPath`
- **AND** the record also includes a local preview fallback.

#### Scenario: External publishing fails
- **WHEN** local deployment succeeds
- **AND** external static publishing fails
- **THEN** the deployment status record is `failed`
- **AND** the record includes the local preview path and error text.
