import { describe, expect, it } from "vitest";
import { classifyProviderError, buildErrorDetail, logger } from "@/server/logger";

describe("classifyProviderError", () => {
  it("classifies 401/403 as provider_auth", () => {
    expect(classifyProviderError(401).category).toBe("provider_auth");
    expect(classifyProviderError(401).retryable).toBe(false);
    expect(classifyProviderError(403).category).toBe("provider_auth");
  });

  it("classifies 429 as provider_rate_limit", () => {
    const r = classifyProviderError(429);
    expect(r.category).toBe("provider_rate_limit");
    expect(r.retryable).toBe(true);
  });

  it("classifies 5xx as provider_server", () => {
    expect(classifyProviderError(500).category).toBe("provider_server");
    expect(classifyProviderError(502).category).toBe("provider_server");
    expect(classifyProviderError(500).retryable).toBe(true);
  });

  it("classifies timeout as provider_timeout", () => {
    expect(classifyProviderError(408, "timeout").category).toBe("provider_timeout");
  });

  it("classifies unknown errors as provider_invalid_response", () => {
    expect(classifyProviderError(418).category).toBe("provider_invalid_response");
    expect(classifyProviderError(418).retryable).toBe(false);
  });
});

describe("buildErrorDetail", () => {
  it("builds structured error with all fields", () => {
    const e = buildErrorDetail("tool_execution", "bash failed", false, {
      toolName: "bash", stage: "dispatch"
    });
    expect(e.category).toBe("tool_execution");
    expect(e.retryable).toBe(false);
    expect(e.toolName).toBe("bash");
    expect(e.stage).toBe("dispatch");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(600);
    const e = buildErrorDetail("provider_timeout", long, true);
    expect(e.message.length).toBeLessThanOrEqual(500);
  });
});

describe("logger", () => {
  it("does not throw for info/warn/error", () => {
    expect(() => logger.info("test.event", { runId: "r1" }, { key: "val" })).not.toThrow();
    expect(() => logger.warn("test.warn", { agentId: "a1" })).not.toThrow();
    expect(() => logger.error("test.err", { runId: "r2" }, { apiKey: "secret" })).not.toThrow();
  });
});
