# OpenCode Runtime

## Supported Boundary

AgentMeld pins **`@opencode-ai/sdk` 1.19.3** and **`opencode-ai` 1.19.3**. Install
with the repository lockfile (Node.js >=22.19.0). The driver resolves both from
this project's `node_modules`; `AGENTMELD_OPENCODE_CLI_PATH` can point at a
packaged CLI elsewhere, but a version that does not match the pin is reported as
`version_mismatch`, not silently accepted.

`opencode-ai` installs a platform-specific binary through its postinstall step,
which is allowlisted in `pnpm-workspace.yaml`. A package whose postinstall never
ran is a stub that exits 1; `doctor()` reports the engine as unavailable rather
than installed.

## What Runs

`src/server/harness/opencode-driver.ts` starts one `opencode serve` process per
invocation and talks to it through the pinned SDK:

1. `doctor()` executes `opencode --version` and requires the pinned version.
2. The platform workspace lease is acquired (`acquireWorkspaceLease`, owner
   `"OpenCode"`), the server process id is attached, and every cleanup path
   asserts or releases it. Teardown is confirmed for the whole process group
   before the lease is released; otherwise the lease is poisoned.
3. OpenCode receives the platform provider target as its own config document,
   written to a per-run file inside the isolated XDG home and named by
   `OPENCODE_CONFIG`: a custom `agentmeld` provider backed by
   `@ai-sdk/openai-compatible` (or `@ai-sdk/anthropic` for Anthropic endpoints),
   the resolved model, base URL, credential and the Agent's vision/thinking
   flags. A model `limit` is sent only when the Agent actually configures a
   context window; the driver does not invent a platform-wide number.
