"use client";

import { Check, HelpCircle, Loader2, Send } from "lucide-react";
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
  const answeredCount = question.questions.filter((item, index) =>
    item.options.length > 0
      ? (answers[String(index)] ?? []).length > 0
      : Boolean(freeText[String(index)]?.trim())
  ).length;

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
            <HelpCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-950">需要你的选择</div>
            <div className="mt-0.5 truncate text-xs text-slate-500">
              {agentName ?? question.agentId} 正在等待确认
            </div>
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
          {answeredCount}/{question.questions.length}
        </span>
      </header>

      <div className="space-y-3 p-4">
        {question.questions.map((q, qi) => {
          const selected = answers[String(qi)] ?? [];
          return (
            <fieldset key={qi} className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <legend className="sr-only">{q.header}</legend>
              <div className="mb-1 text-[11px] font-medium text-slate-500">{q.header}</div>
              <div className="mb-3 text-sm font-medium leading-5 text-slate-900">{q.question}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => handleSelect(qi, opt.label, !!q.multiSelect)}
                    className={`flex min-h-10 items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                      selected.includes(opt.label)
                        ? "border-blue-500 bg-blue-50 text-blue-800 shadow-sm"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                    title={opt.description}
                  >
                    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                      selected.includes(opt.label)
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-slate-300 bg-white"
                    }`}>
                      {selected.includes(opt.label) ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{opt.label}</span>
                      {opt.description ? (
                        <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-slate-500">
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              {q.options.length === 0 ? (
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
                  placeholder="输入你的回答"
                  value={freeText[String(qi)] ?? ""}
                  onChange={(event) => setFreeText((current) => ({ ...current, [String(qi)]: event.target.value }))}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>

      <footer className="flex items-center justify-between gap-4 border-t border-slate-100 bg-white px-4 py-3">
        <div className="min-w-0 text-xs text-slate-500">
          {complete ? "已完成所有选择" : `还需回答 ${question.questions.length - answeredCount} 项`}
          {error ? <span className="ml-2 text-red-600">{error}</span> : null}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!complete || submitting}
          className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {submitting ? "提交中..." : "提交回答"}
        </button>
      </footer>
    </section>
  );
}
