# AgentMeld

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-111111?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-087ea4?logo=react&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="SQLite local-first" src="https://img.shields.io/badge/SQLite-local--first-0b6b88?logo=sqlite&logoColor=white">
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white">
  <img alt="DeepSeek compatible" src="https://img.shields.io/badge/DeepSeek-compatible-4d6bfe">
  <img alt="tests 445" src="https://img.shields.io/badge/tests-445_passing-22c55e">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-22a06b"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="docs/README.zh-CN.md">简体中文</a>
</p>

AgentMeld is a local-first workspace for coordinating multiple AI agents through a team-chat interface. A Conductor can clarify requirements, divide complex work among specialist agents, track tool activity, and collect generated artifacts beside the conversation.

![AgentMeld workspace](docs/images/agentmeld-preview.png)

## Features

**Agent Collaboration**
- Single-agent and multi-agent conversations with IM-style interface
- Conductor-led planning, task dispatch, DAG scheduling, and result aggregation
- Recovery plans when tasks fail — only re-runs what's needed
- Per-agent API key, model, and base URL configuration with three-tier resolution

**Tools & Safety**
- 12 built-in tools: file I/O, bash, artifacts, deployment, user prompts
- Approval gates for sensitive operations (fs_write, bash, plan_tasks)
- Workspace sandbox with path validation, symlink protection, and quota limits
- Platform-specific command blacklists (POSIX + Windows)

**Artifacts & Workspace**
- Four artifact types: document, web_app, image, presentation
- Version chains with diff comparison and rollback
- Local deployment previews via iframe
- In-conversation file browser with syntax highlighting

**Context Engineering**
- Token-aware history window with model-specific budget calculation
- Incremental context compaction with rolling chunk summarization
- Pinned messages immune to truncation; overflow detection before LLM calls
- Conversation pinning separate from message pinning

**Reliability**
- 445 tests passing (Vitest), TypeScript strict mode, ESLint
- Structured logger with 14 error categories and sensitive-data masking
- Run lifecycle persistence with startup orphan recovery
- Approval state persisted to SQLite with conditional write protection

## How It Works

```
You: "Build a pomodoro timer"
  → Conductor reads the room, checks available agents
  → asks user to clarify (ask_user) or plans immediately (plan_tasks)
  → Plan: t1: PM → PRD, t2: Designer → style guide, t3: Frontend → code, t4: Reviewer → audit
  → You approve the plan
  → DAG waves execute: PM + Designer run in parallel, Frontend waits for both, Reviewer waits for Frontend
  → Each agent uses tools (fs_write, bash, write_artifact) with optional approval gates
  → Artifacts flow downstream via output bindings
  → Conductor aggregates results into a natural-language summary
  → You see the final artifact in the right panel
```

> See [skills/](skills/) for developer reference on tools, artifacts, context management, and persistence.

## Tech Stack

- Next.js 16 and React 19
- TypeScript
- Zustand and Immer
- SQLite, Drizzle ORM, and `better-sqlite3`
- Tailwind CSS
- Vitest and ESLint

## Requirements

- Node.js 20.9.0 or newer
- pnpm 10 or newer
- A model-provider API key, such as DeepSeek

## Getting Started

```bash
git clone https://github.com/jackie-cqz/AgentMeld.git
cd AgentMeld
pnpm install
cp .env.example .env.local
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

On Windows PowerShell, copy the environment file with:

```powershell
Copy-Item .env.example .env.local
```

API keys can also be entered from the AgentMeld settings panel after startup.

## Common Commands

```bash
pnpm dev        # Start the development server
pnpm build      # Create a production build
pnpm start      # Run the production server
pnpm typecheck  # Check TypeScript
pnpm lint       # Run ESLint
pnpm test       # Run the test suite
pnpm db:push    # Apply the Drizzle schema
```

## Local Data

By default, AgentMeld stores its database, workspaces, previews, and deployments in:

```text
.agentmeld-data/
```

On the first startup, AgentMeld automatically creates `.agentmeld-data/agentmeld.db`, initializes the required tables, and seeds the built-in agents. Normal users do not need to create a database or run `pnpm db:push` before starting the app.

This directory is ignored by Git. Override it with `AGENTMELD_DATA_DIR`, or set a database file directly with `AGENTMELD_DB_PATH`.

Do not commit `.env.local`, API keys, local databases, generated workspaces, or deployment output.

## Project Structure

```text
src/
  app/          Next.js pages and API routes
  components/   Chat, agent, artifact, approval, and workspace UI
  db/           SQLite schema, bootstrap data, and persistence helpers
  server/       Agent runtime, tools, adapters, orchestration, and services
  shared/       Shared types, constants, and utilities
  stores/       Zustand state and stream-event reducers
```

## Provider Notes

AgentMeld is usable with DeepSeek through the custom OpenAI-compatible adapter. Claude and Codex adapter code is included, but those integrations require their respective SDK credentials and compatible runtime configuration.

Model output and generated commands are treated as untrusted input. Workspace file access is sandboxed, and sensitive file writes or commands can require approval.

## Known Limitations

- DeepSeek and other OpenAI-compatible providers are currently the recommended runtime path.
- Claude Code and Codex adapters are present but their full SDK execution flows are not yet complete.
- Deployment currently produces local static previews; AgentMeld does not publish applications to a hosted cloud platform.
- AgentMeld is designed for a local, single-user environment and does not provide multi-user authentication or access control.
- Tool-call reliability still depends partly on model behavior, especially when generating large structured arguments.
- Data schemas and internal APIs may change while the project remains in active early development.

## Roadmap

- Complete and harden the Claude Code and Codex SDK adapters.
- Improve structured tool-call validation, repair, retries, and failure diagnostics.
- Strengthen Conductor planning, task evidence validation, retries, and result aggregation.
- Expand context engineering, compaction quality, and long-running conversation reliability.
- Improve artifact editing, deployment previews, version comparison, and recovery flows.
- Add external MCP tool configuration with clear permission and approval controls.
- Continue frontend accessibility, responsive-layout, dark-mode, and interaction polish.
- Add release automation, contributor documentation, and broader integration tests.

## Status

AgentMeld is an active early-stage project. APIs, data structures, and interface details may change between releases.

## License

AgentMeld is released under the [MIT License](LICENSE).
