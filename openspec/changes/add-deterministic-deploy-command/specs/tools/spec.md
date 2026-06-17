### Requirement: Chat deploy commands SHALL trigger deployment deterministically

Agent-Conference MUST handle simple deploy commands without relying on an LLM tool call.

#### Scenario: User sends a simple deploy command

- **WHEN** the user sends `部署`, `发布`, `上线`, or `/deploy`
- **THEN** Agent-Conference detects the deployment intent before responder selection
- **AND** does not start an Agent run for that message.

#### Scenario: One deployable artifact exists

- **WHEN** a deploy command is handled
- **AND** the current conversation has exactly one `web_app` artifact
- **THEN** Agent-Conference deploys that artifact through the same deployment helper used by `deploy_artifact`
- **AND** inserts a `deploy_status` message part.

#### Scenario: No deployable artifacts exist

- **WHEN** a deploy command is handled
- **AND** the current conversation has no `web_app` artifacts
- **THEN** Agent-Conference inserts a system text message explaining that no deployable web app exists.
