"use client";

import { HelpCircle, Loader2, Send } from "lucide-react";
import { useState } from "react";
import type { PendingQuestion } from "@/shared/types";

interface PendingQuestionCardProps {
  question: PendingQuestion;
  agentName?: string;
}

export function PendingQuestionCard({ question, agentName }: PendingQuestionCardProps) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (qIdx: number, label: string, multi: boolean) => {
    setAnswers((prev) => {
      const key = String(qIdx);
      const current = prev[key] ?? [];
      if (multi) {
        return { ...prev, [key]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
      }
      return { ...prev, [key]: [label] };
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    const flat: Record<string, string> = {};
    for (let index = 0; index < question.questions.length; index++) {
      const item = question.questions[index];
      flat[item.question] = item.options.length > 0
        ? (answers[String(index)] ?? []).join("; ")
        : (freeText[String(index)] ?? "").trim();
    }
    try {
      const response = await fetch(`/api/pending-questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: flat })
      });
      if (!response.ok) throw new Error("提交回答失败。");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交回答失败。");
      setSubmitting(false);
    }
  };

  const complete = question.questions.every((item, index) =>
    item.options.length > 0
      ? (answers[String(index)] ?? []).length > 0
      : Boolean(freeText[String(index)]?.trim())
  );

  return (
    <div className="rounded-lg border border-blue-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle className="h-4 w-4 text-blue-600" />
        <div>
          <div className="text-sm font-medium text-stone-900">{agentName ?? question.agentId} 需要你确认</div>
          <div className="text-[11px] text-stone-400">Run {question.runId}</div>
        </div>
      </div>
      <div className="space-y-4">
        {question.questions.map((q, qi) => {
          const selected = answers[String(qi)] ?? [];
          return (
            <div key={qi}>
              <div className="text-xs font-medium text-stone-500 uppercase mb-1">{q.header}</div>
              <div className="text-sm text-stone-800 mb-2">{q.question}</div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => handleSelect(qi, opt.label, !!q.multiSelect)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      selected.includes(opt.label)
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
                    }`}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {q.options.length === 0 ? (
                <textarea
                  className="mt-2 min-h-20 w-full resize-y rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                  placeholder="输入你的回答"
                  value={freeText[String(qi)] ?? ""}
                  onChange={(event) => setFreeText((current) => ({ ...current, [String(qi)]: event.target.value }))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        onClick={handleSubmit}
        disabled={!complete || submitting}
        className="mt-4 flex h-8 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-700"
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        {submitting ? "提交中..." : "提交回答"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
