"use client";

import { useEffect } from "react";
import { ArtifactPanel } from "@/components/artifact-panel";
import { ChatPanel } from "@/components/chat-panel";
import { GlobalSearch } from "@/components/global-search";
import { Sidebar } from "@/components/sidebar";
import { StreamProvider } from "@/components/stream-provider";
import { useAppStore } from "@/stores/app-store";

export function AppShell() {
  return (
    <StreamProvider>
      <ShellContent />
    </StreamProvider>
  );
}

function ShellContent() {
  const isBootstrapping = useAppStore((state) => state.isBootstrapping);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const darkMode = useAppStore((state) => state.darkMode);

  // Toggle dark class on <html> for Tailwind dark: variants + component conditional styles
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  if (isBootstrapping) {
    return (
      <main className={`grid min-h-screen place-items-center ${darkMode ? "bg-slate-900" : "bg-[#f7f6f2]"}`}>
        <div className={`rounded-md border px-5 py-4 text-sm shadow-sm ${darkMode ? "border-slate-700 bg-slate-800 text-slate-300" : "border-stone-200 bg-white text-stone-600"}`}>
          正在启动 Agent-Conference MVP...
        </div>
      </main>
    );
  }

  return (
    <main className={`flex h-screen overflow-hidden ${darkMode ? "bg-slate-900 text-slate-100" : "bg-[#f7f8fb] text-slate-950"}`}>
      <Sidebar />
      <ChatPanel />
      {rightPanelOpen ? <ArtifactPanel /> : null}
      <GlobalSearch />
    </main>
  );
}
