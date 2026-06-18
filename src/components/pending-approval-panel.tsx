"use client";

import { Check, ChevronDown, ChevronUp, FileText, Pencil, Terminal, X, Network } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileDiffView } from "@/components/file-diff-view";
import { PendingQuestionCard } from "@/components/pending-question-card";
import { useAppStore } from "@/stores/app-store";
import {
  selectConversationPendingBashCommands,
  selectConversationPendingDispatchPlans,
  selectConversationPendingQuestions,
  selectConversationPendingWrites
} from "@/stores/selectors";
import type { PendingWrite, PendingBashCommand, PendingDispatchPlan } from "@/shared/types";

export function PendingApprovalPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const agents = useAppStore((s) => s.agents);
  const writes = useAppStore(useShallow((s) => selectConversationPendingWrites(s, s.activeConversationId)));
  const bashes = useAppStore(useShallow((s) => selectConversationPendingBashCommands(s, s.activeConversationId)));
  const plans = useAppStore(useShallow((s) => selectConversationPendingDispatchPlans(s, s.activeConversationId)));
  const questions = useAppStore(useShallow((s) => selectConversationPendingQuestions(s, s.activeConversationId)));

  if (!activeConversationId) return null;

  if (writes.length === 0 && bashes.length === 0 && plans.length === 0 && questions.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-6 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        {plans.map((plan) => (
          <DispatchPlanCard key={plan.id} plan={plan} />
        ))}
        {questions.map((question) => (
          <PendingQuestionCard
            key={question.id}
            question={question}
            agentName={agents[question.agentId]?.name ?? question.agentId}
          />
        ))}
        {writes.map((write) => (
          <PendingWriteCard key={write.id} write={write} />
        ))}
        {bashes.map((bash) => (
          <PendingBashCard key={bash.id} bash={bash} />
        ))}
      </div>
    </div>
  );
}

function PendingWriteCard({ write }: { write: PendingWrite }) {
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const handleResolve = async (approved: boolean) => {
    setResolving(true);
    try {
      await fetch(`/api/pending-writes/${write.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved })
      });
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-white p-3 shadow-sm">
      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">文件写入审批</div>
        <div className="mt-1 text-xs text-stone-600 font-mono truncate">{write.path}</div>
        <div className="mt-1 text-xs text-stone-500">
          Agent {write.agentId} · Run {write.runId} · {write.newContent.length} 字符
        </div>
        <button
          type="button"
          className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? "收起变更" : "查看完整变更"}
        </button>
        {expanded ? (
          <div className="mt-2">
            <FileDiffView oldContent={write.oldContent} newContent={write.newContent} />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve(true)}
          disabled={resolving}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve(false)}
          disabled={resolving}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PendingBashCard({ bash }: { bash: PendingBashCommand }) {
  const handleResolve = async (approved: boolean) => {
    await fetch(`/api/pending-bash/${bash.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved })
    });
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-white p-3 shadow-sm">
      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">命令执行审批</div>
        <div className="mt-1 text-xs text-stone-600 font-mono truncate">{bash.command}</div>
        <div className="mt-1 text-xs text-stone-500">
          cwd: {bash.cwd} · Agent: {bash.agentId}
        </div>
        {bash.reason ? (
          <div className="mt-1 text-xs text-stone-500">原因: {bash.reason}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve(true)}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve(false)}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝执行"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function DispatchPlanCard({ plan }: { plan: PendingDispatchPlan }) {
  const agents = useAppStore((s) => s.agents);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  const handleResolve = async (action: "approve" | "reject" | "revise") => {
    if (action === "revise" && !feedback.trim()) {
      setRevising(true);
      return;
    }
    await fetch(`/api/dispatch-plans/${plan.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "revise"
          ? { action, feedback: feedback.trim() }
          : { action }
      )
    });
    setRevising(false);
    setFeedback("");
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-blue-300 bg-white p-3 shadow-sm">
      <Network className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">编排计划待审批</div>
        <div className="mt-2 space-y-1">
          {plan.plan.map((item) => {
            const agent = agents[item.agentId];
            return (
              <div key={item.id} className="flex items-center gap-2 text-xs text-stone-600">
                <span className="font-mono text-stone-400">{item.id}</span>
                <span>{item.task.slice(0, 60)}</span>
                <span className="text-stone-400">→</span>
                <span className="font-medium">{agent?.name ?? item.agentId}</span>
                {item.dependsOn.length > 0 ? (
                  <span className="text-stone-400">depends: {item.dependsOn.join(", ")}</span>
                ) : null}
              </div>
            );
          })}
        </div>
        {revising ? (
          <div className="mt-2 flex gap-2">
            <input
              className="h-8 flex-1 rounded border border-stone-200 px-2 text-xs outline-none focus:border-blue-400"
              placeholder="修改意见（自然语言描述）"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleResolve("revise"); }}
            />
            <button onClick={() => setRevising(false)} className="text-xs text-stone-500">取消</button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          onClick={() => handleResolve("approve")}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve("revise")}
          className="grid h-8 w-8 place-items-center rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200"
          title="修改计划"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={() => handleResolve("reject")}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
