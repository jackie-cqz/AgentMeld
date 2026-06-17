# Design

## Child Harness Loop

Each dispatched child task runs through bounded attempts:

1. Build the original sub-agent prompt.
2. Run the assigned child agent with `report_task_result` available.
3. Evaluate the report and managed tool evidence.
4. Run Agent-Conference-managed verification commands declared by `requiredCommands`.
5. If the task is incomplete but recoverable, run the same agent again with a continuation prompt that includes the previous failure, missing evidence, and command output.

The harness stops when the task passes, the child reports `blocked`, the parent is aborted, or the bounded attempt count is exhausted.

## Verification Commands

`requiredCommands` become executable verification contracts, not only self-reported evidence hints. Agent-Conference runs them with the same command safety policy as `bash`.

Each command can declare:

```ts
{
  command: string
  description?: string
  cwd?: string
  timeoutMs?: number
}
```

Commands run after a child attempt. Successful commands are recorded as run evidence; failures are returned to the continuation prompt.

## Bash Tool

`bash` accepts:

- `command`: required command string.
- `cwd`: optional workspace-relative directory, default workspace effective cwd.
- `timeoutMs`: optional timeout with bounded min/max.

The resolved `cwd` must stay inside the workspace effective cwd and must be a directory.

## Prepare Command Heuristic

For common generated projects, AgentRunner can prepend a local install command before a build/test command when the package manifest exists and dependencies are not installed:

- `package.json` + no `node_modules` in the command cwd -> `pnpm install`.

This is deliberately narrow. Maven/Gradle/npm ecosystem bootstrap beyond this remains explicit through `requiredCommands`.

## Aggregation Semantics

Aggregation remains a final summary stage. It must not be reached while there is a recoverable child-task failure and available harness attempts remain.
