import { approvePlan, rejectPlan } from "@/server/dispatch-plan-manager";
import { eventBus, type EventBus } from "@/server/event-bus";
import { approvePendingBash, rejectPendingBash } from "@/server/pending-bash";
import { answerQuestion } from "@/server/pending-questions";
import { approvePendingWrite, rejectPendingWrite } from "@/server/pending-writes";
import type {
  BenchmarkApprovalScriptEntry,
  BenchmarkApprovalType,
  BenchmarkUserScript,
} from "@/server/context-metrics/benchmark-types";
import type { PendingBashCommand, PendingDispatchPlan, PendingQuestion, PendingWrite } from "@/shared/types";

export interface UserSimulatorAction {
  pendingId: string;
  type: "ask_user" | BenchmarkApprovalType;
  decision: string;
  matchedScriptIndex: number | null;
  success: boolean;
  timestamp: number;
  detail?: string;
}

export class UserSimulator {
  private unsubscribe: (() => void) | null = null;
  private handledIds = new Set<string>();
  private usedQuestionScripts = new Set<number>();
  private approvalScriptUseCounts = new Map<number, number>();
  private actions: UserSimulatorAction[] = [];
  private errors: string[] = [];

  constructor(
    private readonly script: BenchmarkUserScript = {},
    private readonly bus: EventBus = eventBus,
  ) {}

