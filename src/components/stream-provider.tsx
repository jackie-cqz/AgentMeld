"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { StreamEvent } from "@/shared/types";

export function StreamProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const { loadBootstrap, setConnectionStatus } = useAppStore.getState();
    void loadBootstrap().catch(() => {
      setConnectionStatus("error");
    });
  }, []);

  useEffect(() => {
    const { applyEvent, setConnectionStatus } = useAppStore.getState();
    setConnectionStatus("connecting");
    const source = new EventSource("/api/stream");

    source.onopen = () => setConnectionStatus("open");
    source.onerror = () => {
      setConnectionStatus("error");
    };
    source.onmessage = (event) => {
      try {
        applyEvent(JSON.parse(event.data) as StreamEvent);
      } catch {
        setConnectionStatus("error");
      }
    };

    return () => {
      source.close();
      setConnectionStatus("closed");
    };
  }, []);

  return children;
}
