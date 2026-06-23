"use client";

import { Check, FileText, Loader2, Pencil, Terminal, X, Network } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { DispatchPlanEditor, validatePlan } from "@/components/dispatch-plan-editor";
import { PendingQuestionCard } from "@/components/pending-question-card";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";
import {
  selectConversationPendingBashCommands,
  selectConversationPendingDispatchPlans,
  selectConversationPendingQuestions,
  selectConversationPendingWrites
} from "@/stores/selectors";
import type { DispatchPlanItem, PendingWrite, PendingBashCommand, PendingDispatchPlan } from "@/shared/types";

export function PendingApprovalPanel() {
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useAppStore((s) => s.artifactPanelWidth);
  const agents = useAppStore((s) => s.agents);
  const writes = useAppStore(useShallow((s) => selectConversationPendingWrites(s, s.activeConversationId)));
  const bashes = useAppStore(useShallow((s) => selectConversationPendingBashCommands(s, s.activeConversationId)));
  const plans = useAppStore(useShallow((s) => selectConversationPendingDispatchPlans(s, s.activeConversationId)));
  const questions = useAppStore(useShallow((s) => selectConversationPendingQuestions(s, s.activeConversationId)));

  if (!activeConversationId) return null;

  if (writes.length === 0 && bashes.length === 0 && plans.length === 0 && questions.length === 0) return null;
  const useWideDecisionSurface = questions.length > 0 || plans.length > 0;

  return (
    <div
      className="max-h-[52vh] shrink-0 overflow-y-auto border-t border-slate-200 bg-white px-4 py-3 transition-[margin]"
      style={rightPanelOpen ? { marginRight: rightPanelWidth + 32 } : undefined}
    >
      <div className={`mx-auto space-y-2 ${useWideDecisionSurface ? "max-w-[1100px]" : "max-w-3xl"}`}>
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
  const openDiff = useAppStore((state) => state.openPendingWriteDiff);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleResolve = async (approved: boolean) => {
    setResolving(true);
    setError(null);
    try {
      await requestJson(`/api/pending-writes/${write.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved })
      });
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "审批失败。");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-white p-3 shadow-sm">
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
          onClick={() => openDiff(write.conversationId, write.id)}
        >
          <FileText className="h-3.5 w-3.5" />
          在中央 Diff Tab 查看
        </button>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
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
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleResolve = async (approved: boolean) => {
    setResolving(true);
    setError(null);
    try {
      await requestJson(`/api/pending-bash/${bash.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved })
      });
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "命令审批失败。");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-white p-3 shadow-sm">
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
        {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          disabled={resolving}
          onClick={() => void handleResolve(true)}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          disabled={resolving}
          onClick={() => void handleResolve(false)}
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
  const conversation = useAppStore((s) => s.conversations[plan.conversationId]);
  const [revising, setRevising] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedPlan, setEditedPlan] = useState<DispatchPlanItem[]>(plan.plan);
  const [feedback, setFeedback] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = async (action: "approve" | "reject" | "revise") => {
    if (action === "revise" && !feedback.trim()) {
      setRevising(true);
      return;
    }
    if (action === "approve" && conversation) {
      const validationErrors = validatePlan(editedPlan, agents, conversation);
      if (validationErrors.length > 0) {
        setError(validationErrors[0]);
        return;
      }
    }
    setResolving(true);
    setError(null);
    try {
      await requestJson(`/api/dispatch-plans/${plan.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "revise"
            ? { action, feedback: feedback.trim() }
            : action === "approve"
              ? { action, plan: editedPlan }
              : { action, feedback: feedback.trim() || undefined }
        )
      });
      setRevising(false);
      setFeedback("");
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "计划审批失败。");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border border-blue-300 bg-white p-3 shadow-sm">
      <Network className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-stone-900">编排计划待审批</div>
        {editing && conversation ? (
          <div className="mt-3">
            <DispatchPlanEditor plan={editedPlan} agents={agents} conversation={conversation} onChange={setEditedPlan} />
          </div>
        ) : <div className="mt-2 space-y-1">
          {plan.plan.map((item) => {
            const agent = agents[item.agentId];
            return (
              <div key={item.id} className="rounded-md border border-stone-100 bg-stone-50 px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-stone-400">{item.id}</span>
                  <span>{item.task.slice(0, 80)}</span>
                  <span className="shrink-0 text-stone-400">→</span>
                  <span className="font-medium text-stone-700">{agent?.name ?? item.agentId}</span>
                  {item.dependsOn.length > 0 ? (
                    <span className="shrink-0 text-stone-400">依赖 {item.dependsOn.join(", ")}</span>
                  ) : null}
                </div>
                {(item.acceptanceCriteria?.length ?? 0) > 0 || (item.expectedOutputs?.length ?? 0) > 0 || (item.targetPaths?.length ?? 0) > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.acceptanceCriteria?.map((c, idx) => (
                      <span key={idx} className="rounded bg-purple-50 px-1 py-0.5 text-[10px] text-purple-600">验收: {c}</span>
                    ))}
                    {item.expectedOutputs?.map((o) => (
                      <span key={o.id} className="rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-600">{o.id} · {o.type}</span>
                    ))}
                    {item.targetPaths?.map((p) => (
                      <span key={p} className="rounded bg-amber-50 px-1 py-0.5 font-mono text-[10px] text-amber-600">{p}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>}
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
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          disabled={resolving}
          onClick={() => setEditing((value) => !value)}
          className="grid h-8 w-8 place-items-center rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          title={editing ? "收起结构化编辑" : "结构化编辑计划"}
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          disabled={resolving}
          onClick={() => void handleResolve("approve")}
          className="grid h-8 w-8 place-items-center rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
          title="批准执行"
        >
          {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
        <button
          disabled={resolving}
          onClick={() => void handleResolve("revise")}
          className="grid h-8 w-8 place-items-center rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200"
          title="修改计划"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          disabled={resolving}
          onClick={() => void handleResolve("reject")}
          className="grid h-8 w-8 place-items-center rounded-md bg-red-100 text-red-700 hover:bg-red-200"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
