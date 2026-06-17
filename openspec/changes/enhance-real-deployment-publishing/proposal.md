# Enhance Real Deployment Publishing

## Why

`deploy_artifact` currently creates a local Agent-Conference preview and downloadable source/container packages. This is useful for inspection, but it does not publish the artifact to a user-controlled static hosting location. Users still need to move files manually.

## What Changes

- Add app settings for an external static publish target:
  - enabled flag
  - absolute publish directory
  - public base URL
- When configured, `deploy_artifact` materializes the web app locally and publishes public files to `<publishDir>/<deploymentId>/`.
- Return the external public URL as the primary `previewPath`, while keeping a local preview fallback and download package actions.
- Update deployment cards to show external publish status and local fallback.
- Add focused tests for publishing files, URL generation, and safe path handling.

## Non-Goals

- No hosted-provider API integration in this change.
- No token storage for Vercel/Cloudflare/Netlify.
- No background process that serves files; the user is responsible for pointing nginx/Caddy/Tailscale Serve/GitHub Pages sync/etc. at the configured directory.
