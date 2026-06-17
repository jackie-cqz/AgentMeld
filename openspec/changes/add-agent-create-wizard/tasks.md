## 1. Draft Contract And Rules

- [x] 1.1 Add shared draft request/response types for conversational agent creation.
- [x] 1.2 Add deterministic tool preset mapping and permission-summary helpers for generated drafts.
- [x] 1.3 Add zod validation for draft inputs and generated draft outputs at the server boundary.

## 2. Server Draft Generation

- [x] 2.1 Implement an agent draft service that converts user intent into a normalized `AgentConfigDraft`.
- [x] 2.2 Add conservative fallback draft generation when model-backed drafting is unavailable or invalid.
- [x] 2.3 Add `/api/agents/draft` route that returns a reviewed draft and never persists an agent.
- [x] 2.4 Add focused tests for draft normalization, tool mapping, and API validation.

## 3. Create Dialog Flow

- [x] 3.1 Refactor `CreateAgentDialog` into explicit create states: mode choice, conversational wizard, and detailed form.
- [x] 3.2 Ensure edit mode skips the mode choice and keeps the existing detailed edit behavior.
- [x] 3.3 Allow the detailed form to initialize from an `AgentConfigDraft`.
- [x] 3.4 Keep final save behavior routed through the existing create/update agent API helpers.

## 4. Conversational Wizard UI

- [x] 4.1 Add a wizard UI for entering desired agent intent and optional follow-up details.
- [x] 4.2 Add a draft review screen showing identity, behavior summary, provider/model, vision support, tool permissions, and assumptions.
- [x] 4.3 Add review actions for saving the draft, editing details, going back to the first step, and cancelling.
- [x] 4.4 Keep the existing "Create Agent" button as the single entry point for both creation modes.

## 5. Documentation And Verification

- [x] 5.1 Update `specs/10-agent-builder.md` with the new creation-mode choice and conversational draft flow.
- [x] 5.2 Run OpenSpec validation for `add-agent-create-wizard`.
- [x] 5.3 Run targeted unit tests, typecheck, and lint without running `pnpm build`.
