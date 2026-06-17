# Tools

## Purpose

Defines Agent-Conference-managed tools, approval boundaries, and adapter-specific tool ownership. Detailed tool specs live in `specs/07-tools.md`.

## Requirements

### Requirement: Tool definitions SHALL be registered centrally

Agent-Conference-managed tools MUST be registered through `toolRegistry` with name, description, JSON schema, and handler.

#### Scenario: Custom agent enables a tool
- **WHEN** an agent's `toolNames` includes `fs_read`
- **THEN** CustomAgentAdapter resolves the tool definition from `toolRegistry`.

### Requirement: Attachments SHALL be read through safe tool extraction

`read_attachment` MUST read user-uploaded attachments scoped to the current conversation. Text-like files and PDFs with extractable text SHALL return plain text with bounded length; unsupported binary formats SHALL return metadata instead of raw bytes.

#### Scenario: Agent reads a PDF attachment
- **WHEN** `read_attachment` receives an attachment whose MIME type, filename, or file header identifies it as a PDF
- **THEN** Agent-Conference extracts local PDF text before returning the tool result
- **AND** truncates the returned text at the same bounded length used for text files
- **AND** returns a clear note when the PDF has no extractable text and likely needs OCR.

### Requirement: File tools SHALL enforce workspace boundaries

`fs_read`, `fs_write`, and `bash` MUST resolve paths under the conversation effective cwd and reject access outside that tree.

#### Scenario: Agent attempts path traversal
- **WHEN** a tool receives `../../.ssh/id_rsa`
- **THEN** the path check rejects the operation.

### Requirement: Bash SHALL enforce platform blacklist

The bash tool MUST reject commands that match the platform-specific banned pattern list before execution.

#### Scenario: POSIX destructive command is requested
- **WHEN** the command matches `rm -rf /`
- **THEN** the tool refuses to run it.

#### Scenario: POSIX background process inherits stdio
- **WHEN** a bash command starts a background process and the shell script exits
- **THEN** the bash tool MUST NOT wait forever on inherited stdout or stderr
- **AND** it SHOULD clean up the command process group before returning.

### Requirement: Key bash commands SHALL require user approval

Agent-Conference MUST require explicit user approval before executing bash commands that are not banned but can materially change dependencies, discard files, or affect host-level runtime state. This approval gate MUST apply to Agent-Conference's `bash` tool and SDK command hooks where the adapter exposes a pre-execution permission callback.

#### Scenario: Agent installs dependencies
- **WHEN** an agent requests `pnpm install`
- **THEN** Agent-Conference records a pending bash command
- **AND** emits it through the conversation event stream
- **AND** executes the command only after user approval.

### Requirement: Review mode SHALL require write approval

In review mode, file write effects managed by Agent-Conference MUST create pending approvals instead of directly mutating workspace files.

#### Scenario: Agent proposes a file write
- **WHEN** `fs_write` is called in review mode
- **THEN** Agent-Conference records a pending write
- **AND** waits for explicit user approval.

### Requirement: SDK tool sets SHALL be documented separately

Claude Code and Codex SDK adapters MUST document their built-in tool ownership and any approval bridge limitations instead of pretending those tools are Agent-Conference `toolRegistry` tools.

#### Scenario: Codex agent runs in review mode
- **WHEN** a Codex agent is selected
- **THEN** Codex uses read-only sandbox mode
- **AND** Agent-Conference exposes only the allowlisted Agent-Conference MCP tools to Codex.

### Requirement: Agent-Conference SHALL inject tool-call guidance for available tools

Agent-Conference MUST append usage guidance and concrete examples for the Agent-Conference-managed tools available to the current run. Guidance MUST be scoped to the actual tool set, and MUST call out common argument-shape mistakes for tools whose schemas are often confused.

#### Scenario: Custom agent has file and artifact tools
- **WHEN** a custom agent run is built with `fs_read`, `fs_write`, `read_artifact`, and `write_artifact`
- **THEN** the injected system prompt includes examples for those tools
- **AND** it does not instruct the agent to call unavailable tools such as `plan_tasks`.

#### Scenario: Agent can write artifacts
- **WHEN** a run includes `write_artifact`
- **THEN** the injected guidance warns against empty `write_artifact({})` calls
- **AND** includes a complete document artifact template with `type`, `title`, and `content`.

