import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
    "@openai/codex",
    "better-sqlite3"
  ]
};

export default nextConfig;
