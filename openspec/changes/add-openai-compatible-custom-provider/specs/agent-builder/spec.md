### Requirement: Agent Builder SHALL expose OpenAI-compatible Custom endpoint settings

The Agent Builder UI SHALL let users select `OpenAI-compatible` for Custom agents and enter a per-agent Chat Completions Base URL.

#### Scenario: User selects OpenAI-compatible provider

- **WHEN** the user selects Custom adapter and provider `OpenAI-compatible`
- **THEN** the form shows a Base URL input
- **AND** submission requires a non-empty Base URL.

#### Scenario: User saves a generic provider agent

- **WHEN** the form is submitted with provider `OpenAI-compatible`
- **THEN** the API request includes `modelProvider='openai-compatible'`, `modelId`, `apiKey`, and `apiBaseUrl`.
