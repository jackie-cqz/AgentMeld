import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";
import { cancelApproval, persistApproval, resolveApproval } from "@/server/repositories";
import type { PendingWrite } from "@/shared/types";

type Resolver = (approved: boolean) => void;

interface PendingEntry {
  write: PendingWrite;
  resolver: Resolver;
}

declare global {
  var __agentMeldPendingWrites: Map<string, PendingEntry> | undefined;
}

function getStore(): Map<string, PendingEntry> {
  if (!globalThis.__agentMeldPendingWrites) {
    globalThis.__agentMeldPendingWrites = new Map();
  }
  return globalThis.__agentMeldPendingWrites;
}

export function registerPendingWrite(
  conversationId: string,
  agentId: string,
  runId: string,
  filePath: string,
  absolutePath: string,
  oldContent: string | null,
  newContent: string
): Promise<boolean> {
  const store = getStore();
  const id = `pw_${nanoid(12)}`;
  const now = Date.now();

  // P2: Persist approval to DB
  persistApproval({
    id, conversationId, agentId, runId,
    approvalType: "fs_write",
    payloadJson: JSON.stringify({ filePath, absolutePath, oldContent: oldContent?.slice(0, 200) ?? null, newContent: newContent.slice(0, 500) }),
    now
  });

  return new Promise<boolean>((resolve) => {
    const entry: PendingEntry = {
      write: {
        id, conversationId, agentId, runId,
        path: filePath, absolutePath, oldContent, newContent,
        createdAt: now
      },
      resolver: (approved: boolean) => {
        resolve(approved);
      }
    };
    store.set(id, entry);

    eventBus.publish({
      type: "fs_write.pending",
      conversationId,
      timestamp: now,
      pendingWrite: entry.write
    });
  });
}

export function getPendingWrite(id: string): PendingEntry | undefined {
  return getStore().get(id);
}

export function getAllPendingWrites(): PendingWrite[] {
  return Array.from(getStore().values()).map((entry) => entry.write);
}

export function getPendingWritesForConversation(conversationId: string): PendingWrite[] {
  return getAllPendingWrites().filter((w) => w.conversationId === conversationId);
}

export function approvePendingWrite(id: string): boolean {
  return resolvePendingWrite(id, true);
}

export function rejectPendingWrite(id: string): boolean {
  return resolvePendingWrite(id, false);
}

export function cancelPendingWritesForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.write.runId === runId) {
      cancelApproval(id, Date.now());
      store.delete(id);
      entry.resolver(false);
      eventBus.publish({
        type: "fs_write.resolved",
        conversationId: entry.write.conversationId,
        timestamp: Date.now(),
        pendingId: id,
        applied: false
      });
    }
  }
}

export function clearPendingWritesForTests(): void {
  const store = getStore();
  for (const [id, entry] of store) {
    resolveApproval(id, false, Date.now());
    entry.resolver(false);
  }
  store.clear();
}

function resolvePendingWrite(id: string, approved: boolean): boolean {
  const store = getStore();
  const entry = store.get(id);
  if (!entry) return false;
  if (!resolveApproval(id, approved, Date.now())) return false;
  store.delete(id);
  entry.resolver(approved);
  return true;
}
