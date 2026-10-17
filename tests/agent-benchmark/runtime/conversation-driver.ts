import * as fs from "node:fs";
import * as path from "node:path";

import { createConversation, sendMessage } from "@/server/conversation-service";
import { updateAgent } from "@/server/agent-service";
import { getWorkspaceForConversation, listAgents } from "@/server/repositories";
import type {
  AgentBenchmarkCase,
  BenchmarkRole,
  BenchmarkWorkspaceFile,
} from "@/server/context-metrics/benchmark-types";
import type { Agent, Conversation, Workspace } from "@/shared/types";
import {
  captureMutationBaselines,
  prepareBenchmarkAssetBundle,
  seedBenchmarkAssetBundle,
  type BenchmarkMutationBaselines,
} from "./benchmark-assets";

const BUILTIN_ROLE_AGENT_IDS: Record<BenchmarkRole, string> = {
  conductor: "ag_mock_conductor",
  pm: "ag_pm",
  ui: "ag_designer",
  frontend: "ag_mock_builder",
  reviewer: "ag_reviewer",
};

export interface BenchmarkConversationStart {
  conversationId: string;
  conductorRunId: string;
  triggerMessageId: string;
  workspacePath: string;
  agentIds: string[];
  roleAgentIds: Partial<Record<BenchmarkRole, string>>;
  mutationBaselines?: BenchmarkMutationBaselines;
}

interface ConversationDriverDependencies {
  listAgents: typeof listAgents;
  createConversation: typeof createConversation;
  sendMessage: typeof sendMessage;
  getWorkspaceForConversation: typeof getWorkspaceForConversation;
}

const defaultDependencies: ConversationDriverDependencies = {
  listAgents,
  createConversation,
  sendMessage,
  getWorkspaceForConversation,
};

export class ConversationDriver {
  constructor(private readonly dependencies: ConversationDriverDependencies = defaultDependencies) {}

  async startCase(benchmarkCase: AgentBenchmarkCase): Promise<BenchmarkConversationStart> {
    const agents = this.dependencies.listAgents();
    const roleAgentIds = resolveRoleAgentIds(benchmarkCase.expectedRoles, agents);
    const conductorId = resolveAgentId("conductor", agents);
    roleAgentIds.conductor = conductorId;
    const agentIds = [...new Set([conductorId, ...Object.values(roleAgentIds)])];

    if (agentIds.length < 2) {
      throw new Error(`Benchmark case ${benchmarkCase.id} requires at least one worker role in addition to Conductor.`);
    }

    // Fixture-owned window: both context modes must be measured against the
    // same configured window or their results are not comparable.
    const contextWindow = benchmarkCase.runtime?.contextWindow;
    if (contextWindow !== undefined) {
      for (const agentId of agentIds) updateAgent(agentId, { contextWindow });
    }

    const conversation: Conversation = this.dependencies.createConversation({
      title: `[Benchmark] ${benchmarkCase.title}`,
      mode: "group",
      agentIds,
      fsWriteApprovalMode: benchmarkCase.runtime?.fsWriteApprovalMode ?? "auto",
      contextMode: benchmarkCase.runtime?.contextMode,
    });
    const workspace: Workspace | null = this.dependencies.getWorkspaceForConversation(conversation.id);
    if (!workspace) throw new Error(`Workspace was not created for conversation ${conversation.id}.`);
    const workspacePath = workspace.boundPath ?? workspace.rootPath;
    prepareBenchmarkAssetBundle(benchmarkCase.runtime?.assetBundle);
    seedBenchmarkAssetBundle(workspacePath, benchmarkCase.runtime?.assetBundle);
    seedBenchmarkWorkspace(workspacePath, benchmarkCase.runtime?.workspaceFiles ?? []);
    const mutationBaselines = captureMutationBaselines(workspacePath, benchmarkCase);

    const response = await this.dependencies.sendMessage({
      origin: "human",
      conversationId: conversation.id,
      content: benchmarkCase.prompt,
    });
    if (response.runIds.length !== 1) {
      throw new Error(`Expected one Conductor run for ${benchmarkCase.id}, received ${response.runIds.length}.`);
    }

    return {
      conversationId: conversation.id,
      conductorRunId: response.runIds[0],
      triggerMessageId: response.message.id,
      workspacePath,
      agentIds,
      roleAgentIds,
      mutationBaselines,
    };
  }
}

export function seedBenchmarkWorkspace(
  workspacePath: string,
  files: BenchmarkWorkspaceFile[],
): void {
  const root = path.resolve(workspacePath);
  for (const file of files) {
    const target = path.resolve(root, file.path);
    const relative = path.relative(root, target);
    if (
      relative === ""
      || relative.startsWith("..")
      || path.isAbsolute(relative)
    ) {
      throw new Error(`Benchmark workspace file escapes the workspace: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf-8");
  }
}

export function resolveRoleAgentIds(
  roles: BenchmarkRole[],
  agents: Agent[],
): Partial<Record<BenchmarkRole, string>> {
  const result: Partial<Record<BenchmarkRole, string>> = {};
  for (const role of roles) result[role] = resolveAgentId(role, agents);
  return result;
}

function resolveAgentId(role: BenchmarkRole, agents: Agent[]): string {
  const builtinId = BUILTIN_ROLE_AGENT_IDS[role];
  const builtin = agents.find((agent) => agent.id === builtinId);
  if (builtin) return builtin.id;

  const fallback = agents.find((agent) => matchesRole(agent, role));
  if (!fallback) throw new Error(`No Agent is available for benchmark role ${role}.`);
  return fallback.id;
}

function matchesRole(agent: Agent, role: BenchmarkRole): boolean {
  if (role === "conductor") return agent.isConductor;
  const text = `${agent.id} ${agent.name} ${agent.description} ${agent.capabilities.join(" ")}`.toLowerCase();
  const patterns: Record<Exclude<BenchmarkRole, "conductor">, RegExp> = {
    pm: /\bpm\b|product|产品/,
    ui: /\bui\b|\bux\b|design|设计/,
    frontend: /frontend|front-end|builder|前端/,
    reviewer: /review|\bqa\b|审查|评审/,
  };
  return patterns[role].test(text);
}
