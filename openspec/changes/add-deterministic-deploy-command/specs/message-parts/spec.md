### Requirement: Deploy Candidate Choices SHALL be structured message parts

When a deploy command has more than one deployable artifact candidate, Agent-Conference MUST represent the choice as a structured message part instead of plain text.

#### Scenario: Multiple deployable web apps exist

- **WHEN** a user sends a deterministic deploy command
- **AND** the current conversation has more than one `web_app` artifact
- **THEN** Agent-Conference inserts a `deploy_candidates` message part with the candidate artifact ids, titles, versions, creators, and creation timestamps.

#### Scenario: User chooses a deploy candidate

- **WHEN** the user selects one candidate from a `deploy_candidates` part
- **THEN** Agent-Conference deploys that artifact
- **AND** inserts a `deploy_status` part with the deployment result.
