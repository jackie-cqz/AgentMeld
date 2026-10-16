# Group Chat Collaboration Implementation

Tracking issue: https://github.com/jackie-cqz/AgentMeld/issues/76

## Scope And Gates

This change implements the complete issue on the Pi-only runtime. It must not
replace Pi's agent loop, bypass approvals, weaken delegation checks, or permit
concurrent writers. Completion requires the implementation, regression tests,
real Pi integration verification, UI inspection, review, and a merged PR.

## Work Ledger

| Area | Status | Required Evidence |
| --- | --- | --- |
| Recipient precedence and reply membership | Implemented; final audit pending | Shared resolver, ingress and composer integration, rejection tests |
| Conductor bounded history and active facts | Implemented; final audit pending | Captured invocation and context budget tests |
| In-flight follow-up, correction, cancellation and idempotency | Native control receipts implemented; persistent ingress and re-attempt flow pending | Persisted state machine, Pi contract tests, no duplicate writer tests |
| Bounded peer consultation | Core implemented; policy and final audit pending | Authorization, limits, lifecycle, no echo loops, real Pi lease test |
| Adaptive plans and explicit dependency contracts | Dependency compilation and prompts updated; admission policy pending | Discussion without writes, simple task promotion, DAG regression tests |
| Handoff integration | Pending | Stable task identity, new attempt/context, confirmed old-run teardown |
| UI and channel state projections | Consultation SSE/bootstrap implemented; channel mapping pending | Reload recovery, recipient and status inspection, shared semantic IDs |
| Verification and review | Pending | Full checks, real Pi consultation smoke, independent review findings addressed |
| PR and merge | Pending | Required checks and verified merged PR |

## Architecture Decisions

- Explicit recipients take precedence over a valid replied-to Agent, which takes
  precedence over the conversation default. Invalid explicit recipients fail
  before persistence. Non-human ingress never acquires execution authority.
- Historical conversation is reference material. Current task contracts and
  active facts take precedence. Histories are bounded, and mandatory context
  overflow is an error rather than silent loss of constraints.
- Discussion/consultation must not need an exclusive mutable workspace. Any
  access to files during concurrent execution needs stable, versioned inputs;
  do not simply exempt native filesystem tools from lease ownership.
- New communications are recorded independently of Pi's native session. Record
  recovery is not a promise of lossless process/session recovery.

## Remaining Acceptance Audit

The issue checklist remains authoritative. Do not close #76 or merge a PR on
the strength of only the first two continuity fixes. Live Feishu validation, if
unavailable, must be reported separately from deterministic projection tests.

## Verification Log

- Initial continuity/access/consultation/store selection: 133 tests passed.
- Real pinned Pi subprocess source-to-peer consultation: passed with a
  deterministic local model endpoint. The source retained its writer lease
  while a second Pi process received only respond_to_consultation, replied,
  completed teardown, and allowed the source to continue. No public model API
  or production credentials were used. This proves runtime integration, not
  live model instruction-following quality.
- TypeScript and focused ESLint passed after regeneration of Next route types.
- Full suite, final UI verification, in-flight controls, adaptive policy,
  handoff integration, and PR review remain outstanding.
- First full-suite run: 1,838 passed, 16 failed, 3 skipped. It caught the new
  schema mirror omission (fixed), legacy lifecycle tests invoking real models
  (now use the existing fixture runtime), Windows-specific path assertions
  (fixed), and seven symlink tests lacking OS privilege. These fixes have
  focused passing regressions; a fresh full-suite run is still required.
- Full ESLint: zero errors, 45 existing warnings. TypeScript passed.
- Bootstrap now records one-time preset migrations, so revoking consult_agent
  in the editor remains revoked after restart. Customized grants are retained.
- Consultation questions and replies use ordinary Agent-authored platform
  messages with parent references; Feishu topic lookup follows a bounded,
  same-conversation reply chain. Deterministic projection tests pass; no live
  Feishu account verification has been performed.

## Next Critical Work

1. Add persistent human-turn admission/intent decisions and follow-up records.
   Enforce discussion tool restrictions in code, not only in role prompts.
2. Wire the pinned Pi steer/follow_up RPC contract with actual consumption
   receipts. Distinguish queued/accepted from applied; handle settling races.
3. For changes to execution contracts, stop the old writer, retire obsolete
   snapshots/evidence appropriately, and compile a fresh authorized attempt.
4. Integrate formal handoff with stable task identity and fresh attempts, then
   verify UI, reload, channel projection and the complete acceptance checklist.

## Native Follow-Up Contract Checkpoint

- Pi 0.84.2's installed RPC source and real subprocess tests confirm both steer
  and follow_up enqueue successfully before consumption. The control registry
  keeps those requests queued until an exact matching user message_end arrives.
- Tests confirm that the next deterministic model request actually includes
  the supplemental input. Both RPC variants pass with real Pi processes.
- Only ordinary conversation-only invocations admit live controls. Workspace
  execution, delegated contracts and bounded peer consultations reject steering
  and must go through the upcoming re-attempt/admission path.
- The registry bounds and deduplicates input, rejects arbitrary RPC names, and
  settles unused inputs on exit. Receipt callback failure cannot skip child,
  bridge or workspace teardown.
- This is an internal runtime capability, not yet a completed user-facing
  follow-up feature. Persistent follow-up records, authenticated ingress,
  semantic intent selection and UI delivery state remain to be implemented.
