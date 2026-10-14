"use client";

import {
  Archive,
  Pencil,
  Pin,
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
  Sun,
  Trash2,
  Users
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { AgentsPanel } from "@/components/agents-panel";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { ArtifactLibrary } from "@/components/artifact-library";
import { SettingsDialog } from "@/components/settings-dialog";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Popover } from "@/components/ui/popover";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation";
import { Feedback, Tabs } from "@/components/ui/controls";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import { selectAgentList, selectConversationList } from "@/stores/selectors";
import type { Agent, Conversation } from "@/shared/types";

function isSmallScreen() { return window.matchMedia("(max-width: 900px)").matches; }
function subscribeToScreen(callback: () => void) {
  const query = window.matchMedia("(max-width: 900px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

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
  const [deleteConversation, setDeleteConversation] = useState<Conversation | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const smallScreen = useSyncExternalStore(subscribeToScreen, isSmallScreen, () => false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const compactSidebar = smallScreen ? !mobileExpanded : sidebarCollapsed;
  const toggleSidebar = () => { if (smallScreen) setMobileExpanded(current => !current); else toggleSidebarCollapsed(); };
  const selectNavigation = (tab: typeof activeTab) => {
    setActiveTab(tab);
    if (smallScreen) setMobileExpanded(true);
    else if (sidebarCollapsed) toggleSidebarCollapsed();
  };

  // Focus inline edit input
  useEffect(() => {
    if (editingId) setTimeout(() => editInputRef.current?.focus(), 50);
  }, [editingId]);

  const loadBootstrap = useAppStore((state) => state.loadBootstrap);

  const handleDelete = async (conv: Conversation) => {
    if (busyConversationId) return;
    setBusyConversationId(conv.id);
    setActionError(null);
    try {
      await requestJson(`/api/conversations/${conv.id}`, { method: "DELETE" });
      await loadBootstrap();
      setDeleteConversation(null);
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
    <aside className={`ui-sidebar relative flex h-dvh shrink-0 flex-col border-r border-[var(--ui-line)] bg-[var(--ui-surface)] transition-all duration-200 ${compactSidebar ? "w-[56px]" : "w-[280px]"}`}>
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
      {compactSidebar ? (
        <div className="flex h-full flex-col items-center gap-2 py-3">
          {/* Row 1: expand + settings + dark mode */}
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={toggleSidebar}
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
            onClick={() => selectNavigation("conversations")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "conversations" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="对话"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => selectNavigation("artifacts")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "artifacts" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="产物库"
          >
            <Layers className="h-4 w-4" />
          </button>
          <button
            onClick={() => selectNavigation("agents")}
            className={`grid h-9 w-9 place-items-center rounded-lg ${activeTab === "agents" ? "bg-[#4264ff] text-white" : "text-slate-500 hover:bg-slate-100"}`}
            type="button"
            title="Agents"
          >
            <Bot className="h-4 w-4" />
          </button>
          <button
            onClick={() => selectNavigation("analytics")}
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
              onClick={toggleSidebar}
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
          onClick={() => selectNavigation("conversations")}
        />
        <NavButton
          active={activeTab === "artifacts"}
          icon={<Layers className="h-4 w-4" />}
          label="产物库"
          onClick={() => selectNavigation("artifacts")}
        />
        <NavButton
          active={activeTab === "agents"}
          icon={<Bot className="h-4 w-4" />}
          label="Agents"
          onClick={() => selectNavigation("agents")}
        />
        <NavButton
          active={activeTab === "analytics"}
          icon={<BarChart3 className="h-4 w-4" />}
          label="分析"
          onClick={() => selectNavigation("analytics")}
        />
      </nav>

      {activeTab === "conversations" ? (
        <>
          <div className="px-3 pt-4">
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              type="button"
              onClick={() => requestWorkspaceNavigation(() => setDialogOpen(true))}
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
                    requestWorkspaceNavigation(() => {
                      setActiveConversation(conversation.id);
                      setActiveTab("conversations");
                      setMobileExpanded(false);
                    });
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

        </>
      )}

      {dialogOpen ? (
        <CreateConversationDialog
          agents={agents}
          onClose={() => setDialogOpen(false)}
          onCreate={(payload) =>
            createConversation(payload).then(() => {
              setDialogOpen(false);
            })
          }
        />
      ) : null}

      {settingsOpen ? <SettingsDialog open onClose={() => setSettingsOpen(false)} /> : null}

      {/* Right-click context menu */}
      {contextMenu ? (
        <Popover x={contextMenu.x} y={contextMenu.y} label="会话操作" className="ui-context-menu py-1" onClose={() => setContextMenu(null)}>
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
            onClick={() => { setActionError(null); setDeleteConversation(contextMenu.conversation); setContextMenu(null); }}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </button>
        </Popover>
      ) : null}
      <Modal open={deleteConversation !== null} onClose={() => setDeleteConversation(null)} title="删除会话？" size="small" busy={busyConversationId !== null}
        footer={<>{actionError ? <Feedback>{actionError}</Feedback> : null}<button className="ui-button" disabled={busyConversationId !== null} onClick={() => setDeleteConversation(null)}>取消</button>
          <button className="ui-button ui-button--danger" disabled={busyConversationId !== null} onClick={() => deleteConversation ? void handleDelete(deleteConversation) : undefined}>删除会话</button></>}>
        <p className="ui-muted">将删除「{deleteConversation?.title}」及该会话的数据。此操作无法撤销。</p>
      </Modal>
    </aside>
  );
}

function CreateConversationDialog({
  agents, onClose, onCreate
}: {
  agents: Agent[];
  onClose: () => void;
  onCreate: (payload: { title?: string; mode: "single" | "group"; agentIds: string[]; fsWriteApprovalMode: "auto" | "review" }) => Promise<void>;
}) {
  const preferred = agents.filter(agent => agent.isConductor || agent.name.includes("前端")).map(agent => agent.id);
  const defaults = preferred.length >= 2 ? preferred : agents.slice(0, 2).map(agent => agent.id);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"single" | "group">("group");
  const [agentIds, setAgentIds] = useState<string[]>(defaults);
  const [approvalMode, setApprovalMode] = useState<"auto" | "review">("review");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = mode === "single" ? agentIds.length === 1 : agentIds.length >= 2;
  const { requestClose, confirmation } = useUnsavedChanges(
    Boolean(title.trim()) || mode !== "group" || approvalMode !== "review" || JSON.stringify(agentIds) !== JSON.stringify(defaults), onClose, saving
  );
  const create = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try { await onCreate({ title: title.trim() || undefined, mode, agentIds, fsWriteApprovalMode: approvalMode }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "创建会话失败。"); }
    finally { setSaving(false); }
  };
  return <>
    <Modal open onClose={requestClose} title="新建会话" description={`已选 ${agentIds.length} 位 Agent`} busy={saving}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button" disabled={saving} onClick={requestClose}>取消</button>
        <button className="ui-button ui-button--primary" disabled={!valid || saving} onClick={() => void create()}>{saving ? "创建中..." : "创建对话"}</button></>}>
      <label className="ui-field"><span className="ui-field-label">会话标题</span>
        <input data-autofocus aria-label="会话标题" value={title} placeholder="可留空" onChange={event => setTitle(event.target.value)} /></label>
      <Tabs label="会话模式" value={mode} onChange={next => { setMode(next); if (next === "single") setAgentIds(current => current.slice(0, 1)); }}
        items={[{ value: "group", label: "多 Agent 协作", icon: <Users size={15} /> }, { value: "single", label: "单 Agent 对话", icon: <Bot size={15} /> }]} />
      <div className="my-4">
        {agents.map(agent => <label key={agent.id} className="ui-list-row cursor-pointer">
          <input type={mode === "single" ? "radio" : "checkbox"} name="conversation-agents" aria-label={agent.name}
            checked={agentIds.includes(agent.id)} disabled={saving}
            onChange={() => setAgentIds(current => mode === "single" ? [agent.id] : current.includes(agent.id) ? current.filter(id => id !== agent.id) : [...current, agent.id])} />
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm ${getAgentAvatarStyle(agent).solid}`}>{agent.avatar}</span>
          <span className="min-w-0"><strong className="block text-sm font-medium">{agent.name}</strong>
            <span className="block text-xs text-[var(--ui-muted)]">{formatAgentModel(agent)}</span>
            <span className="mt-1 block text-xs text-[var(--ui-muted)]">{buildDialogAgentDescription(agent)}</span></span>
        </label>)}
      </div>
      <label className="ui-field"><span className="ui-field-label">文件写入审批</span>
        <select aria-label="文件写入审批" value={approvalMode} disabled={saving} onChange={event => setApprovalMode(event.target.value as "auto" | "review")}>
          <option value="review">Review · 手动审批</option><option value="auto">Auto · 自动审批</option>
        </select></label>
      {!valid ? <Feedback tone="info">{mode === "single" ? "请选择 1 位 Agent" : "请至少选择 2 位 Agent"}</Feedback> : null}
    </Modal>
    {confirmation}
  </>;
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
