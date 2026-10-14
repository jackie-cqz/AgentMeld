import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".tmp-*/**",
      "node_modules/**",
      "release/**",
      "dist/**",
      "coverage/**",
      ".agentmeld-data/**",
      ".agent-conference-data/**",
      "AgentMeld/**",
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextVitals,
  ...nextTs
);
