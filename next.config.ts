import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
    "@openai/codex",
    "better-sqlite3"
  ],
  // Next 16 treats any origin other than `localhost` as cross-origin and blocks
  // dev resources (HMR) from it, so opening http://127.0.0.1:3000 leaves the app
  // stuck on its boot splash. That is an easy trap when the UI is driven by a
  // browser automation tool. Development only; ignored in production builds.
  allowedDevOrigins: ["127.0.0.1"]
};

export default nextConfig;
