"use client";

import { HelpCircle, Send } from "lucide-react";
import { useState } from "react";

interface PendingQuestionCardProps {
  question: {
    id: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
}

export function PendingQuestionCard({ question }: PendingQuestionCardProps) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

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
    const flat: Record<string, string> = {};
    for (const [idx, labels] of Object.entries(answers)) {
      const q = question.questions[parseInt(idx)];
      flat[q.question] = labels.join("; ");
    }
    await fetch(`/api/pending-questions/${question.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: flat })
    });
    setSubmitted(true);
  };

  if (submitted) return null;

  return (
    <div className="rounded-lg border border-blue-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <HelpCircle className="h-4 w-4 text-blue-600" />
        <span className="text-sm font-medium text-stone-900">Agent 需要你确认</span>
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
            </div>
          );
        })}
      </div>
      <button
        onClick={handleSubmit}
        disabled={Object.keys(answers).length < question.questions.length}
        className="mt-4 flex h-8 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-700"
      >
        <Send className="h-3.5 w-3.5" />
        提交回答
      </button>
    </div>
  );
}
