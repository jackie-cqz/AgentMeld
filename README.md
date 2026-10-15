# AgentMeld

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-111111?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-087ea4?logo=react&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="SQLite local-first" src="https://img.shields.io/badge/SQLite-local--first-0b6b88?logo=sqlite&logoColor=white">
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white">
  <img alt="DeepSeek compatible" src="https://img.shields.io/badge/DeepSeek-compatible-4d6bfe">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-22a06b"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="docs/README.zh-CN.md">简体中文</a>
</p>

AgentMeld is a local-first multi-agent collaboration workspace. It turns complex AI-assisted work into a visible team conversation: a Conductor clarifies intent, plans tasks, delegates work to specialist agents, tracks tool evidence, and keeps generated files and artifacts next to the discussion.

The current release focuses on **evidence-aware context engineering** and **runtime observability**. AgentMeld does not just let agents chat. It records what each agent received, which upstream artifacts were available, which tools were used, what evidence was produced, and why a task passed, failed, retried, or got blocked.

![AgentMeld workspace](docs/images/agentmeld-preview.png)

## What AgentMeld Is For

AgentMeld is built for local, inspectable workflows such as:

- turning a natural-language request into PRD, design, implementation, review, and preview steps;
- coordinating PM, UI Designer, Frontend Engineer, Reviewer, and custom agents in one workspace;
- letting agents work with files, commands, artifacts, user approvals, and local deployment previews;
- debugging why a downstream agent missed a PRD, ignored a style guide, failed a build, or produced an unverifiable artifact;
- experimenting with context engineering strategies without sending your local workspace to an external SaaS product.

## Highlights

### Multi-Agent Workspace

- Team-chat interface for single-agent or multi-agent conversations.
- Conductor-led requirement clarification, task planning, DAG scheduling, retry, and aggregation.
- Specialist agents with independent model, API key, base URL, system prompt, capabilities, and tool permissions.
- Plan review flow before executing multi-step work.

### Evidence-Aware Runtime

- Every dispatched task can carry expected outputs, required inputs, acceptance criteria, and required evidence.
- Output bindings connect upstream artifacts to downstream tasks.
- Verification checks artifact existence, artifact type, command evidence, deployment evidence, and structured acceptance results.
- Failed tasks can be retried with failure-aware context instead of replaying the whole conversation.

### Context Engineering

- Task Context Compiler builds task-specific context from DAG dependencies, verified upstream outputs, active facts, workspace state, failure context, and relevant history.
- Fact Registry keeps session-scoped structured facts, with validation and supersession support.
- Context snapshots are persisted so a task attempt can be audited later.
- Context Trace shows included and omitted context, upstream inputs, evidence, verdicts, output bindings, warnings, and a server-side diagnostic summary.

### Tools And Safety

- Built-in tools for file listing and directory creation, file reading, full-file writes, focused patches, shell verification, artifacts, deployments, user questions, attachments, evidence reads, context fact updates, task planning, and task reporting.
- `fs_patch` is preferred for local source edits; `fs_write` is reserved for new files or intentional full replacement.
- Shell commands are restricted to verification and approved dependency installation. Source edits through shell redirection, PowerShell writes, `sed`, and destructive cleanup are blocked.
- Workspace paths are sandboxed and validated.

### Artifacts And Local Preview

- Artifact types include document, web app, image, and presentation.
- Web app artifacts and workspace builds can be deployed as local static previews.
- Artifact library supports versions, preview, source view, edit flow, and generated deployment cards.

### Observability

- Context Trace API by attempt, child run, and conductor run.
- Context Trace Drawer in the UI for diagnosing missing inputs, unread artifacts, output binding failures, failed verdicts, and weak tool evidence.
- Runtime diagnostics dashboard with upstream read density, tool failures, duration, and preview readiness.
- Structured run events over SSE for messages, tool calls, approvals, dispatch progress, context summaries, evidence, verdicts, artifacts, and usage.

## Workflow Example

