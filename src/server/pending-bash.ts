import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import type { PendingBashCommand } from "@/shared/types";

type Resolver = (approved: boolean) => void;

interface BashEntry {
  command: PendingBashCommand;
  resolver: Resolver;
}

declare global {
  var __agentConferencePendingBash: Map<string, BashEntry> | undefined;
}

function getStore(): Map<string, BashEntry> {
  if (!globalThis.__agentConferencePendingBash) {
    globalThis.__agentConferencePendingBash = new Map();
  }
  return globalThis.__agentConferencePendingBash;
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

  return new Promise<boolean>((resolve) => {
    const entry: BashEntry = {
      command: {
        id,
        conversationId,
        agentId,
        runId,
        command,
        cwd,
        reason,
        createdAt: Date.now()
      },
      resolver: (approved: boolean) => {
        store.delete(id);
        resolve(approved);
      }
    };
    store.set(id, entry);

    // Publish SSE event for UI
    eventBus.publish({
      type: "bash_command.pending",
      conversationId,
      timestamp: Date.now(),
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
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(true);
  return true;
}

export function rejectPendingBash(id: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(false);
  return true;
}

export function cancelPendingBashForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.command.runId === runId) {
      entry.resolver(false);
      store.delete(id);
    }
  }
}

export function clearPendingBashForTests(): void {
  const store = getStore();
  for (const [, entry] of store) {
    entry.resolver(false);
  }
  store.clear();
}
