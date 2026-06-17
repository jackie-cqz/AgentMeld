# Proposal

## Problem

Long-running multi-agent work can still stop while the user goal is visibly incomplete. A child agent may end a run without `report_task_result`, omit required files, or skip dependency installation/build commands. AgentRunner currently treats that child attempt as failed, allows at most one replan round, and then aggregates even when the work is recoverable.

The result is not Claude Code-like execution: the system can identify gaps, but it does not keep driving the same task until completion or a real blocker.

## Scope

- Add a bounded child-task harness loop that retries/continues the same task when completion evidence is missing.
- Let Agent-Conference run required verification commands after child attempts, including dependency-install/build commands.
- Extend `bash` with workspace-scoped `cwd` and configurable timeout support.
- Extend dispatch task command contracts with `cwd` and `timeoutMs`.
- Keep the loop bounded and abortable; do not create an infinite uninterruptible process.

## Non-Goals

- No new external package dependencies.
- No DB schema migration.
- No broad UI redesign.
- No automatic arbitrary package installation unless declared by a task command or inferred as a safe local project prepare command.