  start(): void {
    if (this.unsubscribe) throw new Error("UserSimulator is already running.");
    this.unsubscribe = this.bus.subscribe(({ event }) => {
      switch (event.type) {
        case "ask_user.pending":
          this.handleQuestion(event.pendingQuestion);
          break;
        case "dispatch.plan.pending":
          this.handleApproval("dispatch_plan", event.pendingPlan.id, planText(event.pendingPlan), event.pendingPlan);
          break;
        case "fs_write.pending":
          this.handleApproval("fs_write", event.pendingWrite.id, writeText(event.pendingWrite), event.pendingWrite);
          break;
        case "bash_command.pending":
          this.handleApproval("bash", event.pendingCommand.id, bashText(event.pendingCommand), event.pendingCommand);
          break;
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  getActions(): UserSimulatorAction[] {
    return [...this.actions];
  }

  getErrors(): string[] {
    return [...this.errors];
  }

  private handleQuestion(question: PendingQuestion): void {
    if (!this.claim(question.id)) return;
    const haystack = question.questions.map((item) => `${item.header} ${item.question}`).join("\n");
    const match = findScriptMatch(this.script.questions ?? [], this.usedQuestionScripts, haystack);

    if (match) {
      this.usedQuestionScripts.add(match.index);
      const success = answerQuestion(question.id, match.entry.answers);
      this.record(question.id, "ask_user", "answer", match.index, success);
      if (!success) this.errors.push(`Failed to answer pending question ${question.id}.`);
      return;
    }

    if ((this.script.onUnmatchedQuestion ?? "first_option") === "first_option") {
      const answers = Object.fromEntries(
        question.questions.map((item, index) => [String(index), item.options[0]?.label ?? ""]),
      );
      const success = answerQuestion(question.id, answers);
      this.record(question.id, "ask_user", "first_option", null, success);
      if (!success) this.errors.push(`Failed to apply default answer to ${question.id}.`);
      return;
    }

    answerQuestion(question.id, {});
    const detail = `No ask_user script matched pending question ${question.id}.`;
    this.errors.push(detail);
    this.record(question.id, "ask_user", "fail", null, false, detail);
  }

  private handleApproval(
    type: BenchmarkApprovalType,
    pendingId: string,
    haystack: string,
    pending: PendingDispatchPlan | PendingWrite | PendingBashCommand,
  ): void {
    if (!this.claim(pendingId)) return;
    const candidates = (this.script.approvals ?? []).filter((entry) => entry.type === type);
    const match = findApprovalMatch(candidates, this.script.approvals ?? [], this.approvalScriptUseCounts, haystack);

    let decision: "approve" | "reject";
    let matchedScriptIndex: number | null = null;
    if (match) {
      decision = match.entry.decision;
      matchedScriptIndex = match.index;
      this.approvalScriptUseCounts.set(match.index, (this.approvalScriptUseCounts.get(match.index) ?? 0) + 1);
    } else {
      const fallback = this.script.onUnmatchedApproval ?? "approve";
      if (fallback === "fail") {
        decision = "reject";
        const detail = `No ${type} approval script matched ${pendingId}.`;
        this.errors.push(detail);
      } else {
        decision = fallback;
      }
    }

    const success = resolveApproval(type, pendingId, decision);
    this.publishResolution(type, pending, decision, success);
    this.record(pendingId, type, decision, matchedScriptIndex, success);
    if (!success) this.errors.push(`Failed to ${decision} ${type} approval ${pendingId}.`);
  }

  private publishResolution(
    type: BenchmarkApprovalType,
    pending: PendingDispatchPlan | PendingWrite | PendingBashCommand,
    decision: "approve" | "reject",
    success: boolean,
  ): void {
    if (!success) return;
    const approved = decision === "approve";
    if (type === "dispatch_plan") {
      const plan = pending as PendingDispatchPlan;
      this.bus.publish({
        type: "dispatch.plan.resolved",
        conversationId: plan.conversationId,
        timestamp: Date.now(),
        pendingId: plan.id,
        runId: plan.runId,
        approved,
      });
    } else if (type === "fs_write") {
      const write = pending as PendingWrite;
      this.bus.publish({
        type: "fs_write.resolved",
        conversationId: write.conversationId,
        timestamp: Date.now(),
        pendingId: write.id,
        applied: approved,
      });
    } else {
      const command = pending as PendingBashCommand;
      this.bus.publish({
        type: "bash_command.resolved",
        conversationId: command.conversationId,
        timestamp: Date.now(),
        pendingId: command.id,
        approved,
      });
    }
  }

  private claim(id: string): boolean {
    if (this.handledIds.has(id)) return false;
    this.handledIds.add(id);
    return true;
  }

  private record(
    pendingId: string,
    type: UserSimulatorAction["type"],
    decision: string,
    matchedScriptIndex: number | null,
    success: boolean,
    detail?: string,
  ): void {
    this.actions.push({ pendingId, type, decision, matchedScriptIndex, success, timestamp: Date.now(), detail });
  }
}

function resolveApproval(
  type: BenchmarkApprovalType,
  id: string,
  decision: "approve" | "reject",
): boolean {
  if (type === "dispatch_plan") return decision === "approve" ? approvePlan(id) : rejectPlan(id);
  if (type === "fs_write") return decision === "approve" ? approvePendingWrite(id) : rejectPendingWrite(id);
  return decision === "approve" ? approvePendingBash(id) : rejectPendingBash(id);
}

function findScriptMatch<T extends { match?: string }>(entries: T[], used: Set<number>, haystack: string) {
  for (let index = 0; index < entries.length; index++) {
    if (used.has(index) || !matches(entries[index].match, haystack)) continue;
    return { entry: entries[index], index };
  }
  return null;
}

function findApprovalMatch(
  candidates: BenchmarkApprovalScriptEntry[],
  allEntries: BenchmarkApprovalScriptEntry[],
  useCounts: Map<number, number>,
  haystack: string,
) {
  for (const entry of candidates) {
    const index = allEntries.indexOf(entry);
    const used = useCounts.get(index) ?? 0;
    if (index < 0 || used >= (entry.maxMatches ?? 1) || !matches(entry.match, haystack)) continue;
    return { entry, index };
  }
  return null;
}

function matches(needle: string | undefined, haystack: string): boolean {
  return !needle || haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function planText(plan: PendingDispatchPlan): string {
  return plan.plan.map((item) => `${item.id} ${item.title ?? ""} ${item.task}`).join("\n");
}

function writeText(write: PendingWrite): string {
  return `${write.path}\n${write.newContent.slice(0, 500)}`;
}

function bashText(command: PendingBashCommand): string {
  return `${command.command}\n${command.cwd}\n${command.reason}`;
}
