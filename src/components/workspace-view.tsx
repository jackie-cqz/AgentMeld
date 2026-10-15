"use client";

import { ArrowLeft, BarChart3, Bot, Layers } from "lucide-react";
import { AgentsPanel } from "@/components/agents-panel";
import { AnalyticsPanel } from "@/components/analytics-panel";
import { ArtifactLibrary } from "@/components/artifact-library";
import { useAppStore } from "@/stores/app-store";

const views = {
  agents: { title: "Agents", icon: Bot },
  artifacts: { title: "产物库", icon: Layers },
  analytics: { title: "分析", icon: BarChart3 }
};

export function WorkspaceView({ view }: { view: keyof typeof views }) {
  const setSidebarTab = useAppStore(state => state.setSidebarTab);
  const { title, icon: Icon } = views[view];
  return <main className="workspace-view" aria-label={title}>
    <header className="workspace-view-header"><Icon size={16} /><span>工作空间</span><span>/</span><strong>{title}</strong>
      <button className="ui-button ui-button--quiet ml-auto" onClick={() => setSidebarTab("conversations")}><ArrowLeft size={15} />返回对话</button>
    </header>
    <div className={`workspace-view-body workspace-view-${view}`}>
      {view === "agents" ? <AgentsPanel /> : view === "artifacts" ? <ArtifactLibrary /> : <AnalyticsPanel />}
    </div>
  </main>;
}
