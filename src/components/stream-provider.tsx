"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type {
  PendingBashCommand,
  PendingDispatchPlan,
  PendingQuestion,
  PendingWrite,
  StreamEvent
} from "@/shared/types";

// Module-level refs — survive HMR and React StrictMode double-mount
let activeSource: EventSource | null = null;
let refCount = 0;
let bootstrapPromise: Promise<void> | null = null;
const pendingRecoveryByConversation = new Map<string, Promise<void>>();

export function StreamProvider({ children }: { children: React.ReactNode }) {
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const isBootstrapping = useAppStore((state) => state.isBootstrapping);

  useEffect(() => {
    refCount++;
    let cancelled = false;

    void ensureBootstrap()
      .then(() => {
        if (!cancelled) connectStream();
      })
      .catch(() => {
        if (!cancelled) useAppStore.getState().setConnectionStatus("error");
      });

    return () => {
      cancelled = true;
      refCount--;
      if (refCount <= 0 && activeSource) {
        activeSource.close();
        activeSource = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isBootstrapping || !activeConversationId) return;
    void recoverPendingState(activeConversationId);
  }, [activeConversationId, isBootstrapping]);

  return children;
}

function ensureBootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = useAppStore.getState().loadBootstrap().catch((error: unknown) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

function connectStream() {
  if (activeSource) return;

  const { applyEvent, setConnectionStatus } = useAppStore.getState();
  setConnectionStatus("connecting");
  activeSource = new EventSource("/api/stream");

  activeSource.onopen = () => {
    setConnectionStatus("open");
    const conversationId = useAppStore.getState().activeConversationId;
    if (conversationId) void recoverPendingState(conversationId);
  };
  activeSource.onerror = () => {
    setConnectionStatus(
      activeSource?.readyState === EventSource.CLOSED ? "error" : "connecting"
    );
  };
  activeSource.onmessage = (event) => {
    try {
      applyEvent(JSON.parse(event.data) as StreamEvent);
      setConnectionStatus("open");
    } catch {
      setConnectionStatus("error");
    }
  };
}

function recoverPendingState(conversationId: string) {
  const current = pendingRecoveryByConversation.get(conversationId);
  if (current) return current;

  const recovery = performPendingRecovery(conversationId).finally(() => {
    pendingRecoveryByConversation.delete(conversationId);
  });
  pendingRecoveryByConversation.set(conversationId, recovery);
  return recovery;
}

async function performPendingRecovery(convId: string) {
  const applyEvent = useAppStore.getState().applyEvent;
  const timestamp = Date.now();

  try {
    const [writesRes, bashRes, plansRes, questionsRes] = await Promise.all([
      fetch(`/api/conversations/${convId}/pending-writes`, { cache: "no-store" }),
      fetch(`/api/conversations/${convId}/pending-bash-commands`, { cache: "no-store" }),
      fetch(`/api/conversations/${convId}/pending-dispatch-plans`, { cache: "no-store" }),
      fetch(`/api/conversations/${convId}/pending-questions`, { cache: "no-store" })
    ]);

    if (writesRes.ok) {
      const { pendingWrites } = await writesRes.json() as { pendingWrites: PendingWrite[] };
      for (const pendingWrite of pendingWrites) {
        applyEvent({ type: "fs_write.pending", conversationId: convId, timestamp, pendingWrite });
      }
    }

    if (bashRes.ok) {
      const { pendingBashCommands } = await bashRes.json() as { pendingBashCommands: PendingBashCommand[] };
      for (const pendingCommand of pendingBashCommands) {
        applyEvent({ type: "bash_command.pending", conversationId: convId, timestamp, pendingCommand });
      }
    }

    if (plansRes.ok) {
      const { pendingDispatchPlans } = await plansRes.json() as { pendingDispatchPlans: PendingDispatchPlan[] };
      for (const pendingPlan of pendingDispatchPlans) {
        applyEvent({ type: "dispatch.plan.pending", conversationId: convId, timestamp, pendingPlan });
      }
    }

    if (questionsRes.ok) {
      const { pendingQuestions } = await questionsRes.json() as { pendingQuestions: PendingQuestion[] };
      for (const pendingQuestion of pendingQuestions) {
        applyEvent({ type: "ask_user.pending", conversationId: convId, timestamp, pendingQuestion });
      }
    }
  } catch {
    // Recovery is best-effort; don't block the UI
  }
}
