"use client";

import { Circle, FileSearch, Folder, GitBranch, Layers, Loader2, MessageSquare, Pencil, Pin, Reply, RotateCcw, UserPlus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { MessageInput } from "@/components/message-input";
import { MessageParts } from "@/components/message-parts";
import { DispatchProgress } from "@/components/dispatch-progress";
import { PendingApprovalPanel } from "@/components/pending-approval-panel";
import { ContextStatsPanel } from "@/components/context-stats-panel";
import { ContextTraceDrawer } from "@/components/context-trace-drawer";
import { ConversationTimeline } from "@/components/conversation-timeline";
import { ConversationTabBar } from "@/components/conversation-tab-bar";
import { ConversationAgentManagerDialog } from "@/components/conversation-agent-manager-dialog";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { FileLibraryDialog } from "@/components/file-library-dialog";
import { FileTab } from "@/components/file-tab";
import { PendingWriteDiffTab } from "@/components/pending-write-diff-tab";
import { PinnedMessagesBar } from "@/components/pinned-messages-bar";
import { requestJson } from "@/lib/request-json";
import { AgentAvatar, type AgentAvatarSize } from "@/components/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import {
  selectActiveConversation,
  selectConversationMessages,
  selectConversationRuns,
  selectLatestUserMessageId
} from "@/stores/selectors";
import type { Agent, Message } from "@/shared/types";
import type { AdapterName, ModelProvider } from "@/shared/types";
import { Popover } from "@/components/ui/popover";

