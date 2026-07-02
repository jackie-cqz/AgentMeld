"use client";

import { Circle, Folder, GitBranch, Layers, Loader2, Pencil, Pin, Reply, RotateCcw, UserPlus, Users, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { MessageInput } from "@/components/message-input";
import { MessageParts } from "@/components/message-parts";
import { DispatchProgress } from "@/components/dispatch-progress";
import { PendingApprovalPanel } from "@/components/pending-approval-panel";
import { ContextStatsPanel } from "@/components/context-stats-panel";
import { ConversationTimeline } from "@/components/conversation-timeline";
import { ConversationTabBar } from "@/components/conversation-tab-bar";
import { ConversationAgentManagerDialog } from "@/components/conversation-agent-manager-dialog";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { FileLibraryDialog } from "@/components/file-library-dialog";
import { FileTab } from "@/components/file-tab";
import { PendingWriteDiffTab } from "@/components/pending-write-diff-tab";
import { PinnedMessagesBar } from "@/components/pinned-messages-bar";
import { requestJson } from "@/lib/request-json";
import { getAgentAvatarLabel, getAgentAvatarStyle } from "@/shared/agent-avatar";
import { useAppStore } from "@/stores/app-store";
import {
  selectActiveConversation,
  selectConversationMessages,
  selectConversationRuns,
  selectLatestUserMessageId
} from "@/stores/selectors";
import type { Agent, Message } from "@/shared/types";
import type { AdapterName, ModelProvider } from "@/shared/types";

const WIDE_CONVERSATION_WIDTH = 1480;
const RIGHT_PANEL_GAP = 32;

export function ChatPanel() {
  const agents = useAppStore((state) => state.agents);
  const darkMode = useAppStore((state) => state.darkMode);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const conversation = useAppStore(selectActiveConversation);
  const messages = useAppStore(useShallow((state) => selectConversationMessages(state, state.activeConversationId)));
  const runs = useAppStore(useShallow((state) => selectConversationRuns(state, state.activeConversationId)));
  const latestUserId = useAppStore((state) => selectLatestUserMessageId(state, state.activeConversationId));
  const highlightedMessageId = useAppStore((state) => state.highlightedMessageId);
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const rightPanelMode = useAppStore((state) => state.rightPanelMode);
  const rightPanelWidth = useAppStore((state) => state.artifactPanelWidth);
  const activeTab = useAppStore((state) =>
    state.activeConversationId ? state.activeTabByConversation[state.activeConversationId] ?? "chat" : "chat"
  );
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const setRightPanelMode = useAppStore((state) => state.setRightPanelMode);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousConversationIdRef = useRef<string | null>(null);
  const previousActiveTabRef = useRef<string | null>(null);
  const [showContextStats, setShowContextStats] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [agentProfile, setAgentProfile] = useState<{ agent: Agent; x: number; y: number } | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const loadBootstrap = useAppStore((s) => s.loadBootstrap);

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
    name: string; description: string; capabilities?: string[]; adapterName: AdapterName; modelProvider?: ModelProvider | null;
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
  const conversationContentClass = rightPanelOpen ? "space-y-7" : "max-w-[1480px] space-y-7";
  const conversationContentStyle = rightPanelOpen
    ? {
        maxWidth: WIDE_CONVERSATION_WIDTH
      }
    : undefined;
  const headerContentStyle = rightPanelOpen
    ? { marginRight: rightPanelWidth + RIGHT_PANEL_GAP }
    : undefined;

  const activeAgents = useMemo(
    () => conversation?.agentIds.map((id) => agents[id]).filter((agent): agent is Agent => Boolean(agent)) ?? [],
    [agents, conversation]
  );
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role !== "system"),
    [messages]
  );

  useLayoutEffect(() => {
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

    if (stickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [activeConversationId, activeTab, visibleMessages.length, runningCount]);

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
    <main className={`flex min-w-0 flex-1 flex-col ${darkMode ? "bg-[#0b1020]" : "bg-white"}`}>
      <header className={`flex h-[72px] shrink-0 items-center border-b px-4 ${darkMode ? "border-slate-700 bg-[#111827]" : "border-slate-200 bg-white"}`}>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-4" style={headerContentStyle}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex shrink-0 -space-x-2">
              {activeAgents.slice(0, 3).map((agent) => (
                <Avatar
                  key={agent.id}
                  agent={agent}
                  label={agent.name}
                  displayLabel={getAgentAvatarLabel(agent)}
                  compact
                  className="border-2 border-white text-[11px] shadow-sm transition-transform hover:z-10 hover:-translate-y-0.5"
                  onClick={(event) => handleViewAgent(agent, event)}
                />
              ))}
              {activeAgents.length > 3 ? (
                <div
                  className="relative z-0 grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-white bg-slate-100 text-[11px] font-semibold text-slate-500 shadow-sm dark:border-slate-900 dark:bg-slate-700 dark:text-slate-200"
                  title={`还有 ${activeAgents.length - 3} 位 Agent`}
                >
                  +{activeAgents.length - 3}
                </div>
              ) : null}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold leading-6 text-slate-950">{conversation.title}</h1>
              <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {conversation.mode === "group" ? "群聊" : "单聊"} · {activeAgents.length} 位 Agent
              </span>
            </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <HeaderIcon title="工作区文件" onClick={() => {
              if (rightPanelMode === "files" && rightPanelOpen) setRightPanelOpen(false);
              else setRightPanelMode("files");
            }} active={rightPanelMode === "files" && rightPanelOpen}><GitBranch className="h-4 w-4" /></HeaderIcon>
            <HeaderIcon title="Artifact Workspace" onClick={() => {
              if (rightPanelMode === "artifact" && rightPanelOpen) setRightPanelOpen(false);
              else { setRightPanelMode("artifact"); setRightPanelOpen(true); }
            }} active={rightPanelMode === "artifact" && rightPanelOpen}><Layers className="h-4 w-4" /></HeaderIcon>
            <HeaderIcon title="会话文件" onClick={() => setShowFiles(true)}><Folder className="h-4 w-4" /></HeaderIcon>
            <HeaderIcon title="管理会话 Agent" onClick={() => setShowAgentManager(true)}><UserPlus className="h-4 w-4" /></HeaderIcon>
            <div className="relative">
              <button
                onClick={() => setShowContextStats((prev) => !prev)}
                className="flex h-8 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                title="上下文统计与压缩"
              >
                <Circle className="h-3 w-3 text-slate-400" />
                {formatTokenCount(tokenTotal)}
              </button>
              {showContextStats && activeConversationId && (
                <ContextStatsPanel
                  conversationId={activeConversationId}
                  onClose={() => setShowContextStats(false)}
                />
              )}
            </div>
            <div
              className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${
                connectionStatus === "open"
                  ? "bg-[#4169ff] text-white"
                  : connectionStatus === "error"
                    ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
              }`}
            >
              <Circle className="h-2 w-2 fill-current" />
              {formatConnectionStatus(connectionStatus)}
            </div>
          </div>
        </div>
      </header>

      <ConversationTabBar conversationId={conversation.id} />

      <div className="relative flex-1 overflow-hidden">
        {activeTab === "chat" ? (
          <>
            <div
              ref={scrollerRef}
              className="h-full overflow-y-auto py-6 pl-4 pr-12"
              style={rightPanelOpen ? { width: `calc(100% - ${rightPanelWidth}px)` } : undefined}
              onScroll={(event) => {
                const scroller = event.currentTarget;
                stickToBottomRef.current =
                  scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
              }}
            >
              <PinnedMessagesBar conversation={conversation} />
              <div className={conversationContentClass} style={conversationContentStyle}>
                {visibleMessages.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400">
                    发送一条消息，启动这个群聊里的 Agent 协作。
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
                  />
                ))}
              </div>
            </div>
            <ConversationTimeline
              messages={visibleMessages}
              scrollerRef={scrollerRef}
              rightOffset={rightPanelOpen ? rightPanelWidth : 0}
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
            rightPanelOpen={rightPanelOpen}
            rightPanelWidth={rightPanelWidth}
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
    </main>
  );
}

function MessageBubble({
  message,
  agent,
  conversation,
  isLatestUser,
  highlighted,
  onViewAgent
}: {
  message: Message;
  agent: Agent | null;
  conversation: import("@/shared/types").Conversation;
  isLatestUser?: boolean;
  highlighted?: boolean;
  onViewAgent?: (agent: Agent, event: ReactMouseEvent<HTMLElement>) => void;
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

  const agentLabel = agent?.name ?? "Agent";

  return (
    <article
      id={`message-${message.id}`}
      className={`group flex w-full gap-3 rounded-md transition-colors duration-500 ${
        highlighted ? "bg-amber-100/80 ring-2 ring-amber-300 ring-offset-4 dark:bg-amber-500/15 dark:ring-amber-400/60 dark:ring-offset-slate-950" : ""
      } ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser ? (
        <Avatar
          agent={agent ?? undefined}
          label={agentLabel}
          className="mt-1 h-9 w-9"
          onClick={agent && onViewAgent ? (event) => onViewAgent(agent, event) : undefined}
        />
      ) : null}
      <div
        className={
          isUser
            ? "flex min-w-0 max-w-[min(75%,420px)] flex-col items-end"
            : "flex min-w-0 w-full max-w-[min(100%,1160px)] flex-col items-start pr-2"
        }
      >
        <div className={`mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-500 ${isUser ? "justify-end" : "justify-start"}`}>
          <span className="font-medium text-slate-700 dark:text-slate-300">{isUser ? "我" : agentLabel}</span>
          <span>{formatTime(message.createdAt)}</span>
          {!isUser && message.status === "streaming" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
        <div
          className={`break-words ${
            isUser
              ? "w-fit max-w-full rounded-xl border border-[#bdd0ff] bg-[#eff5ff] px-4 py-3 text-slate-900 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-50"
              : "w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
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
        <div className={`mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100 ${isUser ? "justify-end" : "justify-start"}`}>
          <button type="button" onClick={() => setReplyTarget(message.conversationId, message.id)} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="引用回复">
            <Reply className="h-3.5 w-3.5" />
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void handlePin()} className={`grid h-7 w-7 place-items-center rounded-md ${pinned ? "bg-amber-50 text-amber-600" : "text-slate-400 hover:bg-amber-50 hover:text-amber-600"}`} title={pinned ? "取消置顶" : "置顶消息"}>
            <Pin className="h-3.5 w-3.5" />
          </button>
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
      {isUser ? <Avatar label="我" dark /> : null}
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

function Avatar({ label, displayLabel, agent, dark, muted, compact, className = "", onClick }: { label: string; displayLabel?: string; agent?: Agent; dark?: boolean; muted?: boolean; compact?: boolean; className?: string; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  const agentColor = agent ? getAgentAvatarStyle(agent).solid : "bg-emerald-600 text-white";
  const content = displayLabel ?? label.slice(0, 2);
  const sizeClass = compact ? "h-8 w-8" : "h-9 w-9";
  const base = `grid ${sizeClass} shrink-0 place-items-center rounded-full text-xs font-semibold ${
    dark ? "bg-[#4169ff] text-white" : muted ? "bg-slate-100 text-slate-500" : agentColor
  } ${className}`;

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
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <section
        className="absolute w-[min(380px,calc(100vw-24px))] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        style={{ left: x, top: y }}
        onMouseDown={(event) => event.stopPropagation()}
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
          <Avatar agent={agent} label={agent.name} className="h-12 w-12 text-sm" />
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
    </div>
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
  return "SDK";
}

function HeaderIcon({ children, title, onClick, active, disabled }: { children: ReactNode; title: string; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button disabled={disabled} className={`grid h-9 w-9 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40 ${active ? "bg-[#eef2ff] text-[#4264ff] dark:bg-blue-500/20 dark:text-blue-200" : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"}`} type="button" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function formatTokenCount(tokens: number) {
  if (tokens <= 0) return "0 tok";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens} tok`;
}
