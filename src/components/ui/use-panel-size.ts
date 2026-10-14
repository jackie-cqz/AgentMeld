"use client";

import { useSyncExternalStore } from "react";
import { useAppStore } from "@/stores/app-store";
import { constrainPanelWidth, getWorkspacePanelBounds } from "@/lib/workspace-panel-layout";

function subscribe(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

export function usePanelSize() {
  const viewport = useSyncExternalStore(subscribe, () => window.innerWidth, () => 1440);
  const collapsed = useAppStore(state => state.sidebarCollapsed);
  const preferred = useAppStore(state => state.artifactPanelWidth);
  const bounds = getWorkspacePanelBounds(viewport, collapsed ? 56 : 280);
  return { bounds, width: constrainPanelWidth(preferred, bounds) };
}
