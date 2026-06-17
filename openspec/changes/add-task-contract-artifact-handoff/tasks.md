- [x] 1. Add OpenSpec delta specs for Orchestrator task contracts and `write_artifact.outputKey`.
- [x] 2. Update numbered Orchestrator and tools specs with the same contract.
- [x] 3. Extend shared dispatch plan types and `plan_tasks` schema.
- [x] 4. Implement plan compilation and validation for `inputs` and `expectedOutputs`.
- [x] 5. Add `outputKey` support to `write_artifact` and collect output-key artifact mappings.
- [x] 6. Inject handoff contract blocks into child prompts and enforce required inputs/outputs.
- [x] 7. Update the dispatch plan card to display inputs, outputs, and acceptance criteria.
- [ ] 8. Add focused regression tests and run validation.

Validation note: focused `dispatch-plan` tests, `pnpm typecheck`, `pnpm lint`, and full `pnpm test` pass. `pnpm build` is blocked before Next compile by the local Electron `better-sqlite3` ABI rebuild path: native binary is busy/locked and no Visual Studio C++ toolchain is available for node-gyp fallback.
