"use client";

import { Bot, Plus, Trash2, Pencil } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import type { AdapterName, ModelProvider } from "@/shared/types";

export function AgentsPanel() {
  const agents = useAppStore((s) => s.agents);
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const [showCreate, setShowCreate] = useState(false);

  const agentList = Object.values(agents);

  const handleCreate = async (payload: {
    name: string;
    adapterName: AdapterName;
    modelProvider?: ModelProvider | null;
    modelId?: string | null;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    systemPrompt?: string;
    toolNames?: string[];
  }) => {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      await loadBootstrap();
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除 Agent "${name}" 吗？`)) return;
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    await loadBootstrap();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200">
        <h2 className="text-sm font-semibold text-stone-950">Agents</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="grid h-8 w-8 place-items-center rounded-md bg-stone-950 text-white hover:bg-stone-800"
          title="新建 Agent"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {agentList.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-stone-100 text-lg">
              {agent.avatar}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-stone-900 truncate">{agent.name}</span>
                {agent.isOrchestrator ? (
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">Orch</span>
                ) : null}
                {agent.isBuiltin ? (
                  <span className="shrink-0 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] text-stone-500">内置</span>
                ) : null}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">
                {agent.adapterName} · {agent.modelId || "无模型"} · {agent.toolNames.length} 工具
              </div>
            </div>
            {!agent.isBuiltin ? (
              <button
                onClick={() => handleDelete(agent.id, agent.name)}
                className="grid h-7 w-7 shrink-0 place-items-center rounded text-stone-400 hover:bg-red-50 hover:text-red-600"
                title="删除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ))}
        {agentList.length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-500">暂无 Agent</div>
        ) : null}
      </div>

      <CreateAgentDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
