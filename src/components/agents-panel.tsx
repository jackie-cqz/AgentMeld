"use client";

import { LayoutGrid, List, Plus, Search, Trash2, Pencil } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList } from "@/stores/selectors";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { Modal } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { requestJson } from "@/lib/request-json";
import { AgentAvatar } from "@/components/agent-avatar";
import type { AdapterName, Agent, ModelProvider } from "@/shared/types";

export function AgentsPanel() {
  const agentList = useAppStore(useShallow(selectAgentList));
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);
  // Runtime truth (provisionedPlatformToolNames, served by /api/bootstrap):
  // identical for every Agent since issue #79, and the only tool surface the UI
  // shows. There is no per-Agent record to display or edit.
  const provisionedToolNames = useAppStore((s) => s.provisionedToolNames);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Agent | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adapter, setAdapter] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const visibleAgents = agentList.filter(agent => (!adapter || agent.adapterName === adapter) && `${agent.name} ${agent.description} ${agent.modelId ?? ""} ${agent.capabilities.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  const handleCreate = async (payload: {
    name: string;
    avatar?: string;
    description: string;
    capabilities?: string[];
    adapterName: AdapterName;
    modelProvider?: ModelProvider | null;
    modelId?: string | null;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    systemPrompt?: string;
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

      <div className="agent-library-filters">
        <label className="ui-search-field"><Search size={15} /><input aria-label="搜索 Agent" placeholder="搜索 Agent" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="筛选执行引擎" value={adapter} onChange={event => setAdapter(event.target.value)}><option value="">全部执行引擎</option>{[...new Set(agentList.map(agent => agent.adapterName))].map(name => <option key={name} value={name}>{name === "pi" ? "Pi" : `${name}（已退役）`}</option>)}</select>
        <div className="ui-segmented" role="group" aria-label="Agent 显示方式">{([{ value: "grid", label: "卡片视图", Icon: LayoutGrid }, { value: "list", label: "紧凑列表", Icon: List }] as const).map(({ value, label, Icon }) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={view === value} onClick={() => setView(value)}><Icon size={16} /></button>)}</div>
        <span className="ui-muted">{visibleAgents.length}/{agentList.length}</span>
      </div>
      <div className={`workspace-agent-grid ${view === "list" ? "is-list" : ""} flex-1 overflow-y-auto px-4 py-3 space-y-2`}>
        {visibleAgents.map((agent) => (
          <div
            key={agent.id}
            className="workspace-agent-row flex items-center gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
          >
            <button type="button" aria-label={`查看 ${agent.name} 的详情`} onClick={() => setViewingAgent(agent)} className="agent-avatar-button">
              <AgentAvatar agent={agent} />
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
              <p className="workspace-agent-description">{agent.description || "未填写职责描述"}</p>
              <div className="agent-library-config"><span title={`执行引擎 ${agent.adapterName}`}>{agent.adapterName === "pi" ? "Pi" : "待迁移"}</span><span title={`模型 ${agent.modelId || "未配置"}`}>{agent.modelId || "未配置模型"}</span><span title="运行时工具集：所有 Agent 相同">全部 {provisionedToolNames.length} 个工具</span></div>
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
        {visibleAgents.length === 0 ? (
          <div className="agent-library-empty py-8 text-center text-sm text-stone-500">{agentList.length === 0 ? "暂无 Agent" : "没有匹配的 Agent"}{agentList.length > 0 ? <button className="ui-button" onClick={() => { setQuery(""); setAdapter(""); }}>清除筛选</button> : null}</div>
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
        <p className="ui-muted">运行时工具集：全部 {provisionedToolNames.length} 个（所有 Agent 相同）</p>
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-stone-500">查看运行时工具集</summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {provisionedToolNames.map(tool => <span key={tool} className="rounded bg-[var(--ui-subtle)] px-1.5 py-0.5 font-mono text-[11px]">{tool}</span>)}
          </div>
        </details>
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
            avatar: editingAgent.avatar,
            isConductor: editingAgent.isConductor,
            description: editingAgent.description,
            capabilities: editingAgent.capabilities,
            adapterName: editingAgent.adapterName,
            modelProvider: editingAgent.modelProvider,
            modelId: editingAgent.modelId,
            apiKey: editingAgent.apiKey,
            apiBaseUrl: editingAgent.apiBaseUrl,
            systemPrompt: editingAgent.systemPrompt
          }}
        />
      ) : null}
    </div>
  );
}
