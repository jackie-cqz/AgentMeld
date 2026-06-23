import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import { cancelApproval, persistApproval, resolveApproval } from "@/server/repositories";
import type { PendingBashCommand } from "@/shared/types";

type Resolver = (approved: boolean) => void;

interface BashEntry {
  command: PendingBashCommand;
  resolver: Resolver;
}

declare global {
  var __agentMeldPendingBash: Map<string, BashEntry> | undefined;
}

function getStore(): Map<string, BashEntry> {
  if (!globalThis.__agentMeldPendingBash) {
    globalThis.__agentMeldPendingBash = new Map();
  }
  return globalThis.__agentMeldPendingBash;
}

export function registerPendingBash(
  conversationId: string,
  agentId: string,
  runId: string,
  command: string,
  cwd: string,
  reason: string
): Promise<boolean> {
  const store = getStore();
  const id = `pb_${nanoid(12)}`;
  const now = Date.now();

  // P2: Persist to DB
  persistApproval({
    id, conversationId, agentId, runId,
    approvalType: "bash",
    payloadJson: JSON.stringify({ command: command.slice(0, 500), cwd, reason }),
    now
  });

  return new Promise<boolean>((resolve) => {
    const entry: BashEntry = {
      command: { id, conversationId, agentId, runId, command, cwd, reason, createdAt: now },
      resolver: (approved: boolean) => {
        resolve(approved);
      }
    };
    store.set(id, entry);

    eventBus.publish({
      type: "bash_command.pending",
      conversationId,
      timestamp: now,
      pendingCommand: entry.command
    });
  });
}

export function getPendingBash(id: string): BashEntry | undefined {
  return getStore().get(id);
}

export function getAllPendingBashCommands(): PendingBashCommand[] {
  return Array.from(getStore().values()).map((entry) => entry.command);
}

export function getPendingBashCommandsForConversation(conversationId: string): PendingBashCommand[] {
  return getAllPendingBashCommands().filter((c) => c.conversationId === conversationId);
}

export function approvePendingBash(id: string): boolean {
  return resolvePendingBash(id, true);
}

export function rejectPendingBash(id: string): boolean {
  return resolvePendingBash(id, false);
}

export function cancelPendingBashForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.command.runId === runId) {
      cancelApproval(id, Date.now());
      store.delete(id);
      entry.resolver(false);
      eventBus.publish({
        type: "bash_command.resolved",
        conversationId: entry.command.conversationId,
        timestamp: Date.now(),
        pendingId: id,
        approved: false
      });
    }
  }
}

export function clearPendingBashForTests(): void {
  const store = getStore();
  for (const [id, entry] of store) {
    resolveApproval(id, false, Date.now());
    entry.resolver(false);
  }
  store.clear();
}

function resolvePendingBash(id: string, approved: boolean): boolean {
  const store = getStore();
  const entry = store.get(id);
  if (!entry) return false;
  if (!resolveApproval(id, approved, Date.now())) return false;
  store.delete(id);
  entry.resolver(approved);
  return true;
}
