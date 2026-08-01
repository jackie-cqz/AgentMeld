# AgentMeld E2E Assets

This directory stores public seeds, hidden verifier inputs, and generation recipes for draft benchmark cases.

Visibility rules:

- `public/`: copied into the Agent workspace.
- `setup/`: executed by the benchmark environment before the Agent starts; not exposed to the Agent.
- `hidden/`: mounted only for the post-run verifier; never included in prompts, context snapshots, artifacts, or Judge packets.
- `generated/`: local output from setup scripts; ignored by Git except for `.gitkeep`.

The current runtime does not implement these visibility boundaries yet. The manifests are test-first contracts for that future behavior.

