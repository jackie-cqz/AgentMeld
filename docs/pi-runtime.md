# Pi Runtime

## Supported Boundary

AgentMeld pins `@earendil-works/pi-coding-agent` to **0.84.2**. Install with the
repository lockfile and Node.js **>=22.19.0**. No global Pi installation is needed.
Only Pi is a production execution engine. DSH, OpenCode, Claude Code and Codex
are not part of this integration.

Pi owns provider requests, argument parsing, tool iteration, retries, internal
history and native compaction. AgentMeld owns stable Agent identities, routing,
task DAGs, cross-task context and facts, authorization, approvals, artifacts,
evidence and run lifecycle. The connection layer does not contain another LLM
loop or a JSON-repair fallback.

Invocations sharing one workspace are serialized, including read-only roles.
The DAG may admit multiple tasks, but they wait for exclusive workspace ownership.
This initial integration favors deterministic ownership over same-directory parallelism.

## Configuration And Identity

1. Configure a provider, endpoint, credential and model in AgentMeld Settings.
2. Select them in the Agent editor. Pi installation status checks the pinned CLI
   package and Node version, not network reachability or provider authentication.
3. The server freezes provider resolution before waiting for workspace ownership.
   An invocation stores an immutable binding version with model, endpoint, grants,
   Pi version and a credential reference. Keys are not stored in that binding.
4. Pi receives a private per-invocation home, model configuration and credential
   environment. Global Pi credentials, context files, skills and extensions are
   not imported. The sole loaded extension is `src/server/pi/extension.mjs`.
5. Platform Agent/run/task/attempt IDs stay distinct from the native session ID.
   Every invocation gets a new native session, including retries and Conductor
   phases. No session is driven by two tasks.

Existing Custom/Mock records migrate to Pi without replacing Agent IDs, messages,
artifacts or Feishu bindings. Claude Code/Codex placeholder records stay readable
but cannot execute until explicitly migrated in the editor. There is no silent
fallback. Execution-related edits are rejected while that Agent has a running
or queued platform run.

After upgrading, stop and restart the AgentMeld server. Development hot reload
does not rerun database bootstrap migrations. Existing unfinished executions are
marked interrupted at startup; they are not silently resumed in a new engine.

## Tools And Permissions

| Existing grant | Pi native capability |
| --- | --- |
| `fs_read` | `read` |
| `fs_write` | `write` |
| `fs_patch` | `edit` |
| `fs_list` | `ls` |
| `fs_search` | `grep` |
| `fs_glob` | `find` |
| `bash` | `bash` |

The extension uses Pi's real tool implementations. It checks grants and real
workspace paths before execution. Pi computes batch edits itself; its pluggable
write operation requests approval for the actual proposed bytes before writing.
File limits, quota, stale approvals, and post-write hashes are checked by the
platform. A rejected write does not create parent directories. Search/read
semantics are Pi's native semantics, not a promise of the retired tools' exact
formatting or filtering behavior.

`ask_user`, `plan_tasks`, `report_task_result`, facts, artifact, deployment and
other platform business tools use a per-invocation authenticated loopback bridge.
This is **not MCP**. The token is revoked at teardown and is removed from native
Bash command environments. Unlisted tools and replayed call IDs are rejected.
An accepted plan or task report ends the invocation's business-tool activity.
Artifact bindings are committed before Pi can submit the final task report.

The legacy `job_start`/`job_read`/`job_wait`/`job_cancel` command kernel is not
exposed to Pi. Long verification uses native `bash` and waits for completion.
Existing grants are retained in storage for history but fail with an explicit
migration error; the Agent editor explains that saving removes them. New presets
do not grant them. Historical job display and platform cleanup helpers remain,
but this is not a second production Agent command engine.

Native `grep`/`find` require `rg`/`fd` on PATH. Offline execution does not silently
download missing binaries. Installation status does not validate those optional
helpers or claim that every model supports images.

Native commands use **Bash**, including on Windows. The existing command policy
admits verification commands and approved dependency operations; source edits
must use `write`/`edit`, not shell mutation. Existing web and authenticated Feishu
approval routes resolve the same pending IDs. Cancellation releases pending
questions, plans, writes and commands without approving them.

These controls are **not an OS sandbox**. Approved project scripts execute host
code and can reach host resources. Only run trusted workspaces and dependencies.
Native tools do not supply an organizational secret vault or kernel isolation.

## Context And Evidence

The platform compiles current task identity, active facts, relevant history,
upstream artifacts, prior failure reasons and acceptance requirements into one
task packet. Delegated work does not receive the entire group transcript again.
Pi maintains history within that invocation; platform code does not append an
extra copy of the task packet on every model turn.

File outcomes are re-read and hashed. Native command outcomes and business tool
receipts feed the existing evidence ledger. Agent reports remain declarations;
required outputs and acceptance criteria still pass through platform verification.
An accepted model request, a final success sentence, completed execution and
verified task acceptance are different states. No provider usage means unknown
usage, not fabricated zero tokens.

## Cancellation, Failure And Recovery

RPC is UTF-8 JSONL split only on LF, with correlated responses and bounded frames.
A prompt acknowledgement is not completion. Successful execution requires the
pinned protocol's settled event, a committed assistant turn, no unfinished calls,
and a task report for delegated work. Provider errors, truncated output, protocol
damage, exit, turn exhaustion and timeout fail explicitly.

`AGENTMELD_PI_RUN_TIMEOUT_MS` defaults to 20 minutes, including workspace waiting.
Turn and tool-call budgets are platform supervision limits, not a second loop.
Cancellation stops Pi, approvals and platform-owned background jobs. Teardown
waits for process exit; uncertain cleanup poisons the durable workspace lease.
Another task cannot start writing that workspace while ownership is uncertain.
On Windows, a small built-in PowerShell/.NET host places Pi in a Windows Job
Object before its main thread runs. Descendants remain in that job even after
intermediate shells exit. EOF or termination drains the job, and the host confirms
its active process count is zero before exit. An unconfirmed host exit fails
closed. This is lifecycle supervision, not an OS security sandbox. Windows
requires built-in Windows PowerShell/.NET and Git Bash.
See Microsoft's [Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) for the underlying lifecycle primitive.

The database contains `agent_execution_bindings`, `harness_executions` and
`harness_workspace_leases`. Session files live under
`.agentmeld-data/pi/executions/<invocation>/sessions`. They are local history,
not live-process checkpoints. Startup marks unfinished invocations interrupted;
it does not replay commands. A lease is reclaimed automatically only if both
recorded owner and child processes are gone. A surviving orphan must be inspected
and stopped before the next writer is admitted. PID reuse may conservatively
require operator intervention; never delete a lease merely to unblock execution
without confirming that its old processes have stopped.

Run **one control server per data directory**. Existing startup recovery assumes
no other control server is running; do not run `db:seed` alongside the live app.
Do not edit an execution's private files or clear leases while it is running.

## Verification

`src/server/pi/runtime.test.ts` launches the real locked Pi CLI against a local
deterministic model server. It covers text, native write and batch edit, provider
failure, output limits, cancellation, pending approval, and dependent multi-Agent
Conductor execution. Protocol, projection, concurrency and lease tests complement
that contract. The CI Pi job runs these tests on Windows and Linux without API
credentials. This does not claim that every external provider behaves identically.

Provider-specific live smoke testing is opt-in and must use isolated test data.
Never publish native session transcripts, request headers, API keys or private
workspace contents as CI artifacts. Root-source production deployment is supported;
Next.js standalone tracing/bundling and arbitrary Pi extensions are not validated.
