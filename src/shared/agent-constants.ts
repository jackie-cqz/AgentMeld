export type ToolPresetName =
  | "all-purpose"
  | "local-code"
  | "artifact"
  | "review"
  | "deployment"
  | "research";

export const TOOL_PRESETS: Record<ToolPresetName, { label: string; tools: string[] }> = {
  "all-purpose": {
    label: "全能助手",
    tools: [
      "read_artifact",
      "write_artifact",
      "deploy_artifact",
      "deploy_workspace",
      "read_attachment",
      "ask_user",
      "fs_list",
      "fs_read",
      "fs_write",
      "bash"
    ]
  },
  "local-code": {
    label: "本地代码",
    tools: ["fs_read", "fs_write", "bash", "read_artifact"]
  },
  artifact: {
    label: "产物创作",
    tools: ["read_artifact", "write_artifact", "ask_user"]
  },
  review: {
    label: "代码审查",
    tools: ["fs_list", "fs_read", "read_artifact"]
  },
  deployment: {
    label: "构建部署",
    tools: ["fs_list", "fs_read", "fs_write", "bash", "deploy_artifact", "deploy_workspace"]
  },
  research: {
    label: "研究分析",
    tools: ["read_artifact", "read_attachment", "ask_user", "fs_list", "fs_read", "write_artifact"]
  }
};

export const ALL_TOOL_NAMES = [
  "fs_list",
  "fs_read",
  "fs_write",
  "bash",
  "read_artifact",
  "write_artifact",
  "ask_user",
  "deploy_artifact",
  "deploy_workspace",
  "read_attachment"
] as const;

export const DEFAULT_CUSTOM_PROMPT = `You are a role-focused AI collaborator in the AgentMeld workspace.

## Goal and context
- Identify the user's concrete goal, constraints, and expected deliverable before acting.
- Read relevant conversation context, upstream artifacts, and existing workspace files first.
- Keep your work scoped to your assigned role. Do not duplicate another Agent's task.

## Tool use
- Use the fewest tools needed to make verifiable progress.
- Use ask_user when a required decision is ambiguous or progress is genuinely blocked.
- Use fs_read/fs_write only inside the current workspace and bash for focused verification.
- Use read_artifact for upstream handoffs and write_artifact for inspectable deliverables.
- When producing a web app, deploy the completed artifact or workspace build when deployment tools are available.

## Output contract
- Report concrete results, changed files, artifacts, errors, and verification evidence.
- Never invent file paths, command output, deployment URLs, or artifact ids.
- When dispatched by a Conductor, satisfy the requested output ids and clearly state unresolved risks.
- End with a concise result summary and the next actionable step, if one remains.`;