4. The server runs in an isolated XDG home under the AgentMeld data directory,
   so a user's own OpenCode sessions, credentials and database are not read.
   OpenCode installs its plugin runtime into `$XDG_CONFIG_HOME/opencode`, so
   that home is kept across runs (it is a cache, not per-run state); only the
   config document is per-run and is deleted when the engine stops.
   `AGENTMELD_OPENCODE_HOME` can point the engine home elsewhere (a packaged
   build, or the end-to-end test's persistent cache); production leaves it unset
   and uses `getDataDir()/opencode`.
5. The platform system prompt goes into OpenCode's `system` field; the compiled
   context packet is rendered by `src/server/harness/opencode-packet.ts` and sent
   as the prompt, with in-workspace attachments as file parts.
6. A session is created, the SSE event stream is subscribed **before** the prompt
   is enqueued, and message/part events are projected into neutral
   `HarnessEvent`s (`src/server/harness/opencode-events.ts`).

## How the config reaches the CLI (verified against 1.19.3)

OpenCode 1.19.3 has no `--config` flag. Run with `--print-logs --log-level=DEBUG`
in a scratch directory, the pinned binary reports what it reads:

```text
level=INFO  message=loading path=$XDG_CONFIG_HOME/opencode/config.json
level=INFO  message=loading path=$XDG_CONFIG_HOME/opencode/opencode.json
level=INFO  message=loading path=$XDG_CONFIG_HOME/opencode/opencode.jsonc
level=INFO  message=creating instance directory=<session directory>
level=INFO  message=loading path=<session directory>/opencode.json   # project file
level=DEBUG message="loaded custom config" path=<OPENCODE_CONFIG file>
```

So the supported inputs are the global XDG files, the project `opencode.json`
walked up from the session directory, and the `OPENCODE_CONFIG` env var naming
one file (the driver's choice). The project file would mutate the user's
workspace; the global XDG file would be shared, and therefore racy, between
concurrent runs; `OPENCODE_CONFIG` is per-run and is what the driver uses. A
config is parsed when an instance for a session directory is created, so the
file only has to exist for the life of the run.

`OPENCODE_CONFIG_CONTENT` is also honoured by 1.19.3 (`loaded custom config from
OPENCODE_CONFIG_CONTENT`), but it is not used: one file per run keeps the
credential out of the process environment where native `bash` could read it.

## Business tools and native admission

- `src/server/harness/opencode-mcp.ts` owns the invocation's neutral
  `HarnessToolBridge` behind a loopback HTTP endpoint (random port, bearer
  token, revoked at teardown).
- `src/server/harness/opencode-mcp-server.mjs` is a stdio MCP server that
  OpenCode spawns from the `mcp` entry in the config; it advertises the bridge
  catalogue and relays `tools/call` (the model sees `agentmeld_<tool>`), so no
  tool semantics are reimplemented.
- `src/server/harness/opencode-evidence-plugin.mjs` is loaded through the
  config's `plugin` entry and uses OpenCode's `tool.execute.before` hook to send
  each native call (name, target path, proposed bytes) to the bridge before it
  runs. Outcomes are completed by the driver from the event stream, which also
  covers refused and failed calls.

Both halves report readiness to the bridge (`POST /ready`). The driver enqueues
the prompt and then waits for those reports; a transport that never reports
fails the run (`extension_unavailable`) instead of letting the model run
without business tools or without native admission.

Note: the first run in a fresh isolated home makes OpenCode fetch its plugin
runtime (`@opencode-ai/plugin`) from npm, which needs network once. After that
the home caches it.

## Event Mapping

| OpenCode event | Neutral event |
| --- | --- |
| assistant `text` part snapshot / `reasoning` part | `output.start` + `output.delta` (`text` / `thinking`) |
| part `time.end`, message completed, `session.idle` | `output.end` |
| `tool` part pending → running → completed/error | one `tool.call`, one `tool.result` |
| assistant message tokens | `run.usage` |
| `session.error` / assistant `error` | terminal `HarnessError` |
| `session.idle` | run settles successfully |

OpenCode usually updates a text part with a growing snapshot and omits
`properties.delta`; the projection derives the appended suffix from the previous
snapshot. A part whose message role has not arrived yet is buffered, and the
platform's own prompt echoed back as a user message is never projected. A
`pending` tool call is held until arguments are parsed so `tool.call` carries the
real input.

## Honest Capability Declaration

| Capability | Value | Why |
| --- | --- | --- |
| `nativeTools` | `true` | OpenCode runs its own read/write/edit/bash/grep/glob toolset. |
| `businessTools` | `true` | The `agentmeld` MCP server from the run config exposes the bridge catalogue to the model; verified end to end by `opencode-tools.e2e.test.ts`. |
| `evidence` | `true` | Native calls are admitted before execution and their outcomes are completed/hashed through the tool bridge; business-tool receipts take the same path. |
| `contextPacket` | `"platform"` | The platform packet is rendered into the prompt. |
| `cancellation` | `{ supported: true, mode: "signal" }` | The platform aborts its signal; the driver calls `session.abort` and tears down the process. There is no run-id abort registry. |
| `followUp` | `false` | No live steering channel is wired. |
| `streaming` | `true` | Part updates are projected incrementally. |

`assertHarnessSupports` therefore admits a normal Agent run. If a run is
provisioned with a tool the bridge does not know, that call is refused by the
bridge (never executed), exactly as on Pi.

## Verification

The unit suite (`opencode-events.test.ts`, `opencode-driver.test.ts`) covers event
mapping, the scripted invocation lifecycle, lease release/poisoning, config
mapping and the neutral error taxonomy.

`opencode-tools.test.ts` drives the real stdio MCP server and the real loopback
bridge (and the real Pi loopback transport) through one fixture, comparing
catalogue, results, evidence rows and refusal semantics.

`opencode-tools.e2e.test.ts` proves the whole chain with the real pinned CLI: a
scripted OpenAI-compatible provider asks for `write_artifact`, OpenCode exposes
`agentmeld_write_artifact` from the MCP server, the call crosses the bridge, and
the artifact binding plus `artifact_created` evidence land in the platform. It
also covers a native `write` (hash + `file_written` evidence) and a native
`bash` (`command_executed` evidence). It is skipped when the pinned OpenCode
install is not available, and the skip reason is printed at suite load. The
first run in a fresh engine home installs OpenCode's plugin runtime, so that
run is slower; the suite allows for it and caches the home between runs.

`opencode-driver.e2e.test.ts` starts a real `opencode serve` and makes a real
provider request. It is skipped unless all of the following are set:

```bash
OPENCODE_E2E_API_KEY=...      # a throwaway credential
OPENCODE_E2E_BASE_URL=...     # e.g. https://api.example.com/v1
OPENCODE_E2E_MODEL=...        # optional, defaults to deepseek-v4-flash
OPENCODE_E2E_PROVIDER=...     # optional, defaults to deepseek
```

The skip reason is printed at suite load. Set `OPENCODE_E2E_TRACE=1` to print the
neutral event trace.
