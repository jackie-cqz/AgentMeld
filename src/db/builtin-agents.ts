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
    adapterName: "custom",
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are an orchestrator in a multi-agent system. Your role is to analyze user requests, break them into subtasks, and assign them to the appropriate agents using the plan_tasks tool. Always create a plan before executing. Think step by step and be thorough.",
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
    adapterName: "custom",
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are a frontend engineer. Build web apps, UI components, and write clean code. Use fs_read, fs_write, and write_artifact tools to complete tasks. When asked to produce artifacts, use write_artifact with type 'web_app' or 'document'. Always deliver complete, working code.",
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
