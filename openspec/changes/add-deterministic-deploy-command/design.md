# Design: Deterministic Deploy Command

## Flow

```text
user message: 部署 / 发布 / 上线 / /deploy
  -> parse deploy intent
  -> list current conversation web_app artifacts
  -> 0 candidates: system text message
  -> 1 candidate: deploy artifact and emit deploy_status message
  -> many candidates: deploy_candidates message part
  -> user selects candidate
  -> deploy artifact and emit deploy_status message
```

## Decisions

- The deploy command is handled in the message send service before responder selection, so simple deploy commands do not start LLM runs.
- `/deploy` is a UI slash command, but it still stores a user message with `/deploy` for chat history consistency.
- Candidate choice is rendered as a message part, not a transient modal, so refresh and export preserve the pending decision.
- Actual deployment continues to reuse the `deploy_artifact` implementation path.

## Validation

- Pure parser tests cover supported deploy command phrases and non-command text.
- Pure decision tests cover zero, one, many, and explicit artifact selection.
- Existing deployment service tests continue to cover materialization and external static publishing.
