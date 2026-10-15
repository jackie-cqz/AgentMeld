"use client";

import { Plus, Trash2, Pencil } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList } from "@/stores/selectors";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { Modal } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarLabel, getAgentAvatarStyle } from "@/shared/agent-avatar";
import type { AdapterName, Agent, ModelProvider } from "@/shared/types";

export function AgentsPanel() {
  const agentList = useAppStore(useShallow(selectAgentList));
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Agent | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (payload: {
    name: string;
    description: string;
    capabilities?: string[];
    adapterName: AdapterName;
    modelProvider?: ModelProvider | null;
    modelId?: string | null;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    systemPrompt?: string;
    toolNames?: string[];
  }) => {
    setError(null);
    await requestJson("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await loadBootstrap();
  };

  const handleUpdate = async (payload: Parameters<typeof handleCreate>[0]) => {
    if (!editingAgent) return;
    setError(null);
    await requestJson(`/api/agents/${editingAgent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await loadBootstrap();
    setEditingAgent(null);
  };

  const handleDelete = async (id: string) => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await requestJson(`/api/agents/${id}`, { method: "DELETE" });
      await loadBootstrap();
      setDeletingAgent(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除 Agent 失败。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="workspace-agent-library flex h-full flex-col">
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

      <div className="workspace-agent-grid flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {agentList.map((agent) => (
          <div
            key={agent.id}
            className="workspace-agent-row flex items-center gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
          >
            <button type="button" aria-label={`查看 ${agent.name} 的详情`} onClick={() => setViewingAgent(agent)} className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm ${getAgentAvatarStyle(agent).solid}`}>
              {getAgentAvatarLabel(agent)}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span title={agent.name} className="text-sm font-medium text-stone-900 truncate">{agent.name}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {agent.isConductor ? (
                  <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700">Conductor</span>
                ) : null}
                {agent.isBuiltin ? (
                  <span className="shrink-0 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] text-stone-500">内置</span>
                ) : null}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">
                {agent.adapterName} · {agent.modelId || "无模型"} · {agent.toolNames.length} 工具
              </div>
              <p className="workspace-agent-description">{agent.description || "未填写职责描述"}</p>
            </div>
            <button
              type="button"
              onClick={() => setEditingAgent(agent)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-stone-400 hover:bg-blue-50 hover:text-blue-600"
              title="编辑"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {!agent.isBuiltin ? (
              <button
                onClick={() => { setError(null); setDeletingAgent(agent); }}
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
        {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div> : null}
      </div>

      <CreateAgentDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
      />
      {viewingAgent ? <Modal open onClose={() => setViewingAgent(null)} title={viewingAgent.name} size="small"
        footer={<button className="ui-button ui-button--primary" onClick={() => { setEditingAgent(viewingAgent); setViewingAgent(null); }}><Pencil size={15} />编辑配置</button>}>
        <p className="text-sm leading-6">{viewingAgent.description || "未填写 Agent 描述"}</p>
        <div className="my-4 flex flex-wrap gap-2">{viewingAgent.capabilities.map(tag => <span key={tag} className="rounded bg-[var(--ui-subtle)] px-2 py-1 text-xs">{tag}</span>)}</div>
        <p className="ui-muted">{viewingAgent.adapterName} · {viewingAgent.modelId || "未配置模型"}</p>
        <p className="ui-muted">已授权 {viewingAgent.toolNames.length} 个工具</p>
      </Modal> : null}
      {deletingAgent ? <Modal open onClose={() => setDeletingAgent(null)} title="删除 Agent？" size="small" busy={deleting}
        footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button" disabled={deleting} onClick={() => setDeletingAgent(null)}>取消</button>
          <button className="ui-button ui-button--danger" disabled={deleting} onClick={() => void handleDelete(deletingAgent.id)}>{deleting ? "删除中..." : "删除 Agent"}</button></>}>
        <p className="ui-muted">将删除「{deletingAgent.name}」。此操作无法撤销。</p>
      </Modal> : null}
      {editingAgent ? (
        <CreateAgentDialog
          key={editingAgent.id}
          open
          onClose={() => setEditingAgent(null)}
          onCreate={handleUpdate}
          initial={{
            name: editingAgent.name,
            description: editingAgent.description,
            capabilities: editingAgent.capabilities,
            adapterName: editingAgent.adapterName,
            modelProvider: editingAgent.modelProvider,
            modelId: editingAgent.modelId,
            apiKey: editingAgent.apiKey,
            apiBaseUrl: editingAgent.apiBaseUrl,
            systemPrompt: editingAgent.systemPrompt,
            toolNames: editingAgent.toolNames
          }}
        />
      ) : null}
    </div>
  );
}
