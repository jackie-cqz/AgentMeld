# Workspace Toolkit

AgentMeld exposes these tools to every Pi-backed Agent. They are not gated by a per-Agent tool permission or a tool preset: Agents run with the full native toolset, and tools Pi does not provide are registered as Pi extension tools. **System Prompt** is a separate tab. SDK adapters keep their own native tools; this is not an external MCP client.

Two platform tools are not part of an Agent run: the Conductor PLAN stage's `plan_tasks` protocol tool, and `list_team_members`, which returns the conversation roster. The roster is conversation-scoped, so it is provisioned only for the Conductor's PLAN stage and its handler refuses other callers; the editor lists it nowhere in the Agent toolset.

## Locate, Read, Edit

| Tool | Purpose | Limits |
| --- | --- | --- |
| `fs_glob` | Find paths with a file glob | Pi-native `find`; needs `fd` on PATH |
| `fs_search` | Literal text search with path, line and snippet | Pi-native `grep`; needs `rg` on PATH |
| `fs_read` | Read exact text or numbered line ranges | Pi-native `read`; `offset` / `limit` |
| `fs_patch` | Unique exact-text replacement in an existing file | Pi-native `edit`; file-size and quota limits, recorded as evidence |
| `fs_write` | Create or intentionally replace a complete file | Pi-native `write`; file-size and quota limits, recorded as evidence |

The read and search tools are Pi-native (`read`, `grep`, `find`), so their filtering and ignore behavior is Pi's behavior, not the retired platform tools'. They do not deny credential files or `.git` internals, and they are not confined to the workspace: `read` can open a real `.env`. The native `write` and `edit` tools behave the same way: a relative path resolves against the workspace root, but a path that leaves the workspace (`..`, an absolute path, or a symlinked-out directory) is resolved rather than refused. What still applies to a change is the file-size limit, workspace-quota accounting, the review/approval mode and evidence recording. Credential handling is therefore an operator responsibility rather than a tool guarantee. This is a capability description, not an OS-level sandbox for arbitrary project code.

`fs_mkdir` is the one platform filesystem handler an Agent can still reach: Pi has no native `mkdir`, so it stays a registered extension tool (unlike `fs_read` / `fs_write` / `fs_patch` / `fs_list`, which the bridge serves with Pi-native tools and never routes to their platform handlers). It resolves its path the same way the native tools do and is not confined to the workspace either.

Arguments are Pi's native arguments, not the retired platform schemas: `read` uses `offset` and `limit`, `grep` takes a `pattern`, and `edit` takes a `path` plus `oldText`/`newText` pairs. `startLine`, `includeLineNumbers`, `hasMore`, `nextStartLine`, `nextStartColumn`, `contentHash` and `replaceAll` are not native arguments. Pi computes the edit itself, and the platform records the resulting file change as evidence. Re-read after another writer changes a file.

```json
{"path":"src/App.tsx","edits":[{"oldText":"onSubmit","newText":"handleSubmit"}]}
```

## Background Verification

The legacy `job_start`, `job_read`, `job_wait`, and `job_cancel` background kernel is not exposed under the Pi runtime; long verification uses native `bash` and waits for its terminal result. Native `bash` is unrestricted apart from timeout and output limits, and shell commands may create or change source files. Declared project scripts execute project code with the server user's OS permissions and are not sandboxed; use trusted workspaces or a separate sandbox for untrusted projects.

The job mechanics below are retained only for historical job display and platform
cleanup. A Pi Agent cannot call them: run the command with native `bash` and let it
finish, bounded by the command timeout.

```json
{"command":"npm run build","timeoutMs":300000}
```

Starting a job returned `jobId` and `status: running`, **not successful
verification**. Polling with `job_wait` (up to 30 seconds per call) exposed the
terminal `exitCode`, and logs were read with `offset` / `nextOffset`. A nonzero,
missing, cancelled or timed-out exit code was never success. Completed command
evidence was written before the terminal result became visible. Job status
observations did not count as command-success evidence.

- Ownership: exact conversation, Agent, run and workspace; no cross-run log/control access.
- Limits: 2 concurrent jobs per run, 8 total; default 5-minute / maximum 10-minute lifetime; 200,000 retained output characters, 10,000 per read; up to 64 retained jobs.
- The job tools no longer form a permission family; they are retired under Pi, so there is nothing for the UI to select together.
- Cancellation killed the process tree. Ending a run cleaned up remaining jobs and failed incomplete verification instead of claiming success.
- Jobs were process-local, not durable workers. Normal process exit attempted to terminate active children. A server restart lost job IDs; it did not resume work. An OS-level hard kill/crash could not guarantee child cleanup; production isolation still needs a managed Worker/container. Output was bounded, not a persistent complete log archive.

