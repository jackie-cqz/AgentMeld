"use client";

import { Circle, Loader2, Users } from "lucide-react";
import { useMemo, useRef, useEffect } from "react";
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
  const scrollerRef = useRef<HTMLDivElement>(null);

  const conversation = activeConversationId ? conversations[activeConversationId] : null;
  const messages = activeConversationId ? messagesByConversation[activeConversationId] ?? [] : [];
  const runs = activeConversationId ? runsByConversation[activeConversationId] ?? [] : [];
  const runningCount = runs.filter((run) => run.status === "running").length;

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
    <main className="flex min-w-0 flex-1 flex-col bg-[#fbfaf7]">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 bg-white px-6">
        <div>
          <h1 className="text-base font-semibold text-stone-950">{conversation.title}</h1>
          <div className="mt-1 flex items-center gap-3 text-xs text-stone-500">
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5" />
              {conversation.mode === "group" ? "群聊" : "单聊"} · {activeAgents.length} 位 Agent
            </span>
            <span className="flex items-center gap-1">
              <Circle className={`h-2 w-2 fill-current ${connectionStatus === "open" ? "text-emerald-500" : "text-amber-500"}`} />
              {connectionStatus}
            </span>
          </div>
        </div>
        {runningCount > 0 ? (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
            <Loader2 className="h-4 w-4 animate-spin" />
            {runningCount} 个 Agent 正在回复
          </div>
        ) : null}
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed border-stone-300 bg-white p-6 text-center text-sm text-stone-500">
              发送一条消息，启动这个群聊里的 Agent 协作。
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} agent={message.agentId ? agents[message.agentId] : null} />
          ))}
        </div>
      </div>

      <PendingApprovalPanel />
      <MessageInput conversationId={conversation.id} agents={activeAgents} />
    </main>
  );
}

function MessageBubble({ message, agent }: { message: Message; agent: Agent | null }) {
  const isUser = message.role === "user";
  return (
    <article className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser ? <Avatar label={agent?.name ?? "A"} /> : null}
      <div className={`max-w-[78%] ${isUser ? "order-first" : ""}`}>
        {!isUser ? (
          <div className="mb-1 flex items-center gap-2 text-xs text-stone-500">
            <span className="font-medium text-stone-700">{agent?.name ?? "Agent"}</span>
            <span>{message.status}</span>
            <span>{formatTime(message.createdAt)}</span>
          </div>
        ) : null}
        <div
          className={`rounded-md px-4 py-3 ${
            isUser ? "bg-stone-950 text-white" : "border border-stone-200 bg-white text-stone-900 shadow-sm"
          }`}
        >
          <MessageParts parts={message.parts} />
        </div>
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

function Avatar({ label, dark }: { label: string; dark?: boolean }) {
  return (
    <div
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-md text-xs font-semibold ${
        dark ? "bg-stone-950 text-white" : "bg-emerald-100 text-emerald-900"
      }`}
    >
      {label.slice(0, 2)}
    </div>
  );
}
