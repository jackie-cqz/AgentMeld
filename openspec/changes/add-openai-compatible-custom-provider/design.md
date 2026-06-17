# Design: OpenAI-Compatible Custom Provider

## Flow

```text
Create/Edit Agent
  -> adapterName = custom
  -> modelProvider = openai-compatible
  -> modelId = user supplied
  -> apiKey = per-agent key
  -> apiBaseUrl = per-agent Chat Completions base URL

AgentRunner
  -> passes apiKey and apiBaseUrl through AdapterInput

CustomAgentAdapter
  -> new OpenAI({ apiKey, baseURL: apiBaseUrl, maxRetries })
  -> chat.completions.create({ stream: true, tools, ... })
```

## Decisions

- `openai-compatible` is a Custom adapter provider, not a new adapter.
- `apiBaseUrl` is required for this provider because there is no meaningful default endpoint.
- `apiKey` is resolved from the agent only for `openai-compatible`; global OpenAI/DeepSeek/Ark keys remain tied to named providers.
- The first implementation keeps tool definitions enabled. Providers that do not support OpenAI tool calls will fail with their upstream error; a future change can add a per-agent "disable tools" option if needed.
- Context compaction can use an `openai-compatible` agent only when both per-agent `apiKey` and `apiBaseUrl` are present; otherwise it skips that agent and falls back to other choices.

## Validation

- Typecheck should cover provider union changes.
- Unit tests should cover `CustomAgentAdapter` client selection for `openai-compatible`.
- Lint should remain clean except for existing warnings.