## Public Web Research

`web_fetch` accepts a public HTTP(S) URL and extracts readable HTML/plain text/JSON without running scripts. It returns retrieval time, final URL and a source hash. Responses are limited to 1 MiB and 30,000 displayed characters.

`web_search` uses [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started). Set `AGENTMELD_BRAVE_SEARCH_API_KEY` in the server environment and restart. No LLM provider key is reused. Missing configuration produces an explicit error, not fabricated search results. Search queries are sent to that provider: never include secrets, private code or personal data. Known URLs can still be read with `web_fetch` without a search key.

The fetcher validates all DNS answers, pins the vetted address to the socket, checks every redirect, rejects credentials/nonstandard ports and blocks loopback, private, link-local, metadata and reserved addresses. Authenticated provider requests never follow redirects. No browser cookies or model credentials are forwarded. Fetched text and search snippets are **untrusted source data**, not instructions; their evidence is marked `reported`, not a verified semantic fact.

Proxy fake-IP DNS (often `198.18.0.0/15`) is intentionally rejected as reserved space. Configure real public DNS for the server instead of weakening the private-network boundary. Server egress must permit direct HTTPS to the validated public destination; authenticated/corporate proxy transport is not implemented in this version.

## Read-only Git

`git_inspect` accepts `action: status | diff | log`, a repository-directory `path`, optional `staged` for diff and `limit` for log. It uses fixed argv, bounded output/time, and disables hooks, fsmonitor, external diff, textconv, signatures, prompts and global/system Git config. It never stages, commits, resets, checks out or pushes.

The repository must have a physical `.git` directory inside the workspace. Host repositories above a generated workspace, symlinked repositories and linked external worktrees are rejected. The inspected directory `path` is resolved as given and is not refused for leaving the workspace; the workspace-owned-repository rule is the tool's definition (its search is clamped to the workspace root and its report is workspace-relative), not a per-Agent capability grant. Repository config includes are not supported, and external attributes/ignore files are disabled. Linked-worktree support would need explicit repository ownership authorization; it is not implied by a path string.

## Static Web App Acceptance

`browser_check` serves a directory containing `index.html` temporarily, launches a fresh headless Chromium context, runs explicit interactions, and returns a screenshot plus console/page/network errors. The directory is resolved as given and is not confined to the workspace; the temporary server itself still serves only that directory. No arbitrary target URL, shell command, JavaScript evaluation or existing browser profile is accepted.

Install a browser with `pnpm exec playwright install chromium`, or configure `AGENTMELD_BROWSER_EXECUTABLE_PATH` to an installed Chrome/Chromium executable. Windows detects standard Chrome automatically. Browser binaries are not downloaded during a tool call.

```json
{
  "path":"todo-app/dist",
  "viewport":"mobile",
  "steps":[
    {"action":"fill","selector":"#task-input","value":"Review release"},
    {"action":"click","selector":"button[type=submit]"},
    {"action":"assert_text","selector":"#tasks","value":"Review release"},
    {"action":"reload"},
    {"action":"assert_text","selector":"#tasks","value":"Review release"}
  ]
}
```

Selectors use Playwright locator syntax for interactions; `assert_text` uses CSS selectors. At most 20 steps, 2 concurrent checks, a 30-second post-launch deadline, 3-second interaction timeouts, and desktop/mobile viewports. This first version is for **offline static builds**: all requests outside its temporary origin, WebSockets, service workers, popups and downloads are blocked. Bundle CDN dependencies locally first. No AgentMeld browser session or user cookies are reused.

`passed` requires successful assertions, no captured errors/failed or blocked requests, no horizontal overflow and a nonempty DOM. It does not prove every feature works or judge visual aesthetics. The isolated temporary server is stopped after the check; screenshots are not deployment URLs. Screenshot PNGs are gated by the existing installation session and stored under the private data directory, retaining the most recent 100 (5 MiB maximum each).

Tool execution no longer checks a per-Agent admitted tool list: every Agent gets the full toolset. Operational observations are still added to the existing child-task Evidence Ledger; public-source content remains low-trust. Browser checks do not bypass a task's existing required command/artifact acceptance criteria.
