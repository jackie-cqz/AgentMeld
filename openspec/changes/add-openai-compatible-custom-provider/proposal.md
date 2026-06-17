# Change: Add OpenAI-Compatible Custom Provider

## Why

CustomAgentAdapter currently supports OpenAI, DeepSeek, and Volcano Ark through hardcoded provider base URLs. Users cannot add MiniMax, Qwen, Zhipu, Moonshot, OpenRouter, SiliconFlow, or another OpenAI Chat Completions-compatible service without code changes.

Agent-Conference should let a user configure a custom agent with its own Chat Completions base URL, API key, and model id.

## What Changes

- Add an `openai-compatible` model provider for Custom agents.
- Require per-agent `apiBaseUrl` for `openai-compatible` agents.
- Use the existing OpenAI SDK Chat Completions path with `baseURL=agent.apiBaseUrl`.
- Keep existing named providers and their current global key fallbacks.
- Update the Agent creation/edit UI so Custom agents can enter a Base URL when `openai-compatible` is selected.
- Update specs and docs for the new provider boundary.

## Out Of Scope

- Adding a provider preset manager.
- Adding global settings for arbitrary custom providers.
- Supporting Codex/Responses through CustomAgentAdapter.
- Supporting Anthropic Messages API through CustomAgentAdapter.
- Guaranteeing function/tool-call compatibility for providers that claim OpenAI compatibility but omit `tools` streaming support.
