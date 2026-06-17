# Persistence Delta

## MODIFIED Requirements

### Requirement: App settings SHALL persist local deployment publish configuration

`app_settings` MUST store optional static publish target configuration.

#### Scenario: User configures static publishing
- **WHEN** the user enters a publish directory and public base URL
- **THEN** Agent-Conference persists `deployment_publish_enabled`, `deployment_publish_dir`, and `deployment_public_base_url`
- **AND** future `deploy_artifact` calls use that target.