```text
User: "Build a pomodoro timer app"

1. Conductor inspects the request and available agents.
2. If the requirement is ambiguous, Conductor asks the user to clarify.
3. If ready, Conductor calls plan_tasks and produces a DAG:
   - PM: write a PRD
   - UI Designer: write a style guide
   - Frontend Engineer: implement and deploy the app
   - Reviewer: inspect the result
4. The user reviews and approves the plan.
5. Agents run in dependency order.
6. Each tool call is recorded as structured evidence.
7. Upstream artifacts are verified and bound to output keys.
8. Downstream agents receive only task-relevant context.
9. Context Trace can explain what each agent saw and why.
10. The final artifact and preview appear beside the conversation.
```

## Architecture

```text
src/
  app/          Next.js pages and API routes
  components/   Chat, agent, artifact, approval, trace, and workspace UI
  db/           SQLite bootstrap, schema, seed data, and persistence helpers
  server/       Pi runtime connection, Conductor, tools, verification, context, evidence
  shared/       Shared types, ids, constants, and display helpers
  stores/       Zustand state and SSE event reducers
```

Runtime flow:

```text
Next.js UI
  -> API route
  -> Conversation service
  -> Agent runner
  -> Pinned Pi RPC subprocess (model requests, Agent Loop, native tools)
  -> Native tool admission / platform business tool bridge
  -> Evidence Ledger / Artifact store / Workspace
  -> SSE events back to UI
```

## Tech Stack

- Next.js 16, React 19, TypeScript
- Zustand and Immer for frontend state
- SQLite, Drizzle ORM, and `better-sqlite3` for local persistence
- Pi 0.84.2 execution engine with configured OpenAI-compatible or Anthropic models
- Tailwind CSS
- Vitest, ESLint, and TypeScript checks

## Requirements

- Node.js 22.19.0 or newer
- pnpm 10 or newer
- A model provider API key, such as DeepSeek

## Getting Started

```bash
git clone https://github.com/jackie-cqz/AgentMeld.git
cd AgentMeld
pnpm install
cp .env.example .env.local
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

On Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

You can also enter API keys in the AgentMeld settings panel after startup.

## Configuration

Common environment variables (`.env.example` lists all of them, including benchmark-only ones):

```env
AGENTMELD_DATA_DIR=.agentmeld-data
AGENTMELD_DB_PATH=.agentmeld-data/agentmeld.db
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Agent-level settings can override the default provider, model, base URL, and API key.

## Common Commands

See [Workspace Toolkit](docs/workspace-toolkit.md) for file search, paged reads, background verification, public web research, read-only Git inspection, and isolated browser acceptance checks. New permissions must be enabled for existing Agents; web search and browser checks have optional server setup requirements.

```bash
pnpm dev        # Start the development server
pnpm build      # Create a production build
pnpm start      # Run the production server
pnpm typecheck  # Check TypeScript
pnpm lint       # Run ESLint
pnpm test       # Run the Vitest suite
pnpm db:push    # Apply the typed Drizzle mirror in src/db/schema.ts via drizzle-kit. Safe ONLY on a fresh empty database: on a database the app already created (src/db/bootstrap.ts) it proposes dropping the search (FTS) tables, so never run it against real data — and never with --force. See docs/schema.md
pnpm db:seed    # Create the local database if needed, then print row counts (it does not insert sample data). Also runs the startup recovery pass — see the note below the command list
pnpm e2e:fixture # Evaluate one completed run: pnpm e2e:fixture <runId> <fixturePath>
pnpm e2e:report  # List benchmark fixtures, or evaluate one run with --run <runId> --fixture <path>
pnpm quality:gates # Run the release quality gates over saved benchmark reports; exits non-zero when a gate fails. On a fresh clone there is no benchmark data yet, so the minimum-fixtures gate fails
pnpm agent:bench        # Benchmark CLI; requires arguments (see: pnpm agent:bench:all). With none it prints usage and exits 1
pnpm agent:bench:all    # List all benchmark fixtures and usage examples (it does not run them)
pnpm agent:bench:smoke  # Run the benchmark cases tagged "smoke"
pnpm agent:bench:full   # Run the full benchmark suite
```

The repository also contains early evaluation and fixture scripts. The scripts that run app code (`db:seed`, `e2e:*`, `quality:gates`, `agent:bench*`) load `.env.local` first and then `.env` via `scripts/load-env.mjs`. Of those, `e2e:*` and `agent:bench --run/--compare` reach a running app over HTTP, while `agent:bench --case/--suite` drives the conversation in-process; all of them need provider credentials. The current release is positioned around runtime observability rather than a complete benchmark platform.

