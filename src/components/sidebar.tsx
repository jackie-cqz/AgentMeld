"use client";

import {
  Archive,
  Pencil,
  Pin,
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  Layers,
  MessageSquare,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  Users,
  X
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AgentsPanel } from "@/components/agents-panel";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { ArtifactLibrary } from "@/components/artifact-library";
import { SettingsDialog } from "@/components/settings-dialog";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList, selectConversationList } from "@/stores/selectors";
import type { Agent, Conversation } from "@/shared/types";

export function Sidebar() {
  const agents = useAppStore(useShallow(selectAgentList));
  const conversations = useAppStore(useShallow(selectConversationList));
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const setActiveConversation = useAppStore((state) => state.setActiveConversation);
  const createConversation = useAppStore((state) => state.createConversation);
  const activeTab = useAppStore((state) => state.sidebarTab);
  const setActiveTab = useAppStore((state) => state.setSidebarTab);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const darkMode = useAppStore((state) => state.darkMode);
  const toggleDarkMode = useAppStore((state) => state.toggleDarkMode);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const toggleSidebarCollapsed = useAppStore((state) => state.toggleSidebarCollapsed);
  const updateConversation = useAppStore((state) => state.updateConversation);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; conversation: Conversation } | null>(null);
  // Inline editing: conversation id being edited + edit value
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  // Focus inline edit input
  useEffect(() => {
    if (editingId) setTimeout(() => editInputRef.current?.focus(), 50);
  }, [editingId]);

  const loadBootstrap = useAppStore((state) => state.loadBootstrap);

  const handleDelete = async (conv: Conversation) => {
    if (!confirm(`确定删除会话「${conv.title}」吗？此操作不可撤销。`)) return;
    setBusyConversationId(conv.id);
    setActionError(null);
    try {
      await requestJson(`/api/conversations/${conv.id}`, { method: "DELETE" });
      await loadBootstrap();
      setContextMenu(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "删除会话失败。");
    } finally {
      setBusyConversationId(null);
    }
  };

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditValue(conv.title);
    setContextMenu(null);
  };

  const submitRename = async () => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === conversations.find((c) => c.id === editingId)?.title) { setEditingId(null); return; }
    setBusyConversationId(editingId);
    setActionError(null);
    try {
      const data = await requestJson<{ conversation: Conversation }>(`/api/conversations/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed })
      });
      updateConversation(editingId, data.conversation);
      setEditingId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "重命名失败。");
    } finally {
      setBusyConversationId(null);
    }
  };

  const handleArchive = async (conv: Conversation) => {
    setBusyConversationId(conv.id);
    setActionError(null);
    try {
      const data = await requestJson<{ conversation: Conversation }>(`/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !conv.archived })
      });
      updateConversation(conv.id, data.conversation);
      setContextMenu(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "归档操作失败。");
    } finally {
      setBusyConversationId(null);
    }
  };

  const handlePin = async (conv: Conversation) => {
    const isPinned = conv.pinnedAt !== null;
    setBusyConversationId(conv.id);
    setActionError(null);
    try {
      const data = await requestJson<{ conversation: Conversation }>(`/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAt: isPinned ? null : Date.now() })
      });
      updateConversation(conv.id, data.conversation);
      setContextMenu(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "置顶操作失败。");
    } finally {
      setBusyConversationId(null);
    }
  };

  const orderedConversations = useMemo(() => {
    const filtered = conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
    // Sort pinned to top
    return [...filtered].sort((a, b) => {
      const aPinned = a.pinnedAt !== null;
      const bPinned = b.pinnedAt !== null;
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      if (aPinned && bPinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      return 0;
    });
  }, [conversations, query]);

  return (
    <aside className={`relative flex h-screen shrink-0 flex-col border-r transition-all duration-200 ${darkMode ? "border-slate-700 bg-slate-900 text-slate-100" : "border-slate-200 bg-white"} ${sidebarCollapsed ? "w-[56px]" : "w-[344px]"}`}>
      {actionError ? (
        <button
          type="button"
          onClick={() => setActionError(null)}
          className="absolute bottom-3 left-3 right-3 z-40 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-left text-xs text-red-700 shadow-lg"
          title="点击关闭"
        >
          {actionError}
        </button>
      ) : null}
      {/* Collapsed narrow bar */}
      {sidebarCollapsed ? (
        <div className="flex h-full flex-col items-center gap-2 py-3">
          {/* Row 1: expand + settings + dark mode */}
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={toggleSidebarCollapsed}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100"
              type="button"
              title="展开侧栏"
            >
              <PanelLeft className="h-5 w-5 rotate-180" />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100"
              type="button"
              title="设置"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={toggleDarkMode}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100"
              type="button"
              title={darkMode ? "浅色模式" : "深色模式"}
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          {/* Divider 1 */}
          <div className={`h-px w-8 ${darkMode ? "bg-slate-700" : "bg-slate-200"}`} />

          {/* Nav icons */}
          <button
            onClick={() => setActiveTab("conversations")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "conversations" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="对话"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => setActiveTab("artifacts")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "artifacts" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="产物库"
          >
            <Layers className="h-4 w-4" />
          </button>
          <button
            onClick={() => setActiveTab("agents")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "agents" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="Agents"
          >
            <Bot className="h-4 w-4" />
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "analytics" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="分析"
          >
            <BarChart3 className="h-4 w-4" />
          </button>

          {/* Divider 2 — only when conversations tab active */}
          {activeTab === "conversations" ? (
            <>
              <div className={`h-px w-8 ${darkMode ? "bg-slate-700" : "bg-slate-200"}`} />
              {/* Conversation avatars */}
              <div className="flex-1 overflow-y-auto px-1">
                <div className="flex flex-col items-center gap-2">
                  {conversations.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => {
                        setActiveConversation(conv.id);
                        setActiveTab("conversations");
                      }}
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold transition ${
                        conv.id === activeConversationId
                          ? "bg-[#4264ff] text-white ring-2 ring-blue-200"
                          : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                      }`}
                      type="button"
                      title={conv.title}
                    >
                      {getConversationInitials(conv.title)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
      <div className="border-b border-slate-200 px-4 pb-4 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="whitespace-nowrap text-[20px] font-semibold leading-6 text-slate-950">
              AgentMeld
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
              onClick={toggleDarkMode}
              className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100"
              type="button"
              title={darkMode ? "浅色模式" : "深色模式"}
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <button
              onClick={toggleSidebarCollapsed}
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
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="grid h-10 w-10 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              title="搜索消息 Ctrl/⌘K"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 flex-1 overflow-y-auto px-3 pb-4">
            <div className="space-y-2">
              {orderedConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                    conversation.id === activeConversationId
                      ? "bg-[#fffdf5] shadow-sm ring-1 ring-amber-100 dark:bg-blue-500/10 dark:ring-blue-500/25"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/70"
                  }`}
                  type="button"
                  onClick={() => {
                    setActiveConversation(conversation.id);
                    setActiveTab("conversations");
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, conversation });
                  }}
                >
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#635bff] text-sm font-semibold text-white">
                    {getConversationInitials(conversation.title)}
                  </div>
                  <div className="min-w-0 flex-1">
                    {editingId === conversation.id ? (
                      <input
                        ref={editInputRef}
                        className="mb-1 h-7 w-full rounded border border-[#4264ff] bg-white px-2 text-sm font-semibold text-slate-950 outline-none"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setEditingId(null); }}
                        onBlur={submitRename}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        {conversation.pinnedAt !== null ? (
                          <Pin className="h-3 w-3 shrink-0 text-amber-500" />
                        ) : null}
                        {conversation.id === activeConversationId ? (
                          <span className="text-amber-500">◆</span>
                        ) : null}
                        <div className="truncate text-sm font-semibold text-slate-950 dark:text-slate-100">{conversation.title}</div>
                      </div>
                    )}
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
        <AnalyticsPanel />
      )}

      {dialogOpen ? (
        <CreateConversationDialog
          agents={agents}
          onClose={() => setDialogOpen(false)}
          onCreate={(payload) =>
            void createConversation(payload).then(() => {
              setDialogOpen(false);
            }).catch((error: unknown) => {
              setActionError(error instanceof Error ? error.message : "创建会话失败。");
            })
          }
        />
      ) : null}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </>
      )}

      {/* Right-click context menu */}
      {contextMenu ? (
        <div
          ref={contextRef}
          className="fixed z-50 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="truncate border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">
            {contextMenu.conversation.title}
          </div>
          <button
            disabled={busyConversationId === contextMenu.conversation.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={() => void handlePin(contextMenu.conversation)}
          >
            <Pin className="h-4 w-4" />
            {contextMenu.conversation.pinnedAt !== null ? "取消置顶" : "置顶"}
          </button>
          <button
            disabled={busyConversationId === contextMenu.conversation.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={() => startRename(contextMenu.conversation)}
          >
            <Pencil className="h-4 w-4" />
            重命名
          </button>
          <button
            disabled={busyConversationId === contextMenu.conversation.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={() => void handleArchive(contextMenu.conversation)}
          >
            <Archive className="h-4 w-4" />
            {contextMenu.conversation.archived ? "取消归档" : "归档"}
          </button>
          <button
            disabled={busyConversationId === contextMenu.conversation.id}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            onClick={() => void handleDelete(contextMenu.conversation)}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </button>
        </div>
      ) : null}
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
    .filter((agent) => agent.isConductor || agent.name.includes("前端"))
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
  const selectedAgents = agents.filter((agent) => agentIds.includes(agent.id));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[88vh] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white shadow-2xl shadow-slate-950/20 dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-blue-600 dark:text-blue-300">
              <MessageSquare className="h-4 w-4" />
              新建协作空间
            </div>
            <h2 className="mt-2 text-xl font-semibold text-slate-950 dark:text-slate-50">选择参与这次对话的 Agent</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              为不同任务组合合适的角色，创建后会进入新的群聊工作区。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px] gap-0 overflow-hidden max-lg:grid-cols-1">
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <label className="block">
              <span className="text-xs font-semibold uppercase text-slate-500 dark:text-slate-400">对话标题</span>
              <input
                className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                placeholder="例如：Todo App 协作开发，可留空"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <div className="mt-5 grid grid-cols-2 gap-3">
              {(["group", "single"] as const).map((item) => {
                const active = mode === item;
                return (
                  <button
                    key={item}
                    type="button"
                    className={`rounded-xl border p-4 text-left transition ${
                      active
                        ? "border-blue-500 bg-blue-50 shadow-sm ring-4 ring-blue-500/10 dark:bg-blue-500/10"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                    }`}
                    onClick={() => {
                      setMode(item);
                      setAgentIds((current) => item === "single" ? current.slice(0, 1) : current);
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`grid h-9 w-9 place-items-center rounded-lg ${active ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
                        {item === "group" ? <Users className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-slate-950 dark:text-slate-100">{item === "group" ? "多 Agent 协作" : "单 Agent 对话"}</span>
                        <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{item === "group" ? "适合产品、设计、开发、审查串联" : "适合单角色快速问答或执行"}</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-6">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-950 dark:text-slate-100">参与 Agent</div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">查看职责、能力和当前接入模型后再选择。</div>
                </div>
                <div className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  已选 {agentIds.length}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                {agents.map((agent) => {
                  const selected = agentIds.includes(agent.id);
                  const description = buildDialogAgentDescription(agent);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className={`group min-h-[154px] rounded-xl border p-4 text-left transition ${
                        selected
                          ? "border-blue-500 bg-blue-50/80 shadow-sm ring-4 ring-blue-500/10 dark:bg-blue-500/10"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-sm font-semibold ${getAgentAvatarStyle(agent).solid}`}>
                          {agent.avatar}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-950 dark:text-slate-100">{agent.name}</span>
                            {agent.isConductor ? <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-200">Conductor</span> : null}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <Cpu className="h-3.5 w-3.5" />
                            {formatAgentModel(agent)}
                          </span>
                        </span>
                        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border transition ${
                          selected
                            ? "border-blue-600 bg-blue-600 text-white"
                            : "border-slate-300 text-transparent group-hover:text-slate-300 dark:border-slate-600"
                        }`}>
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      </div>

                      <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{description}</p>

                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(agent.capabilities.length > 0 ? agent.capabilities.slice(0, 3) : [agent.adapterName]).map((capability) => (
                          <span key={capability} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            {capability}
                          </span>
                        ))}
                        {agent.capabilities.length > 3 ? (
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">+{agent.capabilities.length - 3}</span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <aside className="border-l border-slate-100 bg-slate-50/80 px-5 py-5 dark:border-slate-800 dark:bg-slate-900/80 max-lg:border-l-0 max-lg:border-t">
            <div className="text-sm font-semibold text-slate-950 dark:text-slate-100">本次配置</div>
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <Users className="h-3.5 w-3.5" />
                  协作模式
                </div>
                <div className="mt-2 text-sm font-semibold text-slate-950 dark:text-slate-100">{mode === "group" ? "群聊协作" : "单聊"}</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{selectedAgents.map((agent) => agent.name).join("、") || "尚未选择 Agent"}</div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  文件写入审批
                </div>
                <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                  {(["review", "auto"] as const).map((item) => (
                    <button
                      key={item}
                      className={`h-8 rounded-md text-xs transition ${approvalMode === item ? "bg-white font-semibold text-slate-950 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
                      type="button"
                      onClick={() => setApprovalMode(item)}
                    >
                      {item === "review" ? "Review" : "Auto"}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {approvalMode === "review" ? "写入文件前需要你确认，适合不确定任务。" : "自动通过文件写入，更适合连续实现。"}
                </p>
              </div>
            </div>
          </aside>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-6 py-4 dark:border-slate-800">
          <div className="min-h-5 text-xs text-red-600 dark:text-red-300">
            {!valid ? (mode === "single" ? "单聊需要选择 1 位 Agent。" : "群聊至少选择 2 位 Agent。") : ""}
          </div>
          <div className="flex gap-2">
            <button className="h-10 rounded-lg px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" type="button" onClick={onClose}>
              取消
            </button>
            <button
              className="h-10 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:bg-slate-300 disabled:shadow-none dark:disabled:bg-slate-700"
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
              创建对话
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildDialogAgentDescription(agent: Agent) {
  const explicit = agent.description.trim();
  if (explicit) return explicit;
  const firstPromptParagraph = agent.systemPrompt
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(Boolean);
  return firstPromptParagraph ?? "这个 Agent 还没有单独填写职责描述。";
}

function formatAgentModel(agent: Agent) {
  const provider = formatProviderName(agent.modelProvider);
  const model = agent.modelId?.trim() || "未指定模型";
  return `${provider} / ${model}`;
}

function formatProviderName(provider: Agent["modelProvider"]) {
  if (!provider) return "未配置";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  if (provider === "volcano-ark") return "Volcano Ark";
  return provider;
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
