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
| In-flight follow-up, correction, cancellation and idempotency | Persistent admission, authenticated resolution, native consumption and safe replacement implemented; final audit pending | Persisted state machine, Pi contract tests, no duplicate writer tests |
| Bounded peer consultation | Core implemented; policy and final audit pending | Authorization, limits, lifecycle, no echo loops, real Pi lease test |
| Adaptive plans and explicit dependency contracts | Discussion intent changes instructions, not the Agent tool surface; contract audit pending | Full-tool discussion without unwanted implementation, simple task promotion, DAG regression tests |
| Handoff integration | Pi task-boundary and failed-task takeover implemented; final integration audit pending | Stable task identity, new attempt/context, confirmed old-run teardown |
| UI and channel state projections | Browser smoke passed; deterministic Feishu projection passed; live Feishu unverified | Reload recovery, recipient and status inspection, shared semantic IDs |
| Verification and review | Production webpack build and native Pi checks passed; final review/full CI audit pending | Full checks, real Pi consultation smoke, review findings addressed |
| PR and merge | Pending | Required checks and verified merged PR |

## Architecture Decisions

- Explicit recipients take precedence over a valid replied-to Agent, which takes
  precedence over the conversation default. Invalid explicit recipients fail
  before persistence. Non-human ingress never acquires execution authority.
- Historical conversation is reference material. Current task contracts and
  active facts take precedence. Histories are bounded, and mandatory context
  overflow is an error rather than silent loss of constraints.
- All Agents receive the full workspace tool surface, including during discussion
  and consultation. Historical tool selections do not authorize or limit runs.
  Discussion intent is an instruction, not a security guarantee that writes are
  impossible. Existing command/file/plan approvals remain separate controls.
- Full-tool calls acquire the workspace lease. A source synchronously awaiting
  consultation pauses its bridge and temporarily lends that lease to the peer.
  It resumes only after the peer confirms native teardown. Nested borrowing,
  outstanding source tools, stale receipts and uncertain cleanup fail closed.
- New communications are recorded independently of Pi's native session. Record
  recovery is not a promise of lossless process/session recovery.

## Remaining Acceptance Audit

The issue checklist remains authoritative. Do not close #76 or merge a PR on
the strength of only the first two continuity fixes. Live Feishu validation, if
unavailable, must be reported separately from deterministic projection tests.

## Historical Verification Log (Before Full-Access Integration)

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

1. Complete the requirement-by-requirement security and lifecycle audit, including
   handoff races, stale inputs, restart behavior and native integration.
2. Verify rendered UI, reload, network-loss retry and channel projection.
3. Run fresh full checks and production build, review the entire change, address
   findings, then open the PR and require passing CI before merge.

## Native Follow-Up Contract Checkpoint (Historical)

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
- This checkpoint has now been connected to persistent human-turn admission,
  authenticated resolution and UI delivery states; final acceptance remains open.

## Human Turn And Handoff Checkpoint

- Every authenticated human send has an idempotent submission identity. Lost HTTP
  responses can be retried without re-execution; SSE correlation preserves user
  message order and avoids a duplicate optimistic bubble after acceptance.
- A bounded, tool-free Pi classification chooses discussion, execution, progress,
  supplement, correction, cancellation or clarification. Explicit human controls
  bypass classification. Discussion changes the workflow instructions, not tool availability.
- Input delivery is separate from task outcome: queued input becomes applied only
  on native consumption, and a later task failure does not rewrite that receipt.
- Mutable corrections await actual owner promises and native teardown receipts,
  retire old binding/evidence eligibility, then rebuild current context. Context
  snapshots append an immutable predecessor chain; public events omit packet bodies.
- Formal handoffs preserve the executed task snapshot, not a pre-approval draft.
  A human-accepted assignment creates a new attempt/run/context under the same
  logical task ID. In-flight DAG handoffs keep the coordinator; terminal-plan
  takeover creates an explicitly authorized new coordinator for that task only.
  It does not claim to restart every downstream task of the old failed DAG.
- Packages bind source attempt, task contract, prior failure/evidence references,
  active-fact fingerprint, upstream artifact versions and bounded file hashes.
  Stale references, an uncertain old process, or oral success without a verified
  report fail closed. No credentials or internal reasoning are transferred.
- Five initial handoff regressions plus a real runner/approval/DAG/owner-promise
  handoff fixture pass. These use a deterministic runtime substitute and do not
  replace the required pinned-Pi subprocess and browser acceptance checks.
- Current admission regression suite: 14 passing tests, including correction to
  discussion, executable supplements, immutable snapshot chains and authenticated
  idempotent clarification resolution. Store regressions: 45 passing tests.
- Latest full run (before the last fixture adjustment): 1,881 passed, 8 failed,
  3 skipped. Seven failures were Windows EPERM when creating security-test
  symlinks. The other was an old provider-only fixture feeding application prose
  to the new classifier; it now specifies explicit execution and its 9-test suite
  passes. A fresh full run and Linux CI remain required; security tests are intact.

## Runtime And Browser Verification

- Real pinned Pi handoff passed with a deterministic local model endpoint. The
  test starts a native source invocation, accepts a handoff during that call,
  confirms the original execution's native exit receipt precedes the receiver's
  start, verifies a new attempt/context with the same task ID, and checks lease
  release. No public model endpoint or production credentials were used.
- Full Pi/dispatch-concurrency selection: 89 passed, 1 skipped. A Windows native
  verification test exposed missing ProgramFiles variables in the isolated Pi
  environment: shell discovery could fall back to the legacy WSL launcher. Only
  non-secret Windows installation paths were added; host secrets and host profile
  data remain excluded, with config regressions.