`pnpm db:seed` calls `ensureDatabase()`, which runs the startup recovery pass (`src/db/bootstrap.ts`). That pass force-fails every run still marked `running` in the database it opens — and it opens the same database the app uses. Running `db:seed` next to a live dev server therefore does *not* stop the run that server is executing: nothing aborts it across processes, and the server overwrites the run status again once it finishes. It does, however, mark that run failed and its attempts rejected in the meantime, and the script reports exactly that (`[run-recovery] Marked 1 orphaned runs as interrupted.`). Stop the server first, or point `db:seed` at a different `AGENTMELD_DATA_DIR`. The other scripts are not affected: `e2e:*` and `quality:gates` never open the database, and `agent:bench*` switches `AGENTMELD_DATA_DIR` to its own benchmark directory before it calls `ensureDatabase()`.

## Local Data

By default, AgentMeld stores its local database, workspaces, previews, deployments, and generated runtime files in:

```text
.agentmeld-data/
```

On first startup, AgentMeld automatically creates `.agentmeld-data/agentmeld.db`, initializes the required tables, and seeds built-in agents. You do not need to create a database manually before running the app.

This directory is ignored by Git. Do not commit `.env.local`, API keys, local databases, generated workspaces, or deployment output.

## Provider Notes

All production Agents, including Conductor, execute through the project-pinned Pi runtime. Configure the provider and model in AgentMeld Settings, then select them in the Agent editor. The editor shows the installed Pi version; this installation check is not a claim that provider authentication has succeeded.

The custom Agent Loop, production Adapter registry and Claude Code/Codex placeholder engines have been retired. Existing Custom/Mock Agent records migrate to Pi without changing their identities, history or channel bindings. Other retired configurations require explicit editing before execution; they do not silently fall back to a different engine.

See [Pi Runtime](docs/pi-runtime.md) for permissions, configuration snapshots, cancellation, session ownership, diagnostics and recovery. Pi's native filesystem tools reuse existing `fs_*` grants; platform tools such as `ask_user`, `plan_tasks`, artifact and deployment operations remain structured platform capabilities. This private extension bridge is not an external MCP server.

## Known Limitations

- AgentMeld targets a local, single-owner workflow with device pairing, not multi-tenant organization access control.
- Each invocation gets a fresh Pi session. Platform history and task context are transferred, but old Custom histories are not converted into native Pi sessions. Interrupted commands are not automatically resumed.
- Host commands are not OS-sandboxed. Native filesystem admission, write approvals and command policy do not make arbitrary workspace scripts safe to run.
- Run one AgentMeld control server per data directory. Startup recovery assumes no other control server owns live runs. Unconfirmed Pi teardown keeps a durable workspace lease rather than admitting another writer.
- Pi is pinned to 0.84.2; arbitrary global versions, user-installed Pi extensions, OAuth/native session import, other Harnesses and standalone server packaging are not supported by this integration.
- Local deployment previews are static and local; AgentMeld does not publish generated apps to a hosted cloud platform.
- Tool-call reliability still depends on model behavior, especially for large JSON tool arguments.
- The benchmark/evaluation scripts are not yet a full automated benchmark platform.
- Internal schemas and APIs may still change while the project is under active development.

## Roadmap

- Stable Prefix / Dynamic Suffix prompt layout for better prefix cache behavior.
- Task State Context so each agent receives a structured view of current task status.
- Evidence Cards that summarize long tool results before they enter context.
- Playbook / Skill Registry for reusable process memory beyond factual memory.
- Multi-intent Query Planner before Conductor task planning.
- Stronger runtime diagnostics, trace navigation, and recovery UX.
- External MCP tool integration while preserving ToolRegistry permissions, approvals, evidence, and SSE events.

## Status

AgentMeld is an active early-stage local-first agent runtime. The current release can be treated as a Context Observability and Evidence-Aware Runtime Diagnostics release.

## License

AgentMeld is released under the [MIT License](LICENSE).
