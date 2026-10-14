import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/agent-benchmark/**/*.test.ts"],
    setupFiles: [path.resolve(__dirname, "src/test/setup-global-db.ts")],
    fileParallelism: false
  }
});