export function ChatPanel() {
  const agents = useAppStore((state) => state.agents);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const conversation = useAppStore(selectActiveConversation);
  const messages = useAppStore(useShallow((state) => selectConversationMessages(state, state.activeConversationId)));
  const runs = useAppStore(useShallow((state) => selectConversationRuns(state, state.activeConversationId)));
  const latestUserId = useAppStore((state) => selectLatestUserMessageId(state, state.activeConversationId));
  const highlightedMessageId = useAppStore((state) => state.highlightedMessageId);
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightPanelMode = useAppStore((state) => state.rightPanelMode);
  const conversationVisible = useAppStore(state => state.sidebarTab === "conversations");
  const activeTab = useAppStore((state) =>
    state.activeConversationId ? state.activeTabByConversation[state.activeConversationId] ?? "chat" : "chat"
  );
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightPanelMode = useAppStore((state) => state.setRightPanelMode);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousConversationIdRef = useRef<string | null>(null);
  const previousActiveTabRef = useRef<string | null>(null);
  const previousVisibleRef = useRef(true);
  const savedScrollTopRef = useRef(0);
  const [showContextStats, setShowContextStats] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [agentProfile, setAgentProfile] = useState<{ agent: Agent; x: number; y: number } | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceAttemptId, setTraceAttemptId] = useState<string | null>(null);
  const dispatchesByRunId = useAppStore((s) => s.dispatchesByRunId);
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);

  // P1: Find attemptId from a child runId.
  // Try store first (instant for active runs), fall back to API (works after refresh).
  const handleOpenTrace = async (runId: string) => {
    // Try store lookup first
    for (const dispatch of Object.values(dispatchesByRunId)) {
      for (const [taskId, childRunId] of Object.entries(dispatch.childRunIds)) {
        if (childRunId === runId) {
          const attemptId = dispatch.activeAttemptByTask[taskId];
          if (attemptId) { setTraceAttemptId(attemptId); setTraceOpen(true); return; }
        }
      }
    }
    // Fallback: query backend by childRunId
    try {
      const res = await fetch(`/api/context-trace/by-run/${runId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.attempt?.attemptId) {
          setTraceAttemptId(data.attempt.attemptId);
          setTraceOpen(true);
          return;
        }
      }
    } catch { /* silent — drawer will show error state */ }
  };

  const handleViewAgent = (agent: Agent, event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const cardWidth = 380;
    const cardHeight = 340;
    const maxX = Math.max(12, window.innerWidth - cardWidth - 12);
    const maxY = Math.max(12, window.innerHeight - cardHeight - 12);
    setAgentProfile({
      agent,
      x: Math.min(Math.max(rect.left, 12), maxX),
      y: Math.min(Math.max(rect.bottom + 10, 12), maxY)
    });
  };

  const handleEditAgent = (agent: Agent) => setEditingAgent(agent);

  const handleUpdateAgent = async (payload: {
    name: string; avatar?: string; description: string; capabilities?: string[]; adapterName: AdapterName; modelProvider?: ModelProvider | null;
    modelId?: string | null; apiKey?: string | null; apiBaseUrl?: string | null;
    systemPrompt?: string; toolNames?: string[];
  }) => {
    if (!editingAgent) return;
    await requestJson(`/api/agents/${editingAgent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await loadBootstrap();
    setEditingAgent(null);
  };

  const runningCount = runs.filter((run) => run.status === "running").length;
  const tokenTotal = runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0), 0);

  const activeAgents = useMemo(
    () => conversation?.agentIds.map((id) => agents[id]).filter((agent): agent is Agent => Boolean(agent)) ?? [],
    [agents, conversation]
  );
  const visibleMessages = useMemo(() => transcriptMessages(messages), [messages]);

  useLayoutEffect(() => {
    const returnedToConversation = conversationVisible && !previousVisibleRef.current;
    previousVisibleRef.current = conversationVisible;
    if (!conversationVisible) return;
    const conversationChanged = previousConversationIdRef.current !== activeConversationId;
    const returnedToChat =
      activeTab === "chat" && previousActiveTabRef.current !== null &&
      previousActiveTabRef.current !== "chat";
    previousConversationIdRef.current = activeConversationId;
    previousActiveTabRef.current = activeTab;

    const scroller = scrollerRef.current;
    if (!scroller) return;

    if (conversationChanged || returnedToChat) {
      stickToBottomRef.current = true;
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }

    if (returnedToConversation) {
      scroller.scrollTop = stickToBottomRef.current ? scroller.scrollHeight : savedScrollTopRef.current;
      return;
    }

    if (stickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [activeConversationId, activeTab, visibleMessages.length, runningCount, conversationVisible]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rightPanelOpen]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`message-${highlightedMessageId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, highlightedMessageId, visibleMessages.length]);

  if (!conversation) {
    return (
      <main className="grid min-w-0 flex-1 place-items-center bg-[#fbfaf7]">
        <div className="text-sm text-stone-500">正在准备工作空间...</div>
      </main>
    );
  }

  return (
    <main className="ui-chat flex min-w-0 flex-1 flex-col bg-[var(--ui-surface)]">
      <header className="workspace-chat-header">
        <div className="workspace-chat-title"><MessageSquare size={16} /><span className="workspace-crumb">工作空间<span>/</span></span><h1 title={conversation.title}>{conversation.title}</h1></div>
        <div className="workspace-chat-utilities">
          <span className={`workspace-connection ${connectionStatus === "open" ? "is-connected" : connectionStatus === "connecting" ? "is-connecting" : "is-disconnected"}`} title={formatConnectionStatus(connectionStatus)} aria-label={formatConnectionStatus(connectionStatus)}><Circle size={6} className="fill-current" /><span>{formatConnectionStatus(connectionStatus)}</span></span>
          <HeaderIcon title="工作区文件" onClick={() => {
            if (rightPanelMode === "files" && rightPanelOpen) setRightPanelOpen(false);
            else setRightPanelMode("files");
          }} active={rightPanelMode === "files" && rightPanelOpen}><GitBranch size={15} /><span className="workspace-utility-label">文件</span></HeaderIcon>
          <HeaderIcon title="Artifact Workspace" onClick={() => {
            if (rightPanelMode === "artifact" && rightPanelOpen) setRightPanelOpen(false);
            else { setRightPanelMode("artifact"); setRightPanelOpen(true); }
          }} active={rightPanelMode === "artifact" && rightPanelOpen}><Layers size={15} /><span className="workspace-utility-label">产物</span></HeaderIcon>
          <HeaderIcon title="会话文件" onClick={() => setShowFiles(true)}><Folder size={15} /></HeaderIcon>
        </div>
      </header>
      <div className="workspace-team-strip">
        <div className="workspace-team-members">
              {activeAgents.slice(0, 3).map((agent) => (
                <button key={agent.id} className="workspace-team-member" title={`查看 ${agent.name}`} onClick={event => handleViewAgent(agent, event)}>
                  <AgentAvatar agent={agent} size="xs" /><span>{agent.name}</span>
                </button>
              ))}
              <button type="button" title="管理会话 Agent" className="workspace-team-member workspace-team-manage" onClick={() => setShowAgentManager(true)}>
                {activeAgents.length > 3 ? <span>+{activeAgents.length - 3}</span> : <UserPlus size={14} />}
              </button>
        </div>
        <div className="workspace-context-meter">
              <button
                onClick={() => setShowContextStats((prev) => !prev)}
                className="workspace-context-button"
                aria-expanded={showContextStats}
                title="上下文统计与压缩"
              >
                <Circle size={12} />{formatTokenCount(tokenTotal)}<span>tokens</span>
              </button>
              {showContextStats && activeConversationId && (
                <ContextStatsPanel
                  conversationId={activeConversationId}
                  onClose={() => setShowContextStats(false)}
                />
              )}
        </div>
      </div>

      <ConversationTabBar conversationId={conversation.id} />

      <div className="relative flex-1 overflow-hidden">
        {activeTab === "chat" ? (
          <>
            <div
              ref={scrollerRef}
              className="workspace-chat-scroller h-full overflow-y-auto"
              onScroll={(event) => {
                if (!conversationVisible) return;
                const scroller = event.currentTarget;
                savedScrollTopRef.current = scroller.scrollTop;
                stickToBottomRef.current =
                  scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
              }}
            >
              <PinnedMessagesBar conversation={conversation} />
              <div className={`workspace-transcript ${visibleMessages.length === 0 ? "is-empty" : ""}`}>
                {visibleMessages.length === 0 ? (
                  <div className="workspace-empty-conversation"><span className="workspace-empty-mark"><Layers size={26} strokeWidth={1.5} /></span>
                    <h2>准备好开始了</h2><p>{activeAgents.length} 位 Agent · {conversation.mode === "group" ? "团队协作" : "单独对话"}</p>
                    <div>{activeAgents.map(agent => <button type="button" key={agent.id} onClick={event => handleViewAgent(agent, event)} title={`查看 ${agent.name}`}>
                      <AgentAvatar agent={agent} size="xs" />{agent.name}</button>)}</div>
                  </div>
                ) : null}
                {visibleMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    agent={message.agentId ? agents[message.agentId] : null}
                    conversation={conversation}
                    isLatestUser={message.id === latestUserId}
                    highlighted={message.id === highlightedMessageId}
                    onViewAgent={handleViewAgent}
                    onOpenTrace={handleOpenTrace}
                  />
                ))}
              </div>
            </div>
            <ConversationTimeline
              messages={visibleMessages}
              scrollerRef={scrollerRef}
              rightOffset={0}
            />
          </>
        ) : activeTab.startsWith("file:") ? (
          <FileTab conversationId={conversation.id} filePath={activeTab.slice(5)} />
        ) : activeTab.startsWith("diff:") ? (
          <PendingWriteDiffTab conversationId={conversation.id} pendingId={activeTab.slice(5)} />
        ) : null}
      </div>

      {activeTab === "chat" ? (
        <>
          <PendingApprovalPanel />
          <MessageInput
            key={conversation.id}
            conversationId={conversation.id}
            agents={activeAgents}
          />
        </>
      ) : null}

      {agentProfile ? (
        <AgentProfileCard
          agent={agentProfile.agent}
          x={agentProfile.x}
          y={agentProfile.y}
          onClose={() => setAgentProfile(null)}
          onEdit={() => {
            setAgentProfile(null);
            handleEditAgent(agentProfile.agent);
          }}
        />
      ) : null}

      <CreateAgentDialog
        key={editingAgent?.id ?? "new"}
        open={!!editingAgent}
        onClose={() => setEditingAgent(null)}
        onCreate={handleUpdateAgent}
        initial={editingAgent ? {
          name: editingAgent.name,
          avatar: editingAgent.avatar,
          isConductor: editingAgent.isConductor,
          description: editingAgent.description,
          capabilities: editingAgent.capabilities,
          adapterName: editingAgent.adapterName as AdapterName,
          modelProvider: editingAgent.modelProvider,
          modelId: editingAgent.modelId,
          apiKey: editingAgent.apiKey,
          apiBaseUrl: editingAgent.apiBaseUrl,
          systemPrompt: editingAgent.systemPrompt,
          toolNames: editingAgent.toolNames
        } : undefined}
      />
      {showFiles ? <FileLibraryDialog conversationId={conversation.id} open onClose={() => setShowFiles(false)} /> : null}
      {showAgentManager ? (
        <ConversationAgentManagerDialog
          conversation={conversation}
          open
          onClose={() => setShowAgentManager(false)}
        />
      ) : null}
      {/* P1: Global Context Trace Drawer — accessible from agent messages */}
      <ContextTraceDrawer
        attemptId={traceAttemptId}
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
      />
    </main>
  );
}

/**
 * Which messages the transcript shows.
 *
 * System notices used to be filtered out here, and that split the record: the
 * channel projection sends them to the room (deliberately — a failure nobody
 * hears about is the worst outcome), while the desktop showed nothing. So a
 * failed task appeared in Feishu and nowhere on the desktop. They are included
 * now and styled apart (see `isNoticeMessage`), so both sides tell one story.
 */
export function transcriptMessages(messages: Message[]): Message[] {
  return messages;
}

/** A notice rather than something an agent said: rendered differently, not hidden. */
export function isNoticeMessage(message: Message): boolean {
  return message.role === "system";
}

function MessageBubble({
  message,
  agent,
  conversation,
  isLatestUser,
  highlighted,
  onViewAgent,
  onOpenTrace
}: {
  message: Message;
  agent: Agent | null;
  conversation: import("@/shared/types").Conversation;
  isLatestUser?: boolean;
  highlighted?: boolean;
  onViewAgent?: (agent: Agent, event: ReactMouseEvent<HTMLElement>) => void;
  onOpenTrace?: (runId: string) => void;
}) {
  const isUser = message.role === "user";
  const parentMessage = useAppStore((state) =>
    message.parentMessageId ? state.messages[message.parentMessageId] ?? null : null
  );
  const setReplyTarget = useAppStore((state) => state.setReplyTarget);
  const updateConversation = useAppStore((state) => state.updateConversation);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => extractMessageText(message));
  const [busy, setBusy] = useState<"withdraw" | "edit" | "pin" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pinned = conversation.pinnedMessageIds.includes(message.id);

  const handleWithdraw = async () => {
    setBusy("withdraw");
    setError(null);
    try {
      await requestJson(`/api/messages/${message.id}/withdraw`, { method: "POST" });
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : "撤回失败。");
    } finally {
      setBusy(null);
    }
  };

  const handlePin = async () => {
    setBusy("pin");
    setError(null);
    try {
      const data = await requestJson<{ pinnedMessageIds: string[] }>(`/api/messages/${message.id}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: !pinned })
      });
      updateConversation(conversation.id, { pinnedMessageIds: data.pinnedMessageIds });
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "消息置顶失败。");
    } finally {
      setBusy(null);
    }
  };

  const handleEdit = async () => {
    if (!editText.trim()) return;
    setBusy("edit");
    setError(null);
    try {
      await requestJson(`/api/messages/${message.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText.trim() })
      });
      setEditing(false);
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "编辑失败。");
    } finally {
      setBusy(null);
    }
  };

  const isNotice = isNoticeMessage(message);
  const agentLabel = isNotice ? "通告" : agent?.name ?? "Agent";

  return (
    <article
      id={`message-${message.id}`}
      className={`workspace-message ${isUser ? "is-user" : "is-agent"}${isNotice ? " is-notice" : ""} group flex w-full gap-3 rounded-md transition-colors duration-500 ${
        highlighted ? "bg-amber-100/80 ring-2 ring-amber-300 ring-offset-4 dark:bg-amber-500/15 dark:ring-amber-400/60 dark:ring-offset-slate-950" : ""
      } ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser ? (
        <Avatar
          agent={agent ?? undefined}
          label={agentLabel}
          className="workspace-message-avatar"
          onClick={agent && onViewAgent ? (event) => onViewAgent(agent, event) : undefined}
        />
      ) : null}
      <div
        className={
          isUser
            ? "workspace-message-content flex min-w-0 max-w-[min(80%,560px)] flex-col items-end"
            : "workspace-message-content flex min-w-0 w-full flex-col items-start"
        }
      >
        <div className={`workspace-message-meta flex items-center gap-2 text-xs text-[var(--ui-muted)] ${isUser ? "justify-end" : "justify-start"}`}>
          {!isUser ? <span className="font-semibold text-[var(--foreground)]">{agentLabel}</span> : null}
          <span>{formatTime(message.createdAt)}</span>
          {!isUser && message.status === "streaming" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
        <div
          className={`workspace-message-body break-words ${
            isUser
              ? "w-fit max-w-full rounded-lg bg-[var(--ui-subtle)] px-4 py-2.5"
              : "w-full"
          }`}
        >
          {parentMessage ? (
            <button
              type="button"
              onClick={() => document.getElementById(`message-${parentMessage.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className="mb-2 block w-full truncate rounded-md border-l-2 border-blue-400 bg-white/70 px-2 py-1.5 text-left text-xs text-slate-500 dark:bg-slate-950/50 dark:text-slate-400"
            >
              引用：{extractMessageText(parentMessage).slice(0, 120) || "附件或结构化消息"}
            </button>
          ) : null}
          {editing ? (
            <textarea
              autoFocus
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(false);
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleEdit();
                }
              }}
              className="min-h-24 w-full resize-y rounded-md border border-blue-200 bg-white p-2 text-sm outline-none dark:border-blue-500/40 dark:bg-slate-950 dark:text-slate-100"
            />
          ) : (
            <MessageParts parts={message.parts} messageStatus={message.status} />
          )}
          {!isUser && message.runId ? <DispatchProgress messageId={message.id} /> : null}
        </div>
        <div className={`workspace-message-actions mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 ${isUser ? "justify-end" : "justify-start"}`}>
          <button type="button" onClick={() => setReplyTarget(message.conversationId, message.id)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="引用回复">
            <Reply className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void handlePin()} className={`grid h-7 w-7 place-items-center rounded-md ${pinned ? "bg-amber-50 text-amber-600" : "text-slate-400 hover:bg-amber-50 hover:text-amber-600"}`} title={pinned ? "取消置顶" : "置顶消息"}>
            <Pin className="h-3.5 w-3.5" />
          </button>
          {!isUser && message.runId && onOpenTrace ? (
            <button type="button" onClick={() => onOpenTrace(message.runId!)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-violet-50 hover:text-violet-600" title="上下文追踪">
              <FileSearch className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {isUser && isLatestUser && message.status === "complete" ? (
            <>
              <button type="button" disabled={busy !== null} onClick={() => setEditing((value) => !value)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="编辑">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void handleWithdraw()} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600" title="撤回">
                {busy === "withdraw" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              </button>
            </>
          ) : null}
          {editing ? (
            <button type="button" disabled={busy !== null || !editText.trim()} onClick={() => void handleEdit()} className="h-7 rounded-md bg-blue-600 px-2 text-xs text-white disabled:opacity-50">
              {busy === "edit" ? "保存中" : "保存"}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className={`mt-1 text-xs text-red-600 ${isUser ? "text-right" : ""}`}>{error}</p>
        ) : null}
      </div>
      {isUser ? <Avatar label="我" dark className="workspace-message-avatar" /> : null}
    </article>
  );
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatConnectionStatus(status: import("@/stores/store-types").ConnectionStatus) {
  if (status === "open") return "已连接";
  if (status === "connecting") return "重连中";
  if (status === "closed") return "已断开";
  return "连接异常";
}

function extractMessageText(message: Message) {
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" ? text.content : "";
}

function Avatar({ label, agent, dark, size = "sm", className = "", onClick }: { label: string; agent?: Agent; dark?: boolean; size?: AgentAvatarSize; className?: string; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  if (agent) {
    const avatar = <AgentAvatar agent={agent} size={size} className={className} />;
    return onClick ? <button type="button" className="agent-avatar-button" onClick={onClick} title={`查看 ${label}`} aria-label={`查看 ${label}`}>{avatar}</button> : avatar;
  }
  const content = label.slice(0, 2);
  const base = `grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold ${dark ? "bg-[#4169ff] text-white" : "bg-[var(--ui-subtle)] text-[var(--ui-muted)]"} ${className}`;

  if (onClick) {
    return (
      <button type="button" className={base} onClick={onClick} title={`查看 ${label}`}>
        {content}
      </button>
    );
  }

  return <div className={base}>{content}</div>;
}

function AgentProfileCard({
  agent,
  x,
  y,
  onClose,
  onEdit
}: {
  agent: Agent;
  x: number;
  y: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const description = buildAgentDescription(agent);
  const tools = agent.toolNames.slice(0, 10);
  const hiddenToolCount = Math.max(agent.toolNames.length - tools.length, 0);

  return (
    <Popover x={x} y={y} label={`${agent.name} 信息`} onClose={onClose}>
      <section
        className="relative p-5"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex gap-3 pr-7">
          <Avatar agent={agent} label={agent.name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-slate-950 dark:text-slate-50">{agent.name}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <ProfileBadge>{agent.isConductor ? "Conductor" : agent.isBuiltin ? "内置 Agent" : "自定义 Agent"}</ProfileBadge>
              {agent.supportsVision ? <ProfileBadge tone="green">视觉</ProfileBadge> : null}
              <ProfileBadge tone="slate">{agent.adapterName}</ProfileBadge>
            </div>
          </div>
        </div>

        <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {description}
        </p>

        <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {formatProvider(agent.modelProvider)}
            </span>
            <span>/</span>
            <span className="font-mono">{agent.modelId || "未指定模型"}</span>
          </div>
        </div>

        {agent.capabilities.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.capabilities.slice(0, 4).map((capability) => (
              <span key={capability} className="rounded-md bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-500/15 dark:text-blue-200">
                {capability}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <span key={tool} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {tool}
            </span>
          ))}
          {hiddenToolCount > 0 ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              +{hiddenToolCount}
            </span>
          ) : null}
          {tools.length === 0 ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              无手动工具
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onEdit}
          className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[#4264ff] bg-white text-sm font-medium text-[#2546d8] transition hover:bg-[#eff5ff] dark:bg-slate-900 dark:text-blue-200 dark:hover:bg-blue-500/10"
        >
          <Pencil className="h-4 w-4" />
          编辑配置
        </button>
      </section>
    </Popover>
  );
}

function ProfileBadge({ children, tone = "blue" }: { children: ReactNode; tone?: "blue" | "green" | "slate" }) {
  const className =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200"
      : tone === "slate"
        ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        : "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200";

  return <span className={`rounded-md px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}

function buildAgentDescription(agent: Agent) {
  if (agent.description.trim()) return agent.description.trim();
  const firstPromptParagraph = agent.systemPrompt
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s*/gm, "").trim())
    .find(Boolean);
  return firstPromptParagraph ?? "这个 Agent 还没有单独填写描述。";
}

function formatProvider(provider: ModelProvider | null) {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  if (provider === "volcano-ark") return "火山方舟";
  if (provider === "openai-compatible") return "OpenAI-Compatible";
  if (provider?.startsWith("profile:")) return "自定义供应商";
  return "SDK";
}

function HeaderIcon({ children, title, onClick, active, disabled }: { children: ReactNode; title: string; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button disabled={disabled} className={`workspace-header-action ${active ? "is-active" : ""}`} aria-pressed={active} type="button" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function formatTokenCount(tokens: number) {
  if (tokens <= 0) return "0";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}
