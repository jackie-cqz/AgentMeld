import type { Metadata } from "next";
import "./globals.css";
import "./workspace.css";
import "./provider-settings.css";
import "./channel-settings.css";
import "./agent-model-config.css";
import "./agent-avatar.css";
import "./agent-editor.css";
import "./workspace-polish.css";

export const metadata: Metadata = {
  title: "AgentMeld",
  description: "Local-first multi-agent collaboration workspace"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
