/**
 * What a built-in tool can actually reach (issue #24).
 *
 * The system prompt used to tell every agent the same thing — "this is an
 * isolated sandbox directory" — regardless of which tools it had. That is true
 * of the `fs_*` family (they are path-guarded to the workspace) and false the
 * moment `bash` is in the set: bash runs with the process user's privileges on
 * the real machine, and the workspace is only its starting directory.
 * `deploy_*` likewise writes OUTSIDE the workspace, to the configured publish
 * directory.
 *
 * Declaring this per tool means the prompt describes the tools the agent
 * actually has, and a new tool cannot be added without answering the question:
 * the registry test fails if any registered tool omits its capabilities.
 */

export type ToolCapability =
  /** Reads files inside the conversation workspace. */
  | "workspace-read"
  /** Writes files inside the conversation workspace (path-guarded). */
  | "workspace-write"
  /** Writes files outside the workspace (the configured publish directory). */
  | "outside-workspace-write"
  /** Runs commands on the host as the AgentMeld process user. */
  | "host-shell"
  /** Reads AgentMeld's own records: artifacts, attachments, evidence, context. */
  | "project-data-read"
  /** Writes AgentMeld's own records. */
  | "project-data-write"
  /** Blocks on a human answer. */
  | "user-interaction";

/**
 * The workspace's honest name for a given toolset.
 *
 * `confined` means every file-touching tool in the set is path-guarded to the
 * workspace. `host` means at least one tool reaches past it, and the prompt
 * must not pretend otherwise.
 */
export function workspaceModeFor(toolNames: readonly string[]): "confined" | "host" {
  const capabilities = capabilitiesOf(toolNames);
  return capabilities.has("host-shell") || capabilities.has("outside-workspace-write")
    ? "host"
    : "confined";
}

/**
 * The declaration table: one entry per built-in tool, keyed by tool name.
 *
 * This is the single source of truth for capabilities. Each ToolDef points at
 * its entry, and a test walks the registry to prove every registered tool has
 * one and that no entry is orphaned.
 */
export const TOOL_CAPABILITIES: Record<string, readonly ToolCapability[]> = {
  bash: ["host-shell", "workspace-read", "workspace-write"],
  fs_list: ["workspace-read"],
  fs_read: ["workspace-read"],
  fs_mkdir: ["workspace-write"],
  fs_write: ["workspace-read", "workspace-write"],
  fs_patch: ["workspace-read", "workspace-write"],
  read_artifact: ["project-data-read"],
  read_attachment: ["project-data-read"],
  // Reading evidence RECORDS the read (insertEvidence), so the declaration
  // carries the write too.
  read_evidence: ["project-data-read", "project-data-write"],
  write_artifact: ["project-data-write"],
  ask_user: ["user-interaction"],
  deploy_artifact: ["outside-workspace-write", "project-data-read"],
  deploy_workspace: ["workspace-read", "outside-workspace-write"],
  // The handler reads agents and returns a plan; it neither stores anything
  // nor blocks (approval happens on the platform side, not inside the tool).
  plan_tasks: ["project-data-read"],
  report_task_result: ["project-data-write"],
  update_context_facts: ["project-data-write"]
};

/** Union of the capabilities of the named tools. */
export function capabilitiesOf(toolNames: readonly string[]): Set<ToolCapability> {
  const found = new Set<ToolCapability>();
  for (const name of toolNames) {
    for (const capability of TOOL_CAPABILITIES[name] ?? []) found.add(capability);
  }
  return found;
}

/**
 * The `<workspace_info>` note, told truthfully for this toolset.
 *
 * Deliberately states what is NOT guaranteed: an agent told it is safe inside
 * a sandbox will happily read the user's home directory with bash and report
 * it as in-scope work.
 */
export function workspaceNoteFor(toolNames: readonly string[]): string[] {
  const capabilities = capabilitiesOf(toolNames);
  const lines: string[] = [
    "This directory belongs to this conversation; keep your work here."
  ];

  if (capabilities.has("workspace-read") || capabilities.has("workspace-write")) {
    lines.push(
      "The fs_* tools are path-guarded: they cannot read or write outside this directory."
    );
  }
  if (capabilities.has("host-shell")) {
    lines.push(
      "bash is NOT sandboxed. It runs commands on this machine as the AgentMeld process user, " +
        "and this directory is only its working directory — it can read and change files " +
        "anywhere that user can. Treat it as access to the host, not as a jail."
    );
  }
  if (capabilities.has("outside-workspace-write")) {
    lines.push(
      "deploy_* writes OUTSIDE this directory: into AgentMeld's own deployments " +
        "directory, and (when external publishing is on) into the configured publish directory."
    );
  }
  return lines;
}

/**
 * The whole `<workspace_info>` block, built from the toolset.
 *
 * One builder for all three prompt paths (direct run, conductor planning,
 * dispatched sub-task) so none of them can drift back to the old blanket
 * claim on its own — which is exactly what the third one did until a review
 * noticed only two were covered by tests.
 */
export function workspaceInfoBlock(toolNames: readonly string[], workspacePath: string): string {
  const note = workspaceNoteFor(toolNames)
    .map((line) => `    ${line}`)
    .join("\n");
  return `<workspace_info>
  <cwd>${workspacePath}</cwd>
  <mode>${workspaceModeLabel(toolNames)}</mode>
  <note>
${note}
  </note>
</workspace_info>`;
}

/** The `<mode>` value: what kind of reach the toolset gives. */
export function workspaceModeLabel(toolNames: readonly string[]): "workspace-confined" | "host-access" {
  return workspaceModeFor(toolNames) === "host" ? "host-access" : "workspace-confined";
}