#### Scenario: SDK adapter receives Agent-Conference MCP tools
- **WHEN** a Claude Code or Codex run is built
- **THEN** the injected guidance includes the allowlisted Agent-Conference MCP tools exposed by that adapter
- **AND** examples use the exact camelCase argument names accepted by the tool schemas.

#### Scenario: Local workspace code task has file tools
- **WHEN** a run is built for a local workspace
- **AND** the agent has Agent-Conference file tools or SDK local file tools
- **THEN** the injected guidance tells the agent to prefer direct workspace file/command tools for project source work
- **AND** tells the agent not to use `write_artifact` for source files that should be written to disk.

### Requirement: Agents SHALL be able to ask structured user questions

Agent-Conference MUST provide an `ask_user` tool for finite user choices. The tool SHALL accept 1-4 questions, each with 2-4 options, and SHALL suspend the run until the user answers or the run is aborted.

#### Scenario: Agent needs a blocking finite choice
- **WHEN** an available agent tool call submits `ask_user` with valid questions
- **THEN** Agent-Conference records a pending user question
- **AND** emits the pending question through the conversation event stream
- **AND** returns the selected answers to the agent after the user responds.

#### Scenario: Orchestrator plan has a key ambiguity
- **WHEN** the Orchestrator plan stage needs a blocking clarification expressible as 2-4 options
- **THEN** the plan stage may call `ask_user` before `plan_tasks`
- **AND** the aggregate stage does not expose `ask_user`.

### Requirement: Web app artifacts SHALL be deployable to preview URLs

Agent-Conference MUST provide a `deploy_artifact` tool that accepts a web app artifact id and returns a deployment status record with a preview path. The tool MUST create a local static deployment and SHOULD additionally publish it to a configured external static directory.

#### Scenario: Agent deploys a web app artifact
- **WHEN** `deploy_artifact` receives a valid `web_app` artifact id
- **THEN** it returns a ready deployment record
- **AND** the record points at the local deployment preview route when no external publish target is configured.

#### Scenario: Agent deploys with external static publishing configured
- **WHEN** `deployment_publish_enabled` is true
- **AND** `deployment_publish_dir` and `deployment_public_base_url` are set
- **THEN** the tool publishes public deployment files to the configured directory
- **AND** returns the public URL as the primary preview path
- **AND** includes a local preview fallback.

#### Scenario: Agent deploys a non-web artifact
- **WHEN** `deploy_artifact` receives a document, image, or missing artifact id
- **THEN** it returns a failed deployment record with a user-visible reason.

### Requirement: Workspace static directories SHALL be deployable to preview URLs

Agent-Conference MUST provide a `deploy_workspace` tool that accepts a static output directory inside the current workspace and returns a deployment status record. The tool MUST copy existing static files only; it MUST NOT run build commands. Workspace deployments MUST enforce workspace path isolation, reject missing or non-directory sources, require an HTML entry file, and exclude private or dependency directories such as `.agent-conference`, `.git`, and `node_modules`.

#### Scenario: Agent deploys a built local project
- **WHEN** `deploy_workspace` receives `path="dist"` and `dist/index.html` exists inside the conversation workspace
- **THEN** it creates a ready deployment record
- **AND** the record has `sourceType="workspace"` and `workspacePath="dist"`.

#### Scenario: Slash deploy has no artifact candidates
- **WHEN** a user sends `/deploy`
- **AND** the conversation has no `web_app` artifact candidates
- **AND** a common static output directory such as `dist`, `build`, `out`, or `client/dist` exists with `index.html`
- **THEN** Agent-Conference deploys that workspace directory and inserts a `deploy_status` message part.

### Requirement: Child tasks SHALL report semantic task outcomes

Agent-Conference MUST provide a `report_task_result` tool for Orchestrator-dispatched child runs. The tool SHALL accept `status`, `summary`, optional `acceptanceResults`, and optional `blockers`, and SHALL not create artifacts or mutate workspace files.

#### Scenario: Child reports completion
- **WHEN** a child run calls `report_task_result` with `status="complete"`
- **THEN** AgentRunner can use that structured report as the semantic task outcome.

#### Scenario: Child reports blocked work
- **WHEN** a child run calls `report_task_result` with `status="blocked"`
- **THEN** the dispatch task is treated as not complete
- **AND** blocker details remain available to aggregation.
