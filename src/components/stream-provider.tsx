"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { StreamEvent } from "@/shared/types";

// Module-level refs — survive HMR and React StrictMode double-mount
let activeSource: EventSource | null = null;
let refCount = 0;

export function StreamProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const { loadBootstrap, setConnectionStatus } = useAppStore.getState();
    void loadBootstrap().catch(() => {
      setConnectionStatus("error");
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
