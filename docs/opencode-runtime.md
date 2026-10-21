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
3. OpenCode receives the platform provider target as its own config document
   (`OPENCODE_CONFIG_CONTENT`): a custom `agentmeld` provider backed by
   `@ai-sdk/openai-compatible` (or `@ai-sdk/anthropic` for Anthropic endpoints),
   the resolved model, base URL, credential and the Agent's vision/thinking
   flags. A model `limit` is sent only when the Agent actually configures a
   context window; the driver does not invent a platform-wide number.
4. The server runs in an isolated XDG home under the AgentMeld data directory,
   so a user's own OpenCode sessions, credentials and database are not read.
5. The platform system prompt goes into OpenCode's `system` field; the compiled
   context packet is rendered by `src/server/harness/opencode-packet.ts` and sent
   as the prompt, with in-workspace attachments as file parts.
6. A session is created, the SSE event stream is subscribed **before** the prompt
   is enqueued, and message/part events are projected into neutral
   `HarnessEvent`s (`src/server/harness/opencode-events.ts`).

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
| `businessTools` | `false` | No platform business-tool transport is wired for OpenCode. |
| `evidence` | `false` | Native outcomes are visible as events but are not admitted/hashed by the platform tool bridge. |
| `contextPacket` | `"platform"` | The platform packet is rendered into the prompt. |
| `cancellation` | `{ supported: true, mode: "signal" }` | The platform aborts its signal; the driver calls `session.abort` and tears down the process. There is no run-id abort registry. |
| `followUp` | `false` | No live steering channel is wired. |
| `streaming` | `true` | Part updates are projected incrementally. |

Because `businessTools` and `evidence` are false, `assertHarnessSupports` refuses
a normal Agent run (which is provisioned with the full platform toolset) with
`harness_capability` **before** OpenCode starts. This is deliberate: producing
artifacts the platform cannot verify would be worse than refusing to run. Context-
only invocations (empty tool provisioning, e.g. turn classification) and direct
driver invocations do run, and they are the paths the end-to-end test covers.

## Verification

The unit suite (`opencode-events.test.ts`, `opencode-driver.test.ts`) covers event
mapping, the scripted invocation lifecycle, lease release/poisoning, config
mapping and the neutral error taxonomy.

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
