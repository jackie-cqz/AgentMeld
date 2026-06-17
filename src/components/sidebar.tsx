"use client";

import {
  BarChart3,
  Bot,
  ChevronRight,
  Layers,
  MessageSquare,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Settings,
  SlidersHorizontal
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AgentsPanel } from "@/components/agents-panel";
import { ArtifactLibrary } from "@/components/artifact-library";
import { SettingsDialog } from "@/components/settings-dialog";
import { useAppStore } from "@/stores/app-store";
import type { Agent } from "@/shared/types";

export function Sidebar() {
  const agents = useAppStore((state) => state.agents);
  const conversations = useAppStore((state) => state.conversations);
  const conversationOrder = useAppStore((state) => state.conversationOrder);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const setActiveConversation = useAppStore((state) => state.setActiveConversation);
  const createConversation = useAppStore((state) => state.createConversation);
  const activeTab = useAppStore((state) => state.sidebarTab);
  const setActiveTab = useAppStore((state) => state.setSidebarTab);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");

  const orderedConversations = useMemo(
    () =>
      conversationOrder
        .map((id) => conversations[id])
        .filter(Boolean)
        .filter((conversation) => conversation.title.toLowerCase().includes(query.trim().toLowerCase())),
    [conversationOrder, conversations, query]
  );

  return (
    <aside className="relative flex h-screen w-[344px] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 pb-4 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="whitespace-nowrap text-[20px] font-semibold leading-6 text-slate-950">
              Agent Conference
            </div>
            <div className="mt-1 truncate text-sm text-slate-500">多 Agent 协作平台</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setSettingsOpen(true)}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              type="button"
              title="设置"
            >
              <Settings className="h-5 w-5" />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              type="button"
              title="主题"
            >
              <Moon className="h-5 w-5" />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              type="button"
              title="折叠侧栏"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <nav className="space-y-2 px-3 py-4">
        <NavButton
          active={activeTab === "conversations"}
          icon={<MessageSquare className="h-4 w-4" />}
          label="对话"
          onClick={() => setActiveTab("conversations")}
        />
        <NavButton
          active={activeTab === "artifacts"}
          icon={<Layers className="h-4 w-4" />}
          label="产物库"
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
          <div className="px-3 pt-4">
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              新建对话
            </button>
          </div>

          <div className="mx-3 mt-3 flex items-center gap-2">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-500">
              <Search className="h-4 w-4" />
              <input
                className="min-w-0 flex-1 bg-transparent outline-none"
                placeholder="搜索会话..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" title="筛选">
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 flex-1 overflow-y-auto px-3 pb-4">
            <div className="space-y-2">
              {orderedConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                    conversation.id === activeConversationId
                      ? "bg-[#fffdf5] shadow-sm ring-1 ring-amber-100"
                      : "hover:bg-slate-50"
                  }`}
                  type="button"
                  onClick={() => {
                    setActiveConversation(conversation.id);
                    setActiveTab("conversations");
                  }}
                >
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#635bff] text-sm font-semibold text-white">
                    {getConversationInitials(conversation.title)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {conversation.id === activeConversationId ? (
                        <span className="text-amber-500">◆</span>
                      ) : null}
                      <div className="truncate text-sm font-semibold text-slate-950">{conversation.title}</div>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {conversation.mode === "group" ? "群聊" : "单聊"} · {conversation.agentIds.length} 位 Agent
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        </>
      ) : activeTab === "agents" ? (
        <AgentsPanel />
      ) : activeTab === "artifacts" ? (
        <ArtifactLibrary />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-slate-500">
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
      className={`flex h-12 w-full items-center gap-3 rounded-lg px-3 text-base font-medium transition ${
        active ? "bg-[#4264ff] text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
      }`}
      type="button"
      onClick={onClick}
      title={label}
    >
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${active ? "bg-white/10" : "bg-transparent"}`}>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function getConversationInitials(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return "AC";
  const asciiWords = trimmed.match(/[A-Za-z0-9]+/g);
  if (asciiWords && asciiWords.length > 0) {
    return asciiWords.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
  }
  return trimmed.slice(0, 2);
}
