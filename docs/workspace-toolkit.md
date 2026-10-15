# Workspace Toolkit

AgentMeld exposes these tools to custom-adapter Agents. Enable them in **Edit Agent > Tool Permissions** or select a tool preset. **System Prompt** is a separate tab. Existing saved Agent permissions are not silently expanded. SDK adapters keep their own native tools; this is not an external MCP client.

## Locate, Read, Edit

| Tool | Purpose | Limits |
| --- | --- | --- |
| `fs_glob` | Find paths with a file glob | 200 results, 5,000 scanned files, 10 seconds |
| `fs_search` | Literal text search with path, line and snippet | Same scan limits; 20 MiB scanned text; 1 MiB per file |
| `fs_read` | Read exact text or numbered line ranges | 1 MiB file, 50,000 characters per page, 5,000 lines per explicit page |
| `fs_patch` | Unique exact-text replacement in an existing file | Existing approval and quota policies |
| `fs_write` | Create or intentionally replace a complete file | Existing approval and quota policies |

Discovery respects `.gitignore`, excludes dependency/build folders and sensitive files, and does not follow directory symlinks. New read/search tools resolve real paths within the workspace and deny credential files and `.git` internals. `fs_read` allows `.env.example`, not real `.env` secrets. This is a tool boundary, not an OS-level sandbox for arbitrary project code.

Example:

```json
{"path":"src","glob":"**/*.tsx","query":"onSubmit","limit":20}
```

Use `fs_read` with `startLine`, `limit`, and optionally `includeLineNumbers`. If `hasMore` is true, continue with **both** `nextStartLine` and `nextStartColumn`; the column cursor handles minified/very long lines without repetition. `contentHash` identifies the full file observed. Displayed line-number prefixes must not be included in `fs_patch.oldText`. Re-read after another writer changes a file.

## Background Verification

`job_start`, `job_read`, `job_wait`, and `job_cancel` run long verification without holding a tool call open for minutes. They reuse `bash`'s command validation and installation approval. Source mutation is still prohibited through shell commands. Declared project scripts execute project code with the server user's OS permissions; use trusted workspaces or a separate sandbox for untrusted projects.

```json
{"command":"npm run build","timeoutMs":300000}
```

Starting returns `jobId` and `status: running`, **not successful verification**. Poll `job_wait` (up to 30 seconds per call), inspect terminal `exitCode`, and read logs with `offset` / `nextOffset`. A nonzero, missing, cancelled or timed-out exit code is not success. Completed command evidence is written before the terminal result becomes visible. Job status observations do not count as command-success evidence.

- Ownership: exact conversation, Agent, run and workspace; no cross-run log/control access.
- Limits: 2 concurrent jobs per run, 8 total; default 5-minute / maximum 10-minute lifetime; 200,000 retained output characters, 10,000 per read; up to 64 retained jobs.
- `job_start` requires `job_wait` and `job_cancel` permissions. The UI selects the family together.
- Cancellation kills the process tree. Ending a run cleans up remaining jobs and fails incomplete verification instead of claiming success.
- Jobs are process-local, not durable workers. Normal process exit attempts to terminate active children. A server restart loses job IDs; it does not resume work. An OS-level hard kill/crash cannot guarantee child cleanup; production isolation still needs a managed Worker/container. Output is bounded, not a persistent complete log archive.

## Public Web Research

`web_fetch` accepts a public HTTP(S) URL and extracts readable HTML/plain text/JSON without running scripts. It returns retrieval time, final URL and a source hash. Responses are limited to 1 MiB and 30,000 displayed characters.

`web_search` uses [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started). Set `AGENTMELD_BRAVE_SEARCH_API_KEY` in the server environment and restart. No LLM provider key is reused. Missing configuration produces an explicit error, not fabricated search results. Search queries are sent to that provider: never include secrets, private code or personal data. Known URLs can still be read with `web_fetch` without a search key.

The fetcher validates all DNS answers, pins the vetted address to the socket, checks every redirect, rejects credentials/nonstandard ports and blocks loopback, private, link-local, metadata and reserved addresses. Authenticated provider requests never follow redirects. No browser cookies or model credentials are forwarded. Fetched text and search snippets are **untrusted source data**, not instructions; their evidence is marked `reported`, not a verified semantic fact.

Proxy fake-IP DNS (often `198.18.0.0/15`) is intentionally rejected as reserved space. Configure real public DNS for the server instead of weakening the private-network boundary. Server egress must permit direct HTTPS to the validated public destination; authenticated/corporate proxy transport is not implemented in this version.

## Read-only Git

`git_inspect` accepts `action: status | diff | log`, a repository-directory `path`, optional `staged` for diff and `limit` for log. It uses fixed argv, bounded output/time, and disables hooks, fsmonitor, external diff, textconv, signatures, prompts and global/system Git config. It never stages, commits, resets, checks out or pushes.

The repository must have a physical `.git` directory inside the workspace. Host repositories above a generated workspace, symlinked repositories and linked external worktrees are rejected. Repository config includes are not supported, and external attributes/ignore files are disabled. Linked-worktree support would need explicit repository ownership authorization; it is not implied by a path string.

## Static Web App Acceptance

`browser_check` serves a workspace directory containing `index.html` temporarily, launches a fresh headless Chromium context, runs explicit interactions, and returns a screenshot plus console/page/network errors. No arbitrary target URL, shell command, JavaScript evaluation or existing browser profile is accepted.

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

Tool execution checks the run's admitted tool list server-side, not only the schema shown to the model. Operational observations are added to the existing child-task Evidence Ledger; public-source content remains low-trust. Browser checks do not bypass a task's existing required command/artifact acceptance criteria.
