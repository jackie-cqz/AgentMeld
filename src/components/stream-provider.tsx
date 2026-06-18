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

export function StreamProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const store = useAppStore.getState();
    void store.loadBootstrap().then(() => {
      // After bootstrap, recover pending state (survives page refresh)
      recoverPendingState();
    }).catch(() => {
      store.setConnectionStatus("error");
    });
  }, []);

  useEffect(() => {
    refCount++;
    if (!activeSource) {
      const { applyEvent, setConnectionStatus } = useAppStore.getState();
      setConnectionStatus("connecting");
      activeSource = new EventSource("/api/stream");

      activeSource.onopen = () => setConnectionStatus("open");
      activeSource.onerror = () => {
        setConnectionStatus("error");
      };
      activeSource.onmessage = (event) => {
        try {
          applyEvent(JSON.parse(event.data) as StreamEvent);
        } catch {
          setConnectionStatus("error");
        }
      };
    }

    return () => {
      refCount--;
      if (refCount <= 0 && activeSource) {
        activeSource.close();
        activeSource = null;
      }
    };
  }, []);

  return children;
}

async function recoverPendingState() {
  const { conversationOrder, activeConversationId } = useAppStore.getState();
  const convId = activeConversationId ?? conversationOrder[0];
  if (!convId) return;
  const applyEvent = useAppStore.getState().applyEvent;
  const timestamp = Date.now();

  try {
    // Recover pending writes
    const writesRes = await fetch(`/api/conversations/${convId}/pending-writes`);
    if (writesRes.ok) {
      const { pendingWrites } = await writesRes.json() as { pendingWrites: PendingWrite[] };
      for (const pendingWrite of pendingWrites) {
        applyEvent({ type: "fs_write.pending", conversationId: convId, timestamp, pendingWrite });
      }
    }

    // Recover pending bash commands
    const bashRes = await fetch(`/api/conversations/${convId}/pending-bash-commands`);
    if (bashRes.ok) {
      const { pendingBashCommands } = await bashRes.json() as { pendingBashCommands: PendingBashCommand[] };
      for (const pendingCommand of pendingBashCommands) {
        applyEvent({ type: "bash_command.pending", conversationId: convId, timestamp, pendingCommand });
      }
    }

    // Recover pending dispatch plans
    const plansRes = await fetch(`/api/conversations/${convId}/pending-dispatch-plans`);
    if (plansRes.ok) {
      const { pendingDispatchPlans } = await plansRes.json() as { pendingDispatchPlans: PendingDispatchPlan[] };
      for (const pendingPlan of pendingDispatchPlans) {
        applyEvent({ type: "dispatch.plan.pending", conversationId: convId, timestamp, pendingPlan });
      }
    }

    const questionsRes = await fetch(`/api/conversations/${convId}/pending-questions`);
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
