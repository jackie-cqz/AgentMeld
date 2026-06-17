"use client";

import { BarChart3, Bot, FileText, MessageSquare, Plus, Search, Settings, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AgentsPanel } from "@/components/agents-panel";
import { SettingsDialog } from "@/components/settings-dialog";
import { useAppStore } from "@/stores/app-store";
import type { Agent } from "@/shared/types";

type SidebarTab = "conversations" | "artifacts" | "agents" | "analytics";

export function Sidebar() {
  const agents = useAppStore((state) => state.agents);
  const conversations = useAppStore((state) => state.conversations);
  const conversationOrder = useAppStore((state) => state.conversationOrder);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const setActiveConversation = useAppStore((state) => state.setActiveConversation);
  const createConversation = useAppStore((state) => state.createConversation);
  const [activeTab, setActiveTab] = useState<SidebarTab>("conversations");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const orderedConversations = useMemo(
    () => conversationOrder.map((id) => conversations[id]).filter(Boolean),
    [conversationOrder, conversations]
  );

  return (
    <aside className="relative flex h-screen w-[292px] shrink-0 flex-col border-r border-stone-200 bg-[#f3f1ec]">
      <div className="flex h-16 items-center gap-3 border-b border-stone-200 px-5">
        <button
          onClick={() => setActiveTab("conversations")}
          className="grid h-9 w-9 place-items-center rounded-md bg-stone-950 text-white"
        >
          <Sparkles className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="text-base font-semibold text-stone-950">Agent-Conference</div>
          <div className="text-xs text-stone-500">Agent 协作入口</div>
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="grid h-8 w-8 place-items-center rounded-md text-stone-500 hover:bg-stone-200"
          title="设置"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      <nav className="grid grid-cols-4 gap-1 px-3 py-3">
        <NavButton
          active={activeTab === "conversations"}
          icon={<MessageSquare className="h-4 w-4" />}
          label="对话"
          onClick={() => setActiveTab("conversations")}
        />
        <NavButton
          active={activeTab === "artifacts"}
          icon={<FileText className="h-4 w-4" />}
          label="产物"
          onClick={() => setActiveTab("artifacts")}
        />
        <NavButton
          active={activeTab === "agents"}
          icon={<Bot className="h-4 w-4" />}
          label="Agents"
          onClick={() => setActiveTab("agents")}
        />
        <NavButton
          active={activeTab === "analytics"}
          icon={<BarChart3 className="h-4 w-4" />}
          label="分析"
          onClick={() => setActiveTab("analytics")}
        />
      </nav>

      {activeTab === "conversations" ? (
        <>
          <div className="px-3">
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-stone-950 text-sm font-medium text-white transition hover:bg-stone-800"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              新建对话
            </button>
          </div>

          <label className="mx-3 mt-3 flex h-10 items-center gap-2 rounded-md border border-stone-200 bg-white px-3 text-sm text-stone-500">
            <Search className="h-4 w-4" />
            <input className="min-w-0 flex-1 bg-transparent outline-none" placeholder="搜索对话" />
          </label>

          <div className="mt-4 flex-1 overflow-y-auto px-3 pb-4">
            <div className="mb-2 px-1 text-xs font-medium uppercase text-stone-500">Conversations</div>
            <div className="space-y-2">
              {orderedConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`w-full rounded-md border px-3 py-3 text-left transition ${
                    conversation.id === activeConversationId
                      ? "border-stone-950 bg-white shadow-sm"
                      : "border-transparent bg-transparent hover:bg-white"
                  }`}
                  type="button"
                  onClick={() => {
                    setActiveConversation(conversation.id);
                    setActiveTab("conversations");
                  }}
                >
                  <div className="truncate text-sm font-medium text-stone-900">{conversation.title}</div>
                  <div className="mt-1 text-xs text-stone-500">
                    {conversation.mode === "group" ? "群聊" : "单聊"} · {conversation.agentIds.length} 位 Agent
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {conversation.agentIds.map((agentId) => (
                      <span key={agentId} className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] text-stone-700">
                        {agents[agentId]?.name ?? "Agent"}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : activeTab === "agents" ? (
        <AgentsPanel />
      ) : activeTab === "artifacts" ? (
        <div className="flex-1 grid place-items-center text-sm text-stone-500">
          产物库 — 开发中
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-sm text-stone-500">
          分析 — 开发中
        </div>
      )}

      {dialogOpen ? (
        <CreateConversationDialog
          agents={Object.values(agents)}
          onClose={() => setDialogOpen(false)}
          onCreate={(payload) =>
            void createConversation(payload).then(() => {
              setDialogOpen(false);
            })
          }
        />
      ) : null}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}

function CreateConversationDialog({
  agents,
  onClose,
  onCreate
}: {
  agents: Agent[];
  onClose: () => void;
  onCreate: (payload: {
    title?: string;
    mode: "single" | "group";
    agentIds: string[];
    fsWriteApprovalMode: "auto" | "review";
  }) => void;
}) {
  const defaultAgentIds = agents
    .filter((agent) => agent.isOrchestrator || agent.name.includes("前端"))
    .map((agent) => agent.id);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"single" | "group">("group");
  const [agentIds, setAgentIds] = useState<string[]>(defaultAgentIds.length >= 2 ? defaultAgentIds : agents.slice(0, 2).map((agent) => agent.id));
  const [approvalMode, setApprovalMode] = useState<"auto" | "review">("review");

  const valid = mode === "single" ? agentIds.length === 1 : agentIds.length >= 2;
  const toggleAgent = (agentId: string) => {
    setAgentIds((current) => {
      if (mode === "single") return [agentId];
      return current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId];
    });
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-stone-950/20 px-4">
      <div className="w-full max-w-[264px] rounded-md border border-stone-200 bg-white p-4 shadow-xl">
        <div className="text-sm font-semibold text-stone-950">新建对话</div>
        <input
          className="mt-3 h-9 w-full rounded-md border border-stone-200 px-3 text-sm outline-none focus:border-stone-500"
          placeholder="标题，可留空"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-stone-100 p-1">
          {(["single", "group"] as const).map((item) => (
            <button
              key={item}
              className={`h-8 rounded text-xs ${mode === item ? "bg-white font-medium text-stone-950 shadow-sm" : "text-stone-500"}`}
              type="button"
              onClick={() => {
                setMode(item);
                setAgentIds(item === "single" ? agentIds.slice(0, 1) : agentIds);
              }}
            >
              {item === "single" ? "单聊" : "群聊"}
            </button>
          ))}
        </div>

        <div className="mt-3 max-h-40 space-y-1 overflow-y-auto">
          {agents.map((agent) => (
            <label key={agent.id} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-stone-50">
              <input
                type={mode === "single" ? "radio" : "checkbox"}
                checked={agentIds.includes(agent.id)}
                onChange={() => toggleAgent(agent.id)}
              />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.isOrchestrator ? <span className="text-[11px] text-stone-500">Orch</span> : null}
            </label>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-stone-100 p-1">
          {(["review", "auto"] as const).map((item) => (
            <button
              key={item}
              className={`h-8 rounded text-xs ${approvalMode === item ? "bg-white font-medium text-stone-950 shadow-sm" : "text-stone-500"}`}
              type="button"
              onClick={() => setApprovalMode(item)}
            >
              {item === "review" ? "Review" : "Auto"}
            </button>
          ))}
        </div>

        {!valid ? <div className="mt-2 text-xs text-red-600">请选择正确数量的 Agent。</div> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button className="h-8 rounded-md px-3 text-sm text-stone-600 hover:bg-stone-100" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="h-8 rounded-md bg-stone-950 px-3 text-sm font-medium text-white disabled:bg-stone-300"
            type="button"
            disabled={!valid}
            onClick={() =>
              onCreate({
                title: title.trim() || undefined,
                mode,
                agentIds,
                fsWriteApprovalMode: approvalMode
              })
            }
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active?: boolean; icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      className={`flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs transition ${
        active ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:bg-white"
      }`}
      type="button"
      onClick={onClick}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
