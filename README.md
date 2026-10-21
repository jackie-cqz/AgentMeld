# AgentMeld

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-111111?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-087ea4?logo=react&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="Pi 0.84.2" src="https://img.shields.io/badge/Pi-0.84.2-536b45">
  <img alt="SQLite local-first" src="https://img.shields.io/badge/SQLite-local--first-0b6b88?logo=sqlite&logoColor=white">
  <a href="https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-22a06b"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="docs/README.zh-CN.md">简体中文</a>
</p>

**A local-first group-chat workspace for AI coding teams, powered by Pi.**

Bring specialized Agents into one conversation: discuss an approach, ask another Agent for help, execute a task, and hand unfinished work to a teammate without manually copying the whole chat. Files, tool calls, approvals, artifacts, and task evidence stay alongside the conversation.

AgentMeld currently uses **Pi as its only production execution engine**. Pi handles model requests and the Agent Loop; AgentMeld handles team identities, routing, task coordination, context, and the workspace. Cross-harness execution is a roadmap item, not a shipped feature.

![AgentMeld conversation and artifact workspace](docs/images/main-workspace/desktop-light.png)

[Quick Start](#quick-start) · [How Collaboration Works](#how-collaboration-works) · [Safety](#tools-and-safety) · [Limitations](#known-limitations) · [中文说明](docs/README.zh-CN.md)

## What You Can Do

| Situation | AgentMeld workflow |
| --- | --- |
| Compare approaches before changing code | Discuss in the group, address specific Agents, or reply to an Agent. Discussion does not require a delivery plan. |
| Make a small, well-defined change | Route it to an Agent without forcing a PM, design, implementation, and review pipeline. |
| Deliver a multi-stage feature | Let Conductor propose a dependency-aware plan, review it, and track specialist tasks and outputs. |
| Change requirements while work is running | Send a supplement or correction; the platform tracks its delivery and replaces the invocation when necessary. |
| An Agent needs a second opinion | It can consult a current teammate through a bounded, tracked exchange. |
| An implementation gets stuck | Confirm a task handoff to another Pi-backed Agent with the task contract, prior evidence, and relevant context. |
| Inspect the result | Browse files, compare artifact versions, open static previews, and inspect Context Trace and tool evidence. |

Built-in roles include Conductor, PM, UI Designer, Frontend Engineer, and Reviewer. You can also create Agents with your own identity, avatar, model, capabilities description, and system prompt.

## How Collaboration Works

### Chat First, Plans When Needed

- Explicit recipients take priority over the Agent you reply to, then the conversation's default Conductor. Multiple explicit recipients can be addressed together; a group message does not automatically wake every Agent.
- Ordinary discussion is possible without a Conductor. In a team without one, choose the recipients explicitly.
- Complex delivery can use Conductor's plan review, DAG scheduling, retries, output bindings, and result aggregation. Simple requests do not have to follow a fixed role sequence.
- Human turns have persistent submission identities and delivery states. Submission IDs deduplicate retries after a lost response; a progress query can inspect existing work without restarting it.
- Corrections and executable supplements preserve the previous goal. When live input is unsafe, AgentMeld stops the old invocation, waits for confirmed cleanup, and compiles a fresh attempt with the updated requirement.

### Peer Consultation And Task Handoff

These are different operations:

| | Peer consultation | Task handoff |
| --- | --- | --- |
| Purpose | Ask another Agent for a bounded second opinion | Transfer responsibility for an unfinished or failed delegated task |
| Ownership | The source remains responsible | A human-confirmed target receives a new run and attempt under the same task ID |
| Context | Human request, consultation question, and relevant task context | Executed task contract, failure/evidence references, active facts, upstream artifact versions, and file fingerprints |
| Completion | A reply is advice, not verified task completion | The receiving Agent must still report results and pass verification |

Consultations are bounded and cannot recursively spawn an unrestricted conversation. A synchronously consulting Agent pauses its bridge and temporarily lends workspace ownership to the peer; it resumes only after confirmed peer teardown.

Handoff packages are checked again before acceptance. Stale context, obsolete attempts, or uncertain source cleanup cannot silently start a second writer. Taking over a task from a failed plan does **not** automatically resume every downstream task in that plan.

For example:

```text
You -> @Developer: "Compare two approaches first; don't implement yet."
Developer -> @Reviewer: asks for a second opinion.
You -> @Developer: "Use option B. Implement it and run the tests."
You: "Keep the existing API response shape."
AgentMeld: tracks the correction and safely replaces the invocation if needed.
If the delegated task stalls: you confirm a handoff to another Agent.
Receiver: gets a fresh task context, checks the files, and verifies its work.
```

Discussion instructions such as "don't implement yet" rely on model instruction-following. They do not remove tools or create a read-only security mode.

## Workspace Features

### Evidence-Aware Context

The Task Context Compiler organizes the current task, dependency contracts, verified upstream outputs, active session facts, relevant history, workspace state, acceptance criteria, and prior failures. Delegated Agents do not simply receive the entire group transcript.

- Session-scoped facts support validation and supersession.
- Task attempts retain context snapshots and output bindings.
- Tool outcomes feed the Evidence Ledger; a model's success sentence is not proof of completion.
- Context Trace explains included and omitted context, missing inputs, evidence, verdicts, and warnings.

### Files, Tools, And Artifacts

- Pi-native file browsing, search, reading, writing, editing, and Bash execution.
- Platform tools for user questions, team discovery, consultation, task reporting, facts, artifacts, and deployment.
- Public web search/fetch, read-only Git inspection, and isolated browser acceptance checks.
- Document, web app, image, and presentation artifacts with versions, source views, and preview.
- Workspace static builds deployed as local previews, linked to real deployment records.

### Workbench, Providers, And Channels

- Light/dark workbench with conversations, workspace files, artifacts, diagnostics, and approval views.
- Provider presets and centralized model configuration; each Agent selects its provider/model and can override connection settings.
- Agent creation and editing with preset avatars, separate system-prompt settings, and a read-only runtime tool inventory.
- Structured SSE updates for text, tools, approvals, usage, task progress, consultation, handoff, and artifacts. Persisted records restore the UI after reload; this is not process resumption.
- Owner-device pairing and revocable browser sessions.
- Optional Feishu channel bindings, including an individual bot identity per Agent. Channel events use platform identities and approval records rather than treating arbitrary bot mentions as execution authority. See [Feishu operations](docs/feishu-operations.md) for setup notes and validation boundaries.

## Quick Start

### Requirements

- **Node.js >=22.19.0** and **pnpm 10**; the repository pins pnpm 10.33.4.
- A supported model provider credential, such as DeepSeek, an OpenAI-compatible endpoint, or Anthropic.
- On Windows: **Git Bash** for native command execution, plus Windows PowerShell/.NET for process lifecycle supervision.
- Pi is installed from the lockfile. No global Pi installation is needed.
- Optional: `rg` and `fd` on PATH for native search; Chromium for `browser_check`.

### Install And Run

On Linux/macOS or a POSIX-compatible shell:

```bash
git clone https://github.com/jackie-cqz/AgentMeld.git
cd AgentMeld
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

On Windows PowerShell:

```powershell
git clone https://github.com/jackie-cqz/AgentMeld.git
Set-Location AgentMeld
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm exec next dev -H 127.0.0.1
```

The PowerShell command avoids the POSIX environment-variable syntax in the `dev` script. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

1. Complete first-time pairing in that browser. Keep the service on loopback during initial setup.
2. Open **Settings**, add a provider, enter its API key, and configure a model.
3. Create or edit your Agents and select their models. The Pi installation check does not test provider authentication.
4. Start a conversation with the desired teammates. Address an Agent explicitly, or use Conductor for coordination.

**The first startup automatically creates the SQLite database, tables, and built-in Agents. No manual database creation or `db:push` is required.**

For browser acceptance checks, install Chromium if no supported executable is configured:

```bash
pnpm exec playwright install chromium
```

## Configuration And Local Data

Settings can be managed in the UI. Alternatively, configure only the providers you use in `.env.local`, following the [environment example](.env.example):

```env
AGENTMELD_DATA_DIR=.agentmeld-data
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Agent-specific connection settings override global settings, which override environment defaults. The app derives its database path from `AGENTMELD_DATA_DIR`; `AGENTMELD_DB_PATH` is for Drizzle CLI only.

The default `.agentmeld-data/` directory contains the SQLite database, conversation workspaces, artifacts, deployments, and private Pi execution files. It is ignored by Git, as are `node_modules/` and local environment files. Never commit credentials, native session transcripts, or generated private workspaces.

**Local-first does not mean offline.** Selected prompts, context, and tool results are sent to the configured model provider; web-search queries go to the search provider. Use trusted endpoints and do not expose secrets to Agent-accessible files.

If this browser loses its session, generate a pairing code on a still-paired device. If all owner sessions are lost, run `pnpm run auth:reset` on the server machine, then pair again. This revokes existing owner sessions, not conversation data. For a custom data directory, set `AGENTMELD_DATA_DIR` explicitly in that shell; this recovery script does not load `.env.local`.

## Tools And Safety

**All ordinary Agents receive the same full runtime toolset**, including during discussion and peer consultation. Stored per-Agent tool selections no longer grant or restrict capability. The Agent editor displays tools read-only.

File operations use Pi-native `read`, `write`, `edit`, `ls`, `grep`, and `find`. Platform names such as `fs_patch` map to those native implementations. Bash is general-purpose, including source edits; it is not verification-only. Internal classifier and Conductor protocol phases still have purpose-specific tools.

Full access does **not** bypass the platform's applicable controls:

- File review mode can require approval before a native write/edit; Auto file mode is not blanket approval for plans or commands.
- Destructive command patterns are blocked, and selected commands still require approval.
- Resource limits, evidence recording, file hashes, task verification, and workspace ownership remain in force.
- New managed writers wait for confirmed cleanup. Uncertain Pi teardown retains a durable workspace lease instead of admitting another writer.

**This is not an OS sandbox.** Native file tools are not confined to the workspace. File operations and shell/project scripts run with the AgentMeld server user's OS permissions. Approvals and leases do not isolate arbitrary code, background processes, dependencies, or secrets. Run only trusted projects, or supply your own OS/container isolation.

The authenticated Pi extension bridge is a private local integration, **not an external MCP server**. See [Pi Runtime](docs/pi-runtime.md) and [Workspace Toolkit](docs/workspace-toolkit.md).

## Architecture

```text
Next.js / React workbench
  -> Authenticated API routes + SSE
  -> Conversation routing / human-turn admission
  -> Agent runner / Conductor / consultation / handoff
  -> Pinned Pi RPC subprocess
       Pi: model requests, Agent Loop, native tools, invocation history
       AgentMeld bridge: approvals, platform tools, evidence, lifecycle
  -> SQLite + task context / facts + workspace / artifacts / static previews
```

| Area | Implementation |
| --- | --- |
| UI and state | Next.js 16, React 19, Tailwind CSS, Zustand, Immer |
| Execution | Pi 0.84.2, private per-invocation configuration and RPC |
| Persistence | SQLite, Drizzle ORM, `better-sqlite3` |
| Runtime services | `src/server/`: coordination, context, evidence, tools, verification |
| Shared contracts | `src/shared/`; API routes in `src/app/api/` |
| Quality | TypeScript, ESLint, Vitest, Playwright, Linux/Windows Pi contract CI |

The former custom Agent Loop and production Adapter registry are retired. Existing Custom/Mock Agent records migrate to Pi without replacing their identities, histories, or channel bindings; other retired executors require explicit migration.

## Development And Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
```

On Windows PowerShell, use `pnpm exec next start -H 127.0.0.1` for the production server. Build first.

[CI](https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml) runs type checks, lint, the full suite, and a production build on Linux, plus Pi contract tests on Linux and Windows. Native integration tests launch the pinned Pi subprocess against deterministic local model fixtures without public API keys. They verify the integration, not every external provider's reliability or a live model's instruction-following quality.

Advanced evaluation commands include `e2e:fixture`, `e2e:report`, `agent:bench:all`, `agent:bench:smoke`, `agent:bench:full`, and `quality:gates`. Benchmark execution requires configured credentials; quality gates need saved reports and are not a fresh-clone smoke test.

Database maintenance is **not** part of normal setup. Do not run `db:push` against a real app database: the typed Drizzle mirror can propose dropping FTS tables. Do not run `db:seed` alongside a live server on the same data directory: it runs startup recovery and can mark live runs interrupted without stopping their processes. See [Database Schema](docs/schema.md).

## Known Limitations

- **Pi is the default; OpenCode is partial.** OpenCode 1.19.3 has a real driver that runs prompts and streams output, but platform business tools and evidence are not wired for it, so artifact-producing, delegated and normal full-toolset runs are refused with `harness_capability`. DSH, Claude Code, Codex, arbitrary global Pi versions, user-installed Pi extensions, and native-session import are not supported execution backends.
- **One owner, one control server per data directory.** Pairing is device access for that owner, not organizational tenancy or role-based isolation.
- **Fresh Pi sessions.** Platform context crosses invocations, but native sessions and interrupted commands are not resumed automatically. A reload restores recorded state, not a running process.
- **Managed workspace access is serialized.** Consultation uses controlled lease lending, not independent concurrent writers in the same directory.
- **No host security sandbox.** Full-tool discussion is not enforced read-only execution. Human instructions and model behavior remain important.
- **Static local previews only.** Deployment does not host SSR/API backends or publish apps to a cloud service.
- **External dependencies vary.** Tool-call quality depends on the model; search/browser tools require optional setup. Feishu needs the relevant credentials and scopes; the latest collaboration changes have deterministic channel tests, not live Feishu certification.
- **Early-stage APIs.** Schemas, runtime interfaces, and evaluation tooling are still evolving; standalone server packaging is not validated.

## Roadmap

These are future directions, not current capabilities:

- Wire platform business tools and evidence into OpenCode (for example through a per-run MCP transport), then add other selected harnesses such as DSH.
- Extend evidence-backed handoff across harnesses without promising native-session migration.
- Improve Feishu collaboration, setup, delivery feedback, and real-device validation.
- Add remote Worker / container / sandbox-provider execution before attempting custom cloud infrastructure.
- Improve mobile monitoring, approvals, and takeover, initially through the web/PWA path.
- Refine context selection, evidence summaries, failure recovery, and trace navigation.
- Explore external MCP tools while preserving approval, provenance, lifecycle, and event semantics.

## Documentation

- [简体中文](docs/README.zh-CN.md)
- [Pi runtime, configuration, tools, and recovery](docs/pi-runtime.md)
- [OpenCode runtime: pinned SDK/CLI, event mapping and honest capabilities](docs/opencode-runtime.md)
- [Workspace toolkit and browser checks](docs/workspace-toolkit.md)
- [Collaboration implementation notes and historical acceptance log](docs/group-chat-collaboration-implementation.md)
- [Feishu operations](docs/feishu-operations.md) and [real-device checks](docs/feishu-real-device-checks.md)
- [Database schema and maintenance boundaries](docs/schema.md)

## License

[MIT](LICENSE).
