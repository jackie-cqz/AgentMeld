### Requirement: CustomAgentAdapter SHALL support per-agent OpenAI-compatible endpoints

CustomAgentAdapter SHALL support `modelProvider='openai-compatible'` by calling the OpenAI SDK Chat Completions API with `baseURL` from the agent's `apiBaseUrl`.

#### Scenario: Generic OpenAI-compatible agent runs

- **WHEN** a Custom agent has `modelProvider='openai-compatible'`, a non-empty `modelId`, a per-agent `apiKey`, and a per-agent `apiBaseUrl`
- **THEN** CustomAgentAdapter creates an OpenAI client using that key and base URL
- **AND** streams Chat Completions output through the existing StreamEvent translation path.

#### Scenario: Generic provider is missing Base URL

- **WHEN** a Custom agent has `modelProvider='openai-compatible'` without a non-empty `apiBaseUrl`
- **THEN** the run fails before calling the upstream API
- **AND** the error explains that a Chat Completions Base URL is required.
