import type { Metadata } from "next";
import "./globals.css";
import "./workspace.css";
import "./provider-settings.css";
import "./channel-settings.css";
import "./agent-model-config.css";
import "./agent-avatar.css";
import "./agent-editor.css";
import { ClientErrorReporter } from "@/components/client-error-reporter";

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
      <body>
        <ClientErrorReporter />
        {children}
      </body>
    </html>
  );
}
