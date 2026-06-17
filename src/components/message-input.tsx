"use client";

import { ArrowUp, AtSign, Paperclip, ShieldCheck, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Agent, PendingDispatchPlan } from "@/shared/types";

interface MessageInputProps {
  conversationId: string;
  agents: Agent[];
}

export function MessageInput({ conversationId, agents }: MessageInputProps) {
  const draft = useAppStore((state) => state.composerDraft);
  const setDraft = useAppStore((state) => state.setComposerDraft);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const pendingDispatchPlans = useAppStore((state) => state.pendingDispatchPlans);
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  const [reviseForPlanId, setReviseForPlanId] = useState<string | null>(null);
  const mentionedAgents = useMemo(
    () => agents.filter((agent) => mentionedAgentIds.includes(agent.id)),
    [agents, mentionedAgentIds]
  );

  // Check if there's a pending plan for this conversation → revise mode
  const pendingPlan = Object.values(pendingDispatchPlans).find(
    (p) => p.conversationId === conversationId
  ) ?? null;

  const isReviseMode = reviseForPlanId !== null && pendingPlan?.id === reviseForPlanId;

  const submit = async () => {
    if (!draft.trim()) return;

    if (isReviseMode && pendingPlan) {
      // Revise mode: send feedback to plan API
      await fetch(`/api/dispatch-plans/${pendingPlan.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "revise",
          revisedPlan: [{ id: "revise_feedback", agentId: "", task: draft.trim(), dependsOn: [] }]
        })
      });
      setDraft("");
      setReviseForPlanId(null);
      return;
    }

    void sendMessage(conversationId, draft, mentionedAgentIds).then(() => {
      setMentionedAgentIds([]);
    });
  };

  const toggleMention = (agentId: string) => {
    setMentionedAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]
    );
  };

  return (
    <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-4">
      <div className="mx-auto max-w-[760px] rounded-xl border border-slate-200 bg-white p-2 shadow-[0_10px_34px_rgba(15,23,42,0.08)]">
        <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition ${
                mentionedAgentIds.includes(agent.id)
                  ? "border-[#4264ff] bg-[#eff5ff] text-[#2546d8]"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white"
              }`}
              type="button"
              onClick={() => toggleMention(agent.id)}
              title={`@${agent.name}`}
            >
              <AtSign className="h-3.5 w-3.5" />
              {agent.name}
            </button>
          ))}
        </div>

        {mentionedAgents.length > 0 ? (
          <div className="mb-2 px-2 text-xs text-slate-500">
            将指定 {mentionedAgents.map((agent) => agent.name).join("、")} 回复
          </div>
        ) : null}

        {/* Revise mode banner */}
        {isReviseMode ? (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-800">
            <span>📝 计划修订模式 — 输入你对当前计划的修改意见</span>
            <button
              onClick={() => setReviseForPlanId(null)}
              className="grid h-6 w-6 place-items-center rounded text-blue-500 hover:bg-blue-100"
              title="退出修订模式"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : pendingPlan ? (
          <button
            onClick={() => { setReviseForPlanId(pendingPlan.id); setDraft(""); }}
            className="mb-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100 w-full"
          >
            📝 对计划有修改意见？点击进入修订模式
          </button>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            className="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            placeholder={
              isReviseMode
                ? "说明你希望如何调整计划，Enter 提交修改意见"
                : "输入消息，@ 指定 Agent，Enter 发送，Shift+Enter 换行"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1">
            {!isReviseMode ? (
              <>
                <IconButton title="附件入口">
                  <Paperclip className="h-4 w-4" />
                </IconButton>
                <IconButton title="审批模式">
                  <ShieldCheck className="h-4 w-4" />
                </IconButton>
              </>
            ) : null}
            <button
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-white transition disabled:cursor-not-allowed disabled:bg-slate-300 ${
                isReviseMode ? "bg-blue-600 hover:bg-blue-700" : "bg-[#4264ff] hover:bg-[#2f50e6]"
              }`}
              type="button"
              disabled={!draft.trim()}
              onClick={submit}
              title={isReviseMode ? "提交修改意见" : "发送"}
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}

function IconButton({ children, title }: { children: ReactNode; title: string }) {
  return (
    <button
      className="grid h-10 w-10 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
      type="button"
      title={title}
    >
      {children}
    </button>
  );
}
