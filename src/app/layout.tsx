import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent-Conference",
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
