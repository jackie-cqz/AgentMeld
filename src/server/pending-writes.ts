import { nanoid } from "nanoid";
import type { PendingWrite } from "@/shared/types";

type Resolver = (approved: boolean) => void;

interface PendingEntry {
  write: PendingWrite;
  resolver: Resolver;
}

declare global {
  var __agentConferencePendingWrites: Map<string, PendingEntry> | undefined;
}

function getStore(): Map<string, PendingEntry> {
  if (!globalThis.__agentConferencePendingWrites) {
    globalThis.__agentConferencePendingWrites = new Map();
  }
  return globalThis.__agentConferencePendingWrites;
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

  return new Promise<boolean>((resolve) => {
    const entry: PendingEntry = {
      write: {
        id,
        conversationId,
        agentId,
        runId,
        path: filePath,
        absolutePath,
        oldContent,
        newContent,
        createdAt: Date.now()
      },
      resolver: (approved: boolean) => {
        store.delete(id);
        resolve(approved);
      }
    };
    store.set(id, entry);
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
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(true);
  return true;
}

export function rejectPendingWrite(id: string): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(false);
  return true;
}

export function cancelPendingWritesForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.write.runId === runId) {
      entry.resolver(false);
      store.delete(id);
    }
  }
}

export function clearPendingWritesForTests(): void {
  const store = getStore();
  for (const [, entry] of store) {
    entry.resolver(false);
  }
  store.clear();
}
