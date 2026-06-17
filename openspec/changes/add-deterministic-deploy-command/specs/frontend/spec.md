### Requirement: Slash deploy command SHALL use the deterministic deploy flow

The chat composer MUST expose `/deploy` and route it to the same deterministic deployment flow as sending a deploy command.

#### Scenario: User selects `/deploy`

- **WHEN** the user selects `/deploy` from the slash command menu
- **THEN** the composer sends `/deploy` as a user message
- **AND** Agent-Conference returns either a deployment status card, a no-candidate message, or a candidate chooser.

#### Scenario: Candidate chooser is rendered

- **WHEN** a `deploy_candidates` message part is rendered
- **THEN** the UI shows each candidate with title, version, creator, and timestamp
- **AND** each candidate has a deploy action that calls the deterministic deploy API.
