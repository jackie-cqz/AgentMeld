# Pi Runtime

## Supported Boundary

AgentMeld pins `@earendil-works/pi-coding-agent` to **0.84.2**. Install with the
repository lockfile and Node.js **>=22.19.0**. No global Pi installation is needed.
Only Pi is a production execution engine. DSH, OpenCode, Claude Code and Codex
are not part of this integration.

Pi owns provider requests, argument parsing, tool iteration, retries, internal
history and native compaction. AgentMeld owns stable Agent identities, routing,
task DAGs, cross-task context and facts, bridge authentication, approvals,
artifacts, evidence and run lifecycle. The connection layer does not contain
another LLM loop or a JSON-repair fallback.

Full-tool invocations sharing one workspace are serialized, including discussion.
The DAG may admit multiple tasks, but they wait for exclusive workspace ownership.
A source synchronously awaiting peer consultation pauses its bridge and lends
that ownership to the admitted peer. It resumes only after confirmed peer
teardown. This is controlled lease lending, not concurrent independent writers.

## Configuration And Identity

1. Configure a provider, endpoint, credential and model in AgentMeld Settings.
2. Select them in the Agent editor. Pi installation status checks the pinned CLI
   package and Node version, not network reachability or provider authentication.
3. The server freezes provider resolution before waiting for workspace ownership.
   An invocation stores an immutable binding version with model, endpoint,
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

Every Agent now runs with the full native toolset, the same way a standalone Pi
agent does. There is no per-Agent tool whitelist, no tool preset that narrows
capability, and no per-Agent grant that selects the available tools. The
extension registers Pi's real tool implementations. Applicable approvals,
command policy, resource limits and protocol admission still apply to calls.

Terminal protocol tools are scoped to their actual phase: `plan_tasks` belongs
to Conductor PLAN, and `respond_to_consultation` to the admitted peer invocation.
They are not ordinary workspace capabilities. `list_team_members` is available
to every current conversation member and returns only that conversation's roster,
not credentials, prompts or Agents in other conversations. Ordinary discussion
and consultation retain the full workspace toolset; discussion intent is an
instruction, not an enforced read-only capability profile.
The Agent editor has no per-Agent tool picker at all. Its "运行时工具"
tab shows the server-provided runtime toolset read-only, so the UI cannot
present a selection as a grant or imply that editing an Agent changes capability.

| Platform tool | Pi native tool |
| --- | --- |
| `fs_read` | `read` |
| `fs_write` | `write` |
| `fs_patch` | `edit` |
| `fs_list` | `ls` |
| `fs_search` | `grep` |
| `fs_glob` | `find` |
| `bash` | `bash` |

File and command tools are Pi-native. Pi parses the arguments, computes batch
edits, runs the shell and owns the loop. The extension obtains platform admission,
waits for applicable approvals and records outcomes as evidence, but does not
confine native paths to the workspace. Native `grep`/`find` require `rg`/`fd` on PATH.
Offline execution does not silently download missing binaries. Installation
status does not validate those optional helpers or claim that every model
supports images. Search and read behavior is Pi's native behavior, not a promise
of the retired tools' exact formatting or filtering.

The platform retains command timeouts, bounded output capture, file-size and
workspace-quota checks, and the exclusive workspace lease. Native writes and
edits can wait for approval before mutation in file Review mode. Destructive
command patterns are blocked, and selected commands require approval. File Auto
mode does not approve plans or commands. Post-write hashes and tool outcomes
are recorded for evidence and audit. Full tool availability does not imply
unconditional approval of each call.

`ask_user`, `plan_tasks`, `report_task_result`, facts, artifact, deployment and
other platform business tools live in the AgentMeld server process, so Pi reaches
them through a per-invocation authenticated loopback bridge. This is **not MCP**
or an OS sandbox. It carries platform protocol admission, approvals and business
state across processes; it does not provide per-Agent tool whitelists or host
isolation. The token is revoked at teardown and is
removed from native Bash command environments. An accepted plan or task report
ends the invocation's business-tool activity. Artifact bindings are committed
before Pi can submit the final task report.

The legacy `job_start`/`job_read`/`job_wait`/`job_cancel` command kernel is not
exposed to Pi. Long verification uses native `bash` and waits for completion.
Existing per-Agent tool rows stay in the database untouched for history, but they
are no longer shown or editable anywhere in the UI, decide which tools an Agent
may call, or change capability when an Agent is saved. Historical job display and
platform cleanup helpers remain, but this is not a second production Agent
command engine.

Native commands use **Bash**, including on Windows. Shell commands may create or
change source files; there is no verification-only policy. Destructive-pattern
checks, selected command approvals and resource limits still apply. Existing web
and authenticated Feishu approval routes resolve the same pending IDs. Cancellation releases
pending questions, plans, writes and commands without approving them.

Windows process ownership also requires Windows PowerShell with `Add-Type` and
permission to run the repository's local Job Object host script. The launcher
does not bypass execution policy. Host diagnostics report only fixed stage names
and numeric error codes, never provider credentials or raw subprocess stderr.
The initial Windows RPC handshake allows up to 60 seconds for cold PowerShell
and .NET initialization; subsequent RPC commands retain the 15-second bound.
Prefer workspace-relative native file paths where possible; the runtime uses the
physical root to avoid Windows short-name aliases disagreeing with native file
callbacks.

Full native access is not isolation. Native file and command tools run with the
AgentMeld server user's OS permissions and are not confined to the workspace:
they can read, change and execute anything that user can reach on the host. The
platform's evidence ledger, approval records and workspace lease document who
did what and keep writers from overlapping, but none of them is a path sandbox
or a privilege boundary. There is no organizational secret vault, no kernel
isolation and no OS sandbox. Only run trusted workspaces, dependencies and
provider endpoints, and keep secrets away from anything the server user can read.

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
it does not replay commands. A dead owner that never launched a child can be
reclaimed automatically. If a child was launched but no normal teardown released
the lease, dead parent/child PIDs do not prove detached descendants stopped: the
lease remains locked for inspection, on all operating systems. A surviving orphan
must be stopped before the next writer is admitted. PID reuse may conservatively
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
