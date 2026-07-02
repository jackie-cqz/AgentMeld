"use client";

import { Plus, Trash2 } from "lucide-react";
import type { Agent, Conversation, DispatchPlanItem } from "@/shared/types";

export function DispatchPlanEditor({
  plan,
  agents,
  conversation,
  onChange
}: {
  plan: DispatchPlanItem[];
  agents: Record<string, Agent>;
  conversation: Conversation;
  onChange: (plan: DispatchPlanItem[]) => void;
}) {
  const errors = validatePlan(plan, agents, conversation);

  const patchTask = (index: number, patch: Partial<DispatchPlanItem>) => {
    onChange(plan.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task));
  };

  return (
    <div className="space-y-3">
      {plan.map((task, index) => (
        <section key={`${task.id}-${index}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)_150px_80px]">
            <Field label="Task ID">
              <input value={task.id} onChange={(event) => patchTask(index, { id: event.target.value.trim() })} className="h-8 w-full rounded border border-slate-200 bg-white px-2 font-mono text-xs" />
            </Field>
            <Field label="标题">
              <input value={task.title ?? ""} onChange={(event) => patchTask(index, { title: event.target.value })} className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs" />
            </Field>
            <Field label="Agent">
              <select value={task.agentId} onChange={(event) => patchTask(index, { agentId: event.target.value })} className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs">
                {conversation.agentIds.filter((id) => !agents[id]?.isConductor).map((id) => (
                  <option key={id} value={id}>{agents[id]?.name ?? id}</option>
                ))}
              </select>
            </Field>
            <Field label="尝试">
              <input type="number" min={1} max={5} value={task.maxAttempts ?? 1} onChange={(event) => patchTask(index, { maxAttempts: Number(event.target.value) || 1 })} className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs" />
            </Field>
          </div>
          <Field label="任务说明">
            <textarea value={task.task} onChange={(event) => patchTask(index, { task: event.target.value, prompt: event.target.value })} className="min-h-20 w-full resize-y rounded border border-slate-200 bg-white p-2 text-xs leading-5" />
          </Field>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <LineListField label="依赖 Task ID" value={task.dependsOn} onChange={(dependsOn) => patchTask(index, { dependsOn })} />
            <LineListField label="验收标准" value={task.acceptanceCriteria ?? []} onChange={(acceptanceCriteria) => patchTask(index, { acceptanceCriteria })} />
            <LineListField label="目标路径" value={task.targetPaths ?? []} onChange={(targetPaths) => patchTask(index, { targetPaths })} />
            <LineListField label="必需证据" value={task.requiredEvidence ?? []} onChange={(requiredEvidence) => patchTask(index, { requiredEvidence })} />
            <Field label="预期输出（每行 id:type）">
              <textarea
                value={(task.expectedOutputs ?? []).map((output) => `${output.id}:${output.type}`).join("\n")}
                onChange={(event) => patchTask(index, { expectedOutputs: parseOutputs(event.target.value) })}
                className="min-h-20 w-full rounded border border-slate-200 bg-white p-2 font-mono text-xs"
              />
            </Field>
            <Field label="输入绑定（每行 taskId:outputId）">
              <textarea
                value={(task.inputs ?? []).map((input) => `${input.fromTaskId}:${input.outputId}`).join("\n")}
                onChange={(event) => patchTask(index, { inputs: parseInputs(event.target.value) })}
                className="min-h-20 w-full rounded border border-slate-200 bg-white p-2 font-mono text-xs"
              />
            </Field>
            <Field label="必需命令（每行一条）">
              <textarea
                value={(task.requiredCommands ?? []).map((command) => command.command).join("\n")}
                onChange={(event) => patchTask(index, { requiredCommands: splitLines(event.target.value).map((command) => ({ command })) })}
                className="min-h-20 w-full rounded border border-slate-200 bg-white p-2 font-mono text-xs"
              />
            </Field>
          </div>
          <button type="button" onClick={() => onChange(plan.filter((_, taskIndex) => taskIndex !== index))} className="mt-2 flex items-center gap-1 text-xs text-red-600 hover:text-red-700">
            <Trash2 className="h-3.5 w-3.5" />删除任务
          </button>
        </section>
      ))}
      <button
        type="button"
        onClick={() => onChange([...plan, {
          id: `t${plan.length + 1}`,
          agentId: conversation.agentIds.find((id) => !agents[id]?.isConductor) ?? "",
          task: "",
          dependsOn: [],
          acceptanceCriteria: [""],
          maxAttempts: 1
        }])}
        className="flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs text-slate-600 hover:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" />添加任务
      </button>
      {errors.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {errors.map((error) => <div key={error}>• {error}</div>)}
        </div>
      ) : null}
    </div>
  );
}

export function validatePlan(
  plan: DispatchPlanItem[],
  agents: Record<string, Agent>,
  conversation: Conversation
) {
  const errors: string[] = [];
  if (plan.length === 0) errors.push("计划至少需要一个任务。");
  const ids = plan.map((task) => task.id.trim());
  const idSet = new Set(ids);
  if (ids.some((id) => !id)) errors.push("Task ID 不能为空。");
  if (idSet.size !== ids.length) errors.push("Task ID 必须唯一。");
  const outputIds = new Set<string>();
  for (const task of plan) {
    if (!task.task.trim()) errors.push(`${task.id || "未命名任务"}：任务说明不能为空。`);
    if (!conversation.agentIds.includes(task.agentId) || !agents[task.agentId]) errors.push(`${task.id}：Agent 不属于当前会话。`);
    if (agents[task.agentId]?.isConductor) errors.push(`${task.id}：不能分配给 Conductor 自己。`);
    for (const dependency of task.dependsOn) {
      if (!idSet.has(dependency)) errors.push(`${task.id}：依赖 ${dependency} 不存在。`);
      if (dependency === task.id) errors.push(`${task.id}：不能依赖自身。`);
    }
    if ((task.acceptanceCriteria ?? []).some((criterion) => !criterion.trim())) errors.push(`${task.id}：验收标准不能为空。`);
    for (const output of task.expectedOutputs ?? []) {
      const key = `${task.id}:${output.id}`;
      if (!output.id.trim()) errors.push(`${task.id}：输出 ID 不能为空。`);
      if (outputIds.has(key)) errors.push(`${task.id}：输出 ID ${output.id} 重复。`);
      outputIds.add(key);
    }
  }
  if (hasCycle(plan)) errors.push("任务依赖存在循环。");
  return Array.from(new Set(errors));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[11px] text-slate-500">{label}<div className="mt-1">{children}</div></label>;
}

function LineListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <Field label={`${label}（每行一项）`}>
      <textarea value={value.join("\n")} onChange={(event) => onChange(splitLines(event.target.value))} className="min-h-20 w-full rounded border border-slate-200 bg-white p-2 text-xs" />
    </Field>
  );
}

function splitLines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function parseOutputs(value: string): DispatchPlanItem["expectedOutputs"] {
  return splitLines(value).map((line) => {
    const [id, rawType] = line.split(":");
    const type = rawType === "web_app" || rawType === "image" || rawType === "ppt" ? rawType : "document";
    return { id: id.trim(), type };
  });
}

function parseInputs(value: string): DispatchPlanItem["inputs"] {
  return splitLines(value).map((line) => {
    const [fromTaskId, outputId] = line.split(":");
    return { fromTaskId: fromTaskId?.trim() ?? "", outputId: outputId?.trim() ?? "", required: true };
  });
}

function hasCycle(plan: DispatchPlanItem[]) {
  const map = new Map(plan.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of map.get(id)?.dependsOn ?? []) {
      if (map.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return plan.some((task) => visit(task.id));
}
