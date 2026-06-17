import type { AdapterName, ModelProvider } from "@/shared/types";

export interface BuiltinAgentSeed {
  id: string;
  name: string;
  avatar: string;
  description: string;
  capabilities: string[];
  adapterName: AdapterName;
  modelProvider: ModelProvider | null;
  modelId: string | null;
  apiKey: string | null;
  apiBaseUrl: string | null;
  systemPrompt: string;
  toolNames: string[];
  isBuiltin: boolean;
  isOrchestrator: boolean;
  supportsVision: boolean;
}

export const BUILTIN_AGENTS: BuiltinAgentSeed[] = [
  {
    id: "ag_mock_orchestrator",
    name: "Orchestrator",
    avatar: "🧭",
    description: "群里的项目经理，负责拆解任务、协调 Agent 和聚合结果。",
    capabilities: ["planning", "coordination", "review"],
    adapterName: "mock",
    modelProvider: null,
    modelId: "mock-orchestrator",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You coordinate multi-agent work and summarize progress clearly.",
    toolNames: ["plan_tasks", "report_task_result"],
    isBuiltin: true,
    isOrchestrator: true,
    supportsVision: false
  },
  {
    id: "ag_mock_builder",
    name: "前端工程师",
    avatar: "🛠️",
    description: "负责实现界面、组件和本地 Web 应用。",
    capabilities: ["react", "frontend", "web_app"],
    adapterName: "mock",
    modelProvider: null,
    modelId: "mock-builder",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You help build the frontend workspace.",
    toolNames: ["fs_read", "fs_write", "write_artifact"],
    isBuiltin: true,
    isOrchestrator: false,
    supportsVision: false
  },
  {
    id: "ag_custom_assistant",
    name: "Custom Agent",
    avatar: "✨",
    description: "自定义 OpenAI provider Agent 模板，用于后续接入真实模型。",
    capabilities: ["general", "custom-provider"],
    adapterName: "custom",
    modelProvider: "openai",
    modelId: "gpt-4.1-mini",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are a configurable custom assistant.",
    toolNames: ["write_artifact"],
    isBuiltin: true,
    isOrchestrator: false,
    supportsVision: true
  }
];
