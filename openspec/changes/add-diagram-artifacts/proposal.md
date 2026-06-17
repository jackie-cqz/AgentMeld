## Why

Agents often need to explain flows, architectures, and relationships visually. Today they can only return prose, markdown, PPT, or full web apps. A lightweight diagram artifact lets agents create editable visual explanations without the overhead of a custom web app.

## What Changes

- Add a `diagram` artifact type backed by Mermaid source text.
- Allow `write_artifact` to create diagram artifacts.
- Render diagram artifacts in the artifact preview panel with source editing.
- Export diagram artifacts as `.mmd` source in the first version.

## Capabilities

### Modified Capabilities

- `artifacts`: artifacts SHALL include a typed diagram content model renderable from Mermaid source.
- `tools`: `write_artifact` SHALL accept diagram artifacts for agent-generated visual explanations.

## Impact

- `src/shared/types.ts`: add diagram artifact content.
- `src/server/artifact-content.ts`: normalize diagram content.
- `src/server/tools/write-artifact.ts`: accept `type: "diagram"` and document the content shape.
- `src/components/artifact-preview-panel.tsx`: render Mermaid diagrams and expose source editing.
- `src/app/api/artifacts/[id]/export/route.ts`: export diagram source.
- `package.json` / `pnpm-lock.yaml`: add `mermaid`.
