## Context

The current agent creation flow opens the full `CreateAgentDialog` immediately. That works for power users, but it requires every user to understand provider/model choices, tool permissions, and system prompt writing before they can create a useful agent.

The existing persistence path is already correct: `POST /api/agents` validates the body and calls `createCustomAgent`, while edit mode reuses the same dialog with existing values. The new flow should improve creation ergonomics without introducing a second persistence path or changing the agent schema.

The user-facing entry point must remain unified: the existing "Create Agent" button opens a first-step choice between conversational creation and detailed configuration. Editing an existing agent should bypass that choice and keep opening the detailed editor directly.

## Goals / Non-Goals

**Goals:**

- Put conversational creation and detailed configuration behind the same "Create Agent" entry point.
- Add a first-step creation mode choice for new agents only.
- Let users describe the desired agent in plain language and receive a reviewed configuration draft.
- Show the generated name, description, capabilities, model/provider, system prompt, and tool permissions before saving.
- Allow users to jump from the draft into the detailed form with the draft prefilled.
- Reuse the existing agent creation API/service for final persistence.
- Keep tool selection deterministic and visible so users understand granted permissions.

**Non-Goals:**

- Creating orchestrator agents.
- Adding new database tables or changing the `agents` schema.
- Replacing the detailed configuration form.
- Storing the wizard transcript as conversation history.
- Adding a new LLM SDK or provider dependency.
- Supporting import/export of agent templates.

## Decisions

### First-step choice lives inside the existing create dialog

The `AgentLibrary` create button will continue to control one dialog. When `agent` is absent, the dialog starts in a `choose` step with two options: conversational creation and detailed configuration. When `agent` is present, the dialog starts directly in the existing detailed editor.

Alternative considered: add a second "AI Create Agent" button. That was rejected because it fragments the entry point and makes the user decide where to start before seeing the options.

### Wizard output is an `AgentConfigDraft`, not an agent row

The conversational path generates a draft object that matches the existing create body shape closely enough to prefill the detailed form and save through `createAgent`. The draft can include UI-only metadata such as rationale and permission summaries, but it does not write to the database.

Alternative considered: have the draft endpoint call `createCustomAgent` directly. That was rejected because users must review permissions and prompts before save, and because the existing create endpoint already centralizes persistence validation.

### Draft generation has deterministic post-processing

The draft endpoint accepts the user's plain-language intent plus optional follow-up answers. It can use an LLM to propose wording, but server-side code must normalize the result through zod validation and deterministic rules:

- default adapter is `custom`;
- default provider/model follow the existing detailed form defaults;
- tool names must be selected from the existing available tool list or presets;
- SDK adapters save empty `toolNames`;
- custom agents require provider and model;
- orchestrator-only tools are excluded.

If draft generation cannot confidently fill required fields, the wizard asks a focused follow-up or uses conservative defaults and marks the assumption in the review UI.

Alternative considered: let the model freely emit the whole create body. That was rejected because tool permissions and adapter constraints are product rules, not text generation preferences.

### The wizard is transient UI state

The wizard state lives in the dialog component tree. It does not create a real conversation, message, or transcript. Closing the dialog discards the wizard unless the draft was already applied to the detailed form and saved by the user.

Alternative considered: model the wizard as a hidden conversation. That was rejected because it would add persistence and cleanup complexity without improving the creation workflow.

### Confirmation can either save or continue in detailed mode

After a draft is generated, the user can save it immediately through the existing `createAgent` call or choose "edit details" to open the detailed form prefilled with the draft. This keeps the fast path short while preserving full control for advanced users.

Alternative considered: always force the detailed form after draft generation. That was rejected because it weakens the value of conversational creation for simple agents.

## Risks / Trade-offs

- Draft quality can vary if LLM generation is used → deterministic post-processing, conservative defaults, and visible assumptions keep the saved configuration reviewable.
- Tool permissions may be over-granted → tool selection should start from narrow presets when intent is specific, show every granted permission, and allow detailed editing before save.
- The dialog can become too complex → keep the first step, wizard, confirmation, and detailed editor as explicit states with small subcomponents.
- Existing dirty changes in `create-agent-dialog.tsx` can create merge risk → inspect the latest file before implementation and avoid unrelated refactors.
- LLM-backed draft generation can fail due to missing keys → provide a local fallback draft and an editable review state instead of blocking agent creation.

## Migration Plan

No database migration is required. Rollout is a UI/API addition:

1. Add draft request/response types and server-side draft generation.
2. Add the draft API route.
3. Refactor the create dialog into explicit create states while keeping edit behavior unchanged.
4. Add the conversational wizard UI and confirmation state.
5. Update specs and targeted tests.

Rollback is straightforward: remove the wizard entry state and draft endpoint; the existing detailed form and `/api/agents` persistence path remain intact.
