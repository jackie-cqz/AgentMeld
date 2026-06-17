# Change: Add Deterministic Deploy Command

## Why

Users expect sending "部署" or `/deploy` in chat to publish the latest deployable web app. Today that path depends on an agent choosing to call `deploy_artifact`, so it can fail silently, summarize an unusable URL, or choose the wrong artifact when multiple web apps exist.

## What Changes

- Detect simple chat deployment commands deterministically before starting an agent run.
- Add `/deploy` as a slash command that uses the same deterministic flow.
- List deployable `web_app` artifacts from the current conversation.
- Auto-deploy when exactly one candidate exists.
- Render a structured chooser when multiple deployable artifacts exist.
- Insert deployment results as existing `deploy_status` message parts.

## Out Of Scope

- New deployment providers.
- Persistent deployment database rows.
- Deploying non-`web_app` artifacts.
