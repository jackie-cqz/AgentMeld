# Frontend Delta

## MODIFIED Requirements

### Requirement: Preview URLs SHALL be one-click actions

For `web_app` artifacts and ready deployment status parts, the UI MUST provide open and copy actions for the preview URL. Ready local deployment cards MUST also expose source and container package downloads when the server provides those paths.

#### Scenario: Deployment card is ready
- **WHEN** a `deploy_status` part has `status='ready'`
- **THEN** the chat renders a deployment card with open and copy controls
- **AND** if source/container download paths exist, the card renders download actions for both packages.
