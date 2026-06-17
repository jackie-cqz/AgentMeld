"use client";

import { ArtifactPanel } from "@/components/artifact-panel";
import { ChatPanel } from "@/components/chat-panel";
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

  if (isBootstrapping) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f6f2]">
        <div className="rounded-md border border-stone-200 bg-white px-5 py-4 text-sm text-stone-600 shadow-sm">
          正在启动 Agent-Conference MVP...
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen overflow-hidden bg-[#fbfaf7] text-stone-950">
      <Sidebar />
      <ChatPanel />
      <ArtifactPanel />
    </main>
  );
}
