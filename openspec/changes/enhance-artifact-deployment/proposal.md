# Change: Enhance Artifact Deployment

## Why

`deploy_artifact` currently returns the live artifact preview route. That is enough for quick viewing, but it is not a real deployment artifact: it has no stable deployment id, no materialized files, and no downloadable source/container package for handoff.

## What Changes

- Materialize each deployed `web_app` artifact under Agent-Conference data storage as a local static deployment.
- Serve deployments through stable `/deployments/{depId}` paths.
- Extend deployment status records with local deployment metadata and source/container download paths.
- Add source ZIP and container ZIP downloads for deployed web apps.
- Enrich the chat deployment card so users can open/copy the deployment URL and download packages.

## Out Of Scope

- External hosting providers such as Vercel, Netlify, Docker registries, or cloud object storage.
- Persistent deployment database rows. Deployment metadata is file-backed for this change.
- Authenticated public sharing outside the local Agent-Conference process.
