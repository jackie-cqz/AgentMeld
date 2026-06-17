"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { StreamEvent } from "@/shared/types";

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
  const { conversations, conversationOrder, activeConversationId } = useAppStore.getState();
  const convId = activeConversationId ?? conversationOrder[0];
  if (!convId) return;

  try {
    // Recover pending writes
    const writesRes = await fetch(`/api/conversations/${convId}/pending-writes`);
    if (writesRes.ok) {
      const { pendingWrites } = await writesRes.json() as { pendingWrites: Array<{ id: string }> };
      useAppStore.setState((state) => {
        for (const w of pendingWrites) {
          state.pendingWrites[w.id] = w as never;
        }
      });
    }

    // Recover pending bash commands
    const bashRes = await fetch(`/api/conversations/${convId}/pending-bash-commands`);
    if (bashRes.ok) {
      const { pendingBashCommands } = await bashRes.json() as { pendingBashCommands: Array<{ id: string }> };
      useAppStore.setState((state) => {
        for (const b of pendingBashCommands) {
          state.pendingBashCommands[b.id] = b as never;
        }
      });
    }

    // Recover pending dispatch plans
    const plansRes = await fetch(`/api/conversations/${convId}/pending-dispatch-plans`);
    if (plansRes.ok) {
      const { pendingDispatchPlans } = await plansRes.json() as { pendingDispatchPlans: Array<{ id: string }> };
      useAppStore.setState((state) => {
        for (const p of pendingDispatchPlans) {
          state.pendingDispatchPlans[p.id] = p as never;
        }
      });
    }
  } catch {
    // Recovery is best-effort; don't block the UI
  }
}
