# Design: Artifact Version Compare

## Flow

```text
artifact preview opens
  -> fetch full artifact version chain
  -> user toggles compare
  -> pick base version and target version
  -> derive comparable text sections from stored content
  -> render deterministic read-only diffs
```

## Decisions

- `write_artifact` no longer accepts `diff` as an agent-facing type. This removes the main prompt affordance that caused agents to produce patch artifacts.
- `ArtifactType` and `buildArtifactContent('diff', ...)` stay in place for old rows and internal compatibility.
- Legacy `diff` artifacts remain previewable, but they are labeled as read-only historical artifacts and cannot be applied.
- Version compare is client-side because `/api/artifacts/{id}/versions` already returns the complete version rows needed by the preview panel.
- Supported deterministic compare output is section-based:
  - `document`: markdown content.
  - `web_app`: one section per file in the union of both versions.
  - `ppt`: pretty-printed structured JSON.
  - `code_file`: metadata only, because DB versions do not snapshot file contents.
- `image` and incompatible type pairs show an explicit unsupported state.

## Validation

- Typecheck must verify the reduced `write_artifact` type schema and preview component state.
- Focused unit coverage should exercise the pure artifact version diff builder.
- Manual UI validation should confirm version history still switches versions and compare mode renders only when multiple versions exist.
