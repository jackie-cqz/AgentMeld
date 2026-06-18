# P4 - Artifacts, Web Preview, Deployment, and Versions

## Scope

This phase covers web artifacts and local/external static web publishing for the web MVP.

Excluded:

- Desktop app packaging.
- Mobile publishing.
- Native filesystem dialogs.
- Claude/Codex adapter-specific artifact behavior.

## Referenced Specs

- `openspec/specs/artifacts/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/tools/spec.md`
- `specs/04-artifacts.md`
- `specs/03-message-parts.md`
- `specs/07-tools.md`
- `openspec/changes/enhance-artifact-deployment/*`
- `openspec/changes/enhance-real-deployment-publishing/*`
- `openspec/changes/replace-diff-artifact-with-version-compare/*`
- `openspec/changes/enhance-ppt-design-dsl/*`

## Completion State

P4 implementation is complete for the web MVP:

- Nested `web_app` paths are preserved and validated through shared static-file helpers.
- Artifact previews serve nested assets through a catch-all Next route.
- `/deployments/:id/[[...path]]` serves local deployment output with traversal and private-path rejection.
- Source ZIP is not implemented and is no longer advertised in deployment records.
- Optional external static publishing uses the configured directory and public base URL.
- Version APIs return the full family from root through descendants, including current/latest ids.
- The artifact workspace supports version navigation and Document/Web App line comparison.
- PPT artifacts have a readable themed slide preview with pagination and semantic block rendering.
- Deployment status persistence is implemented by the stream consumer from P0/P2 work.

Deferred beyond this P4 web-MVP acceptance:

- Source/container ZIP export.
- Editable `.pptx` or visual-priority PPT export.
- Deterministic `code_file` content comparison, because DB versions only retain live workspace metadata.

## Target Behavior

After this phase:

- Web app artifacts with nested files preview correctly.
- Deployment preview/download URLs actually resolve.
- Optional external static publishing uses settings safely.
- Artifact versions can be compared and navigated.
- Deployment status is visible in chat and artifact workspace.

## Code Update Plan

### 1. Preserve nested web_app files safely

Files:

- `src/server/artifact-service.ts`
- `src/server/deployment-service.ts`
- `src/app/api/artifacts/[id]/preview/route.ts`

Problem:

- Current code uses `path.basename(fileName)`, flattening files like `assets/app.js` into `app.js`.

Update:

- Implement safe relative path normalization:

```ts
function normalizeArtifactFilePath(fileName: string): string | null
```

Rules:

- Reject absolute paths.
- Reject empty paths.
- Reject `..` segments.
- Normalize separators to `/`.
- Allow nested directories.
- Only write files within target preview/deploy directory.

Use existing platform/security helpers where possible.

Tests:

- `assets/app.js` is preserved.
- `../evil.js` is rejected.
- `/absolute.js` is rejected.
- Windows backslash path is normalized safely.

### 2. Add deployment serving routes

Create routes:

- `src/app/deployments/[id]/[[...path]]/route.ts` or equivalent supported by Next 16 local docs.
- `src/app/api/deployments/[id]/download/source/route.ts`

Before coding, read relevant Next 16 route handler docs under `node_modules/next/dist/docs/`.

Behavior:

- Serve `index.html` for root.
- Serve nested static assets.
- Set safe content type.
- Reject path traversal.
- Return 404 for missing deployment.
- Download source as a zip only if a zip implementation is added; otherwise return a clear not-implemented response and adjust `sourceDownloadPath`.

### 3. Use deployment publish settings

Files:

- `src/server/deployment-service.ts`
- `src/server/settings-service.ts`
- `src/components/settings-dialog.tsx`

Behavior:

- If `deploymentPublishEnabled` is false:
  - deploy into local data dir only.
  - return local preview path.
- If true:
  - validate `deploymentPublishDir`.
  - copy deployment output to configured dir under a generated deployment id.
  - return `publishedUrl` built from `deploymentPublicBaseUrl`.

Safety:

- Reject publish dir inside forbidden system paths.
- Reject publish dir if unavailable.
- Do not delete unrelated files.
- Only write within a deployment-specific subfolder.

Tests:

- local deployment only.
- publish enabled with valid dir.
- invalid publish dir fails with visible deployment status.
- public base URL trailing slash normalization.

### 4. Improve artifact version graph

Files:

- `src/server/artifact-service.ts`
- `src/app/api/artifacts/[id]/versions/route.ts`
- `src/components/artifact-panel.tsx`

Current:

- `getVersionChain(artifactId)` walks current -> parent -> root.

Needed:

- Return a full version family:
  - root
  - all descendants ordered by version/createdAt
  - current id
  - latest id

Add service:

```ts
getArtifactVersionFamily(artifactId)
```

UI:

- Show timeline from root to latest.
- Allow selecting any version.
- Mark current/latest.
- Add compare action if version compare is implemented.

### 5. Add version compare for text-like artifacts

Files:

- `src/components/artifact-panel.tsx`
- optional `src/components/artifact-version-diff.tsx`

Support:

- document content
- code_file content if available
- web_app individual files

Behavior:

- Pick two versions.
- Show changed file list for web_app.
- Show line diff for selected file/text.

### 6. PPT artifact MVP renderer

If PPT remains in scope for web MVP, implement a lightweight renderer.

Files:

- `src/components/artifact-panel.tsx`
- optional `src/components/ppt-preview.tsx`

MVP:

- Render slides as cards.
- Support title, text blocks, bullets, simple shapes, and images if already represented in DSL.
- Keep export as deferred unless the required library already exists or specs require immediate support.

Tests:

- Normalization tests already exist or should be added in artifact service layer.
- UI smoke test can be component-level if test setup supports it.

## Acceptance Checklist

- [x] Nested web_app files preview correctly.
- [x] Deployment preview URLs resolve through Next route handlers.
- [x] Deployment source download path is either implemented or not advertised.
- [x] Publish settings are honored safely.
- [x] Deployment failures produce visible `deploy_status`.
- [x] Version family navigation works from any version.
- [x] Document/web_app version compare is available.
- [x] PPT artifacts have at least a readable web preview if kept in MVP scope.
- [x] P4 files pass ESLint and P4 tests pass.
- [x] Full Vitest suite passes: 34 files / 351 tests.
- [ ] Repository-wide `typecheck` and `lint` are blocked by pre-existing P2/P3 errors outside P4; see the validation note below.

## Validation Note

Validated on 2026-06-18:

- P4 targeted tests: 5 files / 38 tests passed.
- Full tests: 34 files / 351 tests passed.
- P4 modified files: ESLint passed.
- Local app: `http://localhost:3002` returned HTTP 200.
- Repository-wide typecheck still reports existing errors in orchestrator, stream usage/tests, and bootstrap normalization.
- Repository-wide lint still reports the existing `prefer-const` error in `src/server/orchestrator-service.ts` plus unrelated warnings.
