export type ToolPresetName = "all-purpose" | "local-code" | "artifact" | "review";

export const TOOL_PRESETS: Record<ToolPresetName, { label: string; tools: string[] }> = {
  "all-purpose": {
    label: "全能助手",
    tools: ["read_artifact", "write_artifact", "fs_read", "fs_write", "bash"]
  },
  "local-code": {
    label: "本地代码",
    tools: ["fs_read", "fs_write", "bash", "read_artifact"]
  },
  artifact: {
    label: "产物创作",
    tools: ["read_artifact", "write_artifact"]
  },
  review: {
    label: "代码审查",
    tools: ["fs_list", "fs_read", "read_artifact"]
  }
};

export const ALL_TOOL_NAMES = [
  "fs_list",
  "fs_read",
  "fs_write",
  "bash",
  "read_artifact",
  "write_artifact"
] as const;

export const DEFAULT_CUSTOM_PROMPT = `You are a helpful AI assistant working in the Agent-Conference workspace. You have access to file system and artifact tools to help complete tasks.

Important rules:
- Use fs_read and fs_write to work with files in the workspace.
- Use write_artifact to create deliverable documents, web apps, or presentations.
- Use read_artifact to reference previously created artifacts.
- Always explain your reasoning before making changes.
- When creating artifacts, provide complete content — never call write_artifact with empty arguments.`;
