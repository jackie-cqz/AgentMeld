## Context

PPT artifacts currently store a small JSON shape: deck title, optional theme, and slides with `title`, `bullets`, `notes`, and a coarse layout. Preview and export both consume this structure: the preview renders React markup in `ArtifactPreviewPanel`, and export uses `pptxgenjs` in `src/server/ppt-export.ts` to create a true `.pptx`.

This gives reliable output but limits visual expressiveness. Highly designed decks need more than bullet lists: metric cards, split layouts, timelines, quotes, diagrams, and occasionally full custom visual pages. HTML/CSS can express those pages well, but direct HTML cannot be downloaded as an editable PowerPoint file.

## Goals / Non-Goals

**Goals:**

- Preserve the existing real `.pptx` export path.
- Extend PPT content with a richer semantic design DSL that remains JSON, validated, versionable, and editable.
- Keep legacy simple slides valid and normalize them into the richer model.
- Provide two export intents:
  - editable: semantic blocks rendered as PowerPoint text/shapes through `pptxgenjs`
  - visual: HTML/CSS slide markup rendered into image-backed PPTX slides for high visual fidelity
- Make the editability vs visual-fidelity tradeoff explicit in the UI and export API.

**Non-Goals:**

- Pixel-perfect PowerPoint import from arbitrary HTML.
- Full PowerPoint feature parity such as animations, transitions, masters, SmartArt, or embedded editable charts.
- OCR/image generation for slide assets.
- Storing large binary assets directly in the artifact JSON.

## Decisions

### 1. Keep PPT artifacts structured instead of replacing them with HTML

The canonical PPT content remains a typed artifact payload, not a raw HTML document. HTML is allowed only as an optional visual slide representation for image-backed export.

Alternatives considered:

- Raw HTML-only deck: visually flexible, but loses editable `.pptx` semantics and makes version diffing less useful.
- Direct `.pptx` binary artifact: preserves final output, but is hard to preview, diff, edit, and regenerate.

### 2. Introduce semantic slide blocks

Add optional block-based slides on top of the legacy slide shape. A slide can contain blocks such as:

- `heading`
- `paragraph`
- `bullets`
- `metric`
- `quote`
- `timeline`
- `columns`
- `callout`
- `divider`
- `spacer`

Each block maps to deterministic preview markup and deterministic `pptxgenjs` drawing code. Existing `title/bullets/layout` slides normalize into blocks so old data remains readable.

### 3. Use layout presets before freeform coordinates

Slides SHOULD use named layouts like `title`, `section`, `content`, `two-column`, `metrics`, `timeline`, and `quote`. The renderer decides spacing and typography from the layout and theme.

Freeform coordinates are intentionally excluded from the first pass. They are powerful but make LLM output brittle and increase overlap bugs. If needed later, coordinates can be added as an advanced block option.

### 4. Keep the theme token model and expand it conservatively

The existing theme token pattern is kept: colors and fonts are named tokens with defaults. The richer DSL uses those tokens for blocks and layout presets. This avoids one-off styling fields on every block while letting the deck have a coherent identity.

Potential future tokens include `accent`, `warning`, `success`, `shadow`, and `radius`, but the first implementation can reuse current tokens where possible.

### 5. Add export modes instead of one universal converter

Editable export renders semantic blocks through `pptxgenjs`; text and shapes remain editable in PowerPoint.

Visual-priority export renders slide HTML/CSS to a bitmap and inserts the bitmap into each `.pptx` slide. This provides high fidelity for custom pages but makes page contents non-editable.

The API should make this explicit, for example:

- `/api/artifacts/:id/export?mode=editable`
- `/api/artifacts/:id/export?mode=visual`

Default remains editable for compatibility.

### 6. Defer the screenshot engine decision until implementation

The visual export path needs a renderer. Options:

- Playwright/Chromium server-side: best fidelity, heavier runtime and packaging burden.
- Browser-side capture: lighter server, but more complicated UX and inconsistent download flow.
- SVG-to-image pipeline: lighter than Chromium but less compatible with arbitrary HTML/CSS.

The first implementation should wire the content model and editable export first. If visual export is implemented in the same change, use a server-side renderer only after confirming packaging implications for Electron/standalone.

Implementation spike result: defer the screenshot renderer for the first pass. The repo currently has Playwright only as an e2e devDependency, not as a production export dependency, and adding Chromium-backed rendering would require Electron/standalone packaging work for browser binaries and traced runtime assets. The route still accepts `mode=visual` so the API shape is explicit, but it returns a clear unavailable error until a renderer module is deliberately added.

## Risks / Trade-offs

- Richer DSL increases prompt/schema complexity → keep block types finite and provide examples in tool guidance.
- Editable PPTX output will not match HTML preview pixel-for-pixel → preview should use the same layout tokens and block rules, but exact Office rendering differences are acceptable.
- Visual export produces non-editable slides → label it as visual-priority/image-backed export.
- Arbitrary HTML can create unsafe or broken output → render visual slides with the same sandbox/CSP posture as web app previews, and do not allow access to local files outside workspace-backed assets.
- Screenshot rendering may complicate Electron packaging → make visual export an isolated module and keep editable export functional without it.

## Migration Plan

1. Extend TypeScript types to accept both legacy simple slides and enhanced block slides.
2. Normalize legacy slides at render/export boundaries.
3. Update preview and editable export to support the enhanced blocks.
4. Add export mode selection and keep default editable behavior unchanged.
5. Add visual export only after renderer packaging is validated.
6. Update detailed specs and tests for legacy compatibility, block rendering, and export output.

Rollback is straightforward if the DB content remains backward compatible: keep legacy slide support, and disable visual export mode if the renderer causes packaging issues.

## Open Questions

- Should visual export be included in the first implementation, or gated behind an experimental setting after an Electron packaging spike?
- Which first block set is enough for useful decks: metrics, columns, timeline, quote, and callout, or should diagram blocks be included immediately?
- Should deck templates be built into the app, user-defined, or both?
