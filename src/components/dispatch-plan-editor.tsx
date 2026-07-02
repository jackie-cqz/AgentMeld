"use client";

import type { Agent, Conversation, DispatchPlanItem } from "@/shared/types";

export function validatePlan(
  plan: DispatchPlanItem[],
  agents: Record<string, Agent>,
  conversation: Conversation
): string[] {
  const errors: string[] = [];

  for (const item of plan) {
    const agent = agents[item.agentId];
    if (agent?.isConductor) {
      errors.push(`任务 "${item.id}" 不能分配给 Conductor Agent "${item.agentId}"`);
    }
  }

  const taskIds = new Set(plan.map((item) => item.id));
  for (const item of plan) {
    for (const dep of item.dependsOn) {
      if (!taskIds.has(dep)) {
        errors.push(`任务 "${item.id}" 依赖不存在的任务 "${dep}"`);
      }
    }
  }

  // Simple cycle detection via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function dfs(taskId: string): boolean {
    if (inStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    inStack.add(taskId);
    const task = plan.find((t) => t.id === taskId);
    if (task) {
      for (const dep of task.dependsOn) {
        if (dfs(dep)) return true;
      }
    }
    inStack.delete(taskId);
    return false;
  }
  for (const item of plan) {
    if (dfs(item.id)) {
      errors.push(`Plan 包含循环依赖，请检查 dependsOn 配置`);
      break;
    }
  }

  return errors;
}
