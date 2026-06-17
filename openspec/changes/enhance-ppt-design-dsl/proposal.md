## Why

The current PPT artifact is a narrow `slides` JSON model that can produce orderly decks, but it cannot express richer business presentation layouts such as metric cards, timelines, split layouts, quotes, diagrams, or image-led pages. Users need better-looking PPT output while still keeping a real `.pptx` export path instead of only HTML previews.

## What Changes

- Expand PPT artifact content from simple `title/bullets/layout` slides into a richer presentation DSL with typed slide blocks.
- Keep the existing simple slide shape compatible by normalizing legacy slides into the richer model.
- Add editable PPTX export for semantic blocks via `pptxgenjs`, so generated decks remain usable in PowerPoint.
- Add a visual-priority export mode for high-design pages that renders HTML/CSS slide markup into image-backed PPTX slides when editability is less important than fidelity.
- Update PPT preview/edit UX to render the richer DSL and make the tradeoff between editable export and visual-priority export explicit.
- Keep raw PDF/HTML/image bytes out of artifact JSON unless represented by bounded URLs or workspace-backed assets.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `artifacts`: PPT artifacts SHALL support richer structured presentation content, preserve editable `.pptx` export for semantic blocks, and support visual-priority PPTX export for custom HTML slide designs.

## Impact

- `src/shared/types.ts`: extend PPT artifact content and slide/block types while preserving legacy compatibility.
- `src/server/artifact-content.ts`: normalize legacy and enhanced PPT input into a canonical content model.
- `src/components/artifact-preview-panel.tsx`: render enhanced PPT slides, expose JSON editing, and surface export mode affordances.
- `src/server/ppt-export.ts` and `src/app/api/artifacts/[id]/export/route.ts`: support richer editable PPTX generation and a visual-priority export path.
- `specs/04-artifacts.md` and `openspec/specs/artifacts/spec.md`: document the enhanced PPT contract and export behavior.
- Dependencies may be needed for HTML-to-image rendering if the visual-priority path is implemented server-side.