- An isolated source copy and database were used for a production webpack build
  and Playwright browser smoke. The actual service at port 3018 and its database
  were not reset or used as fixtures. The temporary preview at port 3029 was stopped
  after verification. Build passed with the existing Pi dynamic-import warning.
- Desktop (1440px), mobile (390px), expanded details and open workspace sidebar
  screenshots were inspected. No browser runtime errors or document horizontal
  overflow were observed. Narrow progress headers now wrap deliberately.
- Actual browser actions confirmed discussion, then accepted a task takeover using
  a local deterministic model endpoint. The discussion invocation had no write,
  shell or planning tools. The receiver called the real report tool; the verified
  handoff and new attempt remained visible after page reload.
- That smoke caught a missing bootstrap projection: progress previously existed
  only in SSE memory, hiding persisted handoff cards after reload. Bootstrap now
  reconstructs the display from durable plan/attempt/result records, never by
  re-running a task. Public projections expose counts and IDs, not compiled prompts.
- Review also closed a cross-coordinator replay path: after a receiving attempt
  exists, the obsolete source attempt cannot create another independent takeover.
  A restart marks accepted in-flight handoffs interrupted, and replay does not
  automatically launch them again. Control-route authentication/spoofing tests pass.
- Handoff write provenance is retained across attempts for wave conflict checks.
  The latest real writer wins within a task; another task touching a source-only
  file is still detected. Old calls' temporary report/evidence maps are cleared,
  while durable historical records remain inspectable.
- Discussion actions now also suppress the human /deploy text shortcut: a literal
  command string cannot bypass an explicitly selected read-only discussion action.
- Latest complete regression run: 1,894 passed, 7 failed, 3 skipped (1,904 total).
  All seven failures are EPERM while creating Windows symlinks, before the security
  assertions execute; running outside the restricted token did not grant that OS
  privilege. Those tests remain unchanged and must pass in the Linux CI job.
  The native Pi cancellation/shell-discovery regression now passes in the full run.
- The final review subsequently added latest-plan ordering and strictly monotonic
  handoff versions. A larger retry number from an obsolete plan cannot supersede
  a new plan's first attempt; the bootstrap projection uses the same ordering.
  Handoff/context/control/store selection after those fixes: 57 passed. Final
  TypeScript passes. The full suite must be rerun on the final PR revision.
- Default Turbopack build also completed in the isolated copy. Its shared dependency
  junction required a verification-only filesystem-root override in that copy and
  unsandboxed ancestor metadata access. This produced two broad-file-tracing
  warnings; the repository's next.config.ts was not changed. CI must still run the
  unmodified shipped configuration in a normal checkout.
- TypeScript passes; focused ESLint over all newly added collaboration modules,
  projections, controls and changed Pi tests reports no errors or warnings.
- Deterministic Feishu projections carry the same handoffId, preserve source bot
  identity, deduplicate notices and add no execution-authorizing mentions. Live
  Feishu validation is still not performed and must not be represented as passed.

## Final Gates Still Open

1. Finish the issue checklist audit, including a scoped single-task implementation
   versus the existing delivery contracts, late-result/teardown cases and budget
   boundaries. Do not assume that a successful discussion proves delivery behavior.
2. Run the final revision's full suite and production build in a normal checkout.
   Local full run has 1,894 passing tests and seven Windows symlink EPERM failures;
   isolated webpack and Turbopack builds pass with the caveats above. Required Linux CI
   must exercise the symlink security tests without weakening or skipping them.
3. Finish the complete diff review, commit final fixes, open/attach the PR, inspect
   all required checks and review feedback, and merge only after those gates pass.

## Full-Access Integration Update

The latest human direction supersedes the earlier closed discussion profile.
Ordinary discussion and peer invocations retain all workspace tools regardless
of the Agent's stored toolNames. The readonly Agent-editor runtime-tool display
from current master is preserved; no tool picker is restored. Internal classifier
and Conductor protocol phases still have purpose-specific manifests, not per-Agent
capability grants. Every current member may query the same-conversation roster;
this does not disclose credentials or members outside that conversation.
Consultation replies remain bound to their admitted peer run.

All full-tool discussions are potential writers. Supplements that cannot be
consumed safely stop the previous invocation, await actual teardown and compile
the previous goal plus the latest human update into a fresh invocation. They
must not silently lose the previous goal on a rejected steering receipt.

Synchronous peer calls use a private lease loan instead of bypassing writer
ownership or waiting on their blocked source. The source bridge refuses new
tools during the loan; existing native admissions and in-flight business tools
prevent lending. A peer keeps the normal full-access path and approval policy.
Its exit receipt returns ownership; missing cleanup poisons the durable lease.
Peer file mutations also participate in the task's wave-conflict checks with
their actual Agent/run provenance. A monotonic write order preserves the real
last writer if the source resumes after its peer. Peer opinions are not promoted
to task completion or attributed to the source's verification evidence.

Earlier read-only-profile test and browser results above are historical, not
evidence for this final policy. Updated native, browser and full-suite checks
remain required before opening and merging the PR.

Focused checks after the full-access integration: 101 tests passed, including
real pinned-Pi discussion/consultation, adaptive single-task implementation and
active task handoff. Lease/bridge tests additionally cover source admission
while a peer runs, refusal to lend with unfinished native calls, unconfirmed
peer teardown and restored ownership. Final full-suite and build gates remain.
