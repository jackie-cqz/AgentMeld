"use client";

import { Archive, BarChart3, Bot, FolderOpen, Layers, MessageSquare, Moon, MoreHorizontal, PanelLeft, Pencil, Pin, Plus, Search, Settings, SquarePen, Sun, Trash2, Users, X } from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { SettingsDialog } from "@/components/settings-dialog";
import { Modal, useUnsavedChanges } from "@/components/ui/modal";
import { Popover } from "@/components/ui/popover";
import { Feedback, Tabs } from "@/components/ui/controls";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation";
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

const navigation = [
  { value: "conversations", label: "对话", icon: MessageSquare },
  { value: "agents", label: "Agents", icon: Bot },
  { value: "artifacts", label: "产物库", icon: Layers },
  { value: "analytics", label: "分析", icon: BarChart3 }
] as const;

export function Sidebar() {
  const agents = useAppStore(useShallow(selectAgentList));
  const conversations = useAppStore(useShallow(selectConversationList));
  const activeConversationId = useAppStore(state => state.activeConversationId);
  const activeTab = useAppStore(state => state.sidebarTab);
  const darkMode = useAppStore(state => state.darkMode);
  const sidebarCollapsed = useAppStore(state => state.sidebarCollapsed);
  const setActiveConversation = useAppStore(state => state.setActiveConversation);
  const setActiveTab = useAppStore(state => state.setSidebarTab);
  const setSearchOpen = useAppStore(state => state.setSearchOpen);
  const toggleDarkMode = useAppStore(state => state.toggleDarkMode);
  const toggleSidebarCollapsed = useAppStore(state => state.toggleSidebarCollapsed);
  const createConversation = useAppStore(state => state.createConversation);
  const loadBootstrap = useAppStore(state => state.loadBootstrap);
  const updateConversation = useAppStore(state => state.updateConversation);
  const smallScreen = useSyncExternalStore(subscribeToScreen, isSmallScreen, () => false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; conversation: Conversation } | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const compact = smallScreen ? !mobileExpanded : sidebarCollapsed;

  const sorted = useMemo(() => [...conversations]
    .filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)), [conversations, query]);
  const pinned = sorted.filter(item => item.pinnedAt !== null);
  const recent = sorted.filter(item => item.pinnedAt === null);
  const navigate = (tab: typeof activeTab) => requestWorkspaceNavigation(() => {
    setActiveTab(tab);
    setMobileExpanded(false);
  });
  const selectConversation = (id: string) => requestWorkspaceNavigation(() => {
    setActiveConversation(id);
    setActiveTab("conversations");
    setMobileExpanded(false);
  });
  const toggleSidebar = () => smallScreen ? setMobileExpanded(current => !current) : toggleSidebarCollapsed();
  const mutate = async (conversation: Conversation, action: "delete" | "rename" | "pin" | "archive") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = action === "rename" ? { title: renameValue.trim() } : action === "pin"
        ? { pinnedAt: conversation.pinnedAt !== null ? null : Date.now() } : { archived: !conversation.archived };
      const data = await requestJson<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        ...(action === "delete" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
      });
      if (action === "delete") await loadBootstrap();
      else updateConversation(conversation.id, data.conversation);
      setMenu(null);
      setRenaming(null);
      setDeleting(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "会话操作失败。");
    } finally { setBusy(false); }
  };
  const conversationRow = (conversation: Conversation) => (
    <div key={conversation.id} className={`workspace-session ${conversation.id === activeConversationId && activeTab === "conversations" ? "is-active" : ""}`}>
      <button type="button" className="workspace-session-link" title={conversation.title}
        aria-current={conversation.id === activeConversationId && activeTab === "conversations" ? "page" : undefined}
        onClick={() => selectConversation(conversation.id)}
        onContextMenu={event => { event.preventDefault(); setError(null); setMenu({ x: event.clientX, y: event.clientY, conversation }); }}>
        {conversation.pinnedAt !== null ? <Pin size={14} /> : conversation.archived ? <Archive size={14} /> : <MessageSquare size={14} />}
        <span>{conversation.title}</span>
      </button>
      <button type="button" className="workspace-session-menu" title={`更多操作：${conversation.title}`}
        onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setError(null); setMenu({ x: rect.right, y: rect.bottom + 4, conversation }); }}>
        <MoreHorizontal size={15} />
      </button>
    </div>
  );

  return <>
    {smallScreen && mobileExpanded ? <button className="workspace-nav-backdrop" aria-label="关闭侧栏" onClick={() => setMobileExpanded(false)} /> : null}
    <aside className={`ui-sidebar workspace-sidebar ${compact ? "is-compact" : "is-expanded"}`} aria-label="工作空间导航">
      <div className="workspace-brand">
        {!compact ? <div className="workspace-wordmark"><span className="workspace-logo"><Layers size={16} /></span><span>AgentMeld</span></div> : null}
        <button type="button" className="ui-icon-button" title={compact ? "展开侧栏" : "折叠侧栏"} onClick={toggleSidebar}><PanelLeft size={17} /></button>
      </div>
      <div className="workspace-primary-actions">
        <button type="button" title="新建对话" onClick={() => requestWorkspaceNavigation(() => setDialogOpen(true))}>
          <SquarePen size={17} />{!compact ? <span>新建对话</span> : null}
          {!compact ? <Plus size={14} className="ml-auto opacity-50" /> : null}
        </button>
        <button type="button" title="搜索消息 Ctrl/⌘K" onClick={() => setSearchOpen(true)}>
          <Search size={17} />{!compact ? <span>搜索</span> : null}
        </button>
      </div>
      <nav className="workspace-nav" aria-label="工作空间视图">
        {navigation.map(item => <button key={item.value} type="button" title={item.label} aria-current={activeTab === item.value ? "page" : undefined}
          onClick={() => navigate(item.value)}><item.icon size={16} />{!compact ? <><span>{item.label}</span>
            {item.value === "agents" ? <small>{agents.length}</small> : null}</> : null}</button>)}
      </nav>
      {!compact ? <>
        <div className="workspace-project"><FolderOpen size={15} /><span>本地工作空间</span></div>
        <div className="workspace-session-heading"><span>会话</span><span>{conversations.length}</span>
          <button className="ui-icon-button" title="筛选会话" type="button" onClick={() => { setFilterOpen(current => !current); window.requestAnimationFrame(() => filterRef.current?.focus()); }}><Search size={13} /></button>
        </div>
        {filterOpen ? <label className="workspace-filter"><Search size={13} /><input ref={filterRef} aria-label="筛选会话" placeholder="筛选会话…" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" title="清除筛选" onClick={() => { setQuery(""); setFilterOpen(false); }}><X size={13} /></button></label> : null}
        <div className="workspace-session-list">
          {pinned.length ? <><div className="workspace-list-label">已置顶</div>{pinned.map(conversationRow)}</> : null}
          {recent.length ? <><div className="workspace-list-label">最近</div>{recent.map(conversationRow)}</> : null}
          {!sorted.length ? <p className="workspace-list-empty">{query ? "没有匹配的会话" : "暂无会话"}</p> : null}
        </div>
      </> : <div className="flex-1" />}
      <div className="workspace-nav-footer">
        {!compact ? <span className="workspace-local-label"><span />Local workspace</span> : null}
        <button type="button" className="ui-icon-button" title={darkMode ? "浅色模式" : "深色模式"} onClick={toggleDarkMode}>{darkMode ? <Sun size={16} /> : <Moon size={16} />}</button>
        <button type="button" className="ui-icon-button" title="设置" onClick={() => setSettingsOpen(true)}><Settings size={16} /></button>
      </div>
      {error && !renaming && !deleting ? <div className="p-2"><Feedback>{error}</Feedback></div> : null}
    </aside>
    {dialogOpen ? <CreateConversationDialog agents={agents} onClose={() => setDialogOpen(false)} onCreate={async payload => {
      await createConversation(payload);
      setActiveTab("conversations");
      setMobileExpanded(false);
      setDialogOpen(false);
    }} /> : null}
    {settingsOpen ? <SettingsDialog open onClose={() => setSettingsOpen(false)} /> : null}
    {menu ? <Popover x={menu.x} y={menu.y} label="会话操作" className="ui-context-menu py-1" onClose={() => setMenu(null)}>
      <div className="truncate border-b border-[var(--ui-line)] px-3 py-2 text-xs text-[var(--ui-muted)]">{menu.conversation.title}</div>
      <button className="workspace-menu-item" disabled={busy} onClick={() => void mutate(menu.conversation, "pin")}><Pin size={15} />{menu.conversation.pinnedAt !== null ? "取消置顶" : "置顶"}</button>
      <button className="workspace-menu-item" disabled={busy} onClick={() => { setRenaming(menu.conversation); setRenameValue(menu.conversation.title); setMenu(null); }}><Pencil size={15} />重命名</button>
      <button className="workspace-menu-item" disabled={busy} onClick={() => void mutate(menu.conversation, "archive")}><Archive size={15} />{menu.conversation.archived ? "取消归档" : "归档"}</button>
      <button className="workspace-menu-item text-[var(--ui-danger)]" disabled={busy} onClick={() => { setDeleting(menu.conversation); setMenu(null); }}><Trash2 size={15} />删除</button>
    </Popover> : null}
    <Modal open={renaming !== null} title="重命名会话" onClose={() => setRenaming(null)} size="small" busy={busy}
      footer={<><button className="ui-button" disabled={busy} onClick={() => setRenaming(null)}>取消</button><button className="ui-button ui-button--primary" disabled={busy || !renameValue.trim()} onClick={() => renaming && void mutate(renaming, "rename")}>保存</button></>}>
      <label className="ui-field"><span className="ui-field-label">会话标题</span><input data-autofocus value={renameValue} onChange={event => setRenameValue(event.target.value)} /></label>{error ? <Feedback>{error}</Feedback> : null}
    </Modal>
    <Modal open={deleting !== null} title="删除会话？" onClose={() => setDeleting(null)} size="small" busy={busy}
      footer={<><button className="ui-button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="ui-button ui-button--danger" disabled={busy} onClick={() => deleting && void mutate(deleting, "delete")}>删除会话</button></>}>
      <p className="ui-muted">将删除「{deleting?.title}」及该会话的数据。此操作无法撤销。</p>{error ? <Feedback>{error}</Feedback> : null}
    </Modal>
  </>;
}

function CreateConversationDialog({ agents, onClose, onCreate }: {
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
            <span className="block text-xs text-[var(--ui-muted)]">{agent.adapterName} / {agent.modelId || "未指定模型"}</span>
            <span className="mt-1 block text-xs text-[var(--ui-muted)]">{agent.description || agent.systemPrompt.split(/\n{2,}/)[0]}</span></span>
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
