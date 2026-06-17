"use client";

import { Circle, Folder, GitBranch, Layers, Loader2, Pencil, RotateCcw, UserPlus, Users } from "lucide-react";
import { useMemo, useRef, useEffect, type ReactNode } from "react";
import { MessageInput } from "@/components/message-input";
import { MessageParts } from "@/components/message-parts";
import { PendingApprovalPanel } from "@/components/pending-approval-panel";
import { useAppStore } from "@/stores/app-store";
import type { Agent, Message } from "@/shared/types";

export function ChatPanel() {
  const agents = useAppStore((state) => state.agents);
  const conversations = useAppStore((state) => state.conversations);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const messagesByConversation = useAppStore((state) => state.messagesByConversation);
  const runsByConversation = useAppStore((state) => state.runsByConversation);
  const connectionStatus = useAppStore((state) => state.connectionStatus);
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const conversation = activeConversationId ? conversations[activeConversationId] : null;
  const messages = activeConversationId ? messagesByConversation[activeConversationId] ?? [] : [];
  const runs = activeConversationId ? runsByConversation[activeConversationId] ?? [] : [];
  const runningCount = runs.filter((run) => run.status === "running").length;
  const tokenTotal = runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0), 0);

  const activeAgents = useMemo(
    () => conversation?.agentIds.map((id) => agents[id]).filter((agent): agent is Agent => Boolean(agent)) ?? [],
    [agents, conversation]
  );

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, runningCount]);

  if (!conversation) {
    return (
      <main className="grid min-w-0 flex-1 place-items-center bg-[#fbfaf7]">
        <div className="text-sm text-stone-500">正在准备工作空间...</div>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex -space-x-2">
            {activeAgents.slice(0, 3).map((agent) => (
              <Avatar key={agent.id} label={agent.name} className="ring-2 ring-white" />
            ))}
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
          <HeaderIcon title="调度视图"><GitBranch className="h-4 w-4" /></HeaderIcon>
          <HeaderIcon title="打开 Artifact Workspace" onClick={() => setRightPanelOpen(true)}><Layers className="h-4 w-4" /></HeaderIcon>
          <HeaderIcon title="文件"><Folder className="h-4 w-4" /></HeaderIcon>
          <HeaderIcon title="添加 Agent"><UserPlus className="h-4 w-4" /></HeaderIcon>
          <div className="flex h-8 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-500">
            <Circle className="h-3 w-3 text-slate-400" />
            {formatTokenCount(tokenTotal)}
          </div>
          <div
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium ${
              connectionStatus === "open" ? "bg-[#4169ff] text-white" : "bg-amber-100 text-amber-800"
            }`}
          >
            <Circle className="h-2 w-2 fill-current" />
            {connectionStatus === "open" ? "已连接" : connectionStatus}
          </div>
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto bg-white px-4 py-6">
        <div className="mx-auto max-w-[760px] space-y-7">
          {messages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
              发送一条消息，启动这个群聊里的 Agent 协作。
            </div>
          ) : null}
          {(() => {
            const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
            const latestUserId = latestUserMsg?.id ?? null;
            return messages.map((message) => (
              <MessageBubble key={message.id} message={message} agent={message.agentId ? agents[message.agentId] : null} isLatestUser={message.id === latestUserId} />
            ));
          })()}
        </div>
      </div>

      <PendingApprovalPanel />
      <MessageInput conversationId={conversation.id} agents={activeAgents} />
    </main>
  );
}

function MessageBubble({ message, agent, isLatestUser }: { message: Message; agent: Agent | null; isLatestUser?: boolean }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  const handleWithdraw = async () => {
    await fetch(`/api/messages/${message.id}/withdraw`, { method: "POST" });
  };

  return (
    <article className={`flex gap-3 group ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser ? <Avatar label={isSystem ? "系统" : agent?.name ?? "A"} muted={isSystem} /> : null}
      <div className={`${isUser ? "max-w-[54%]" : "max-w-[78%]"} min-w-0`}>
        {!isUser ? (
          <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{isSystem ? "System" : agent?.name ?? "Agent"}</span>
            <span>{formatTime(message.createdAt)}</span>
            {message.status === "streaming" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          </div>
        ) : null}
        <div
          className={`rounded-xl px-4 py-3 ${
            isUser
              ? "border border-[#bdd0ff] bg-[#eff5ff] text-slate-900 shadow-sm"
              : isSystem
                ? "border border-slate-200 bg-slate-50 text-slate-700"
                : "border border-slate-200 bg-white text-slate-900 shadow-sm"
          }`}
        >
          <MessageParts parts={message.parts} />
        </div>
        {isUser && isLatestUser && message.status === "complete" ? (
          <div className="mt-1 flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
            <button onClick={handleWithdraw} className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600" title="撤回">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {isUser ? <Avatar label="你" dark /> : null}
    </article>
  );
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function Avatar({ label, dark, muted, className = "" }: { label: string; dark?: boolean; muted?: boolean; className?: string }) {
  return (
    <div
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold ${
        dark ? "bg-[#4169ff] text-white" : muted ? "bg-slate-100 text-slate-500" : "bg-emerald-500 text-white"
      } ${className}`}
    >
      {label.slice(0, 2)}
    </div>
  );
}

function HeaderIcon({ children, title, onClick }: { children: ReactNode; title: string; onClick?: () => void }) {
  return (
    <button className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100" type="button" title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function formatTokenCount(tokens: number) {
  if (tokens <= 0) return "0 tok";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens} tok`;
}
