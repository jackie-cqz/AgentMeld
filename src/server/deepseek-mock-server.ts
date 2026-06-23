import http from "node:http";

// ---------------------------------------------------------------------------
// P4: DeepSeek-compatible local mock server for integration testing
// ---------------------------------------------------------------------------

type Scenario = "text" | "reasoning" | "tool-call" | "multi-round" | "usage" | "401" | "403" | "429" | "timeout" | "500" | "empty" | "invalid-json";

interface MockOptions {
  scenario?: Scenario;
  port?: number;
  toolRoundDelay?: number;
}

const SSE_CHUNK = "data: %s\n\n";

function sse(data: unknown): string {
  return SSE_CHUNK.replace("%s", JSON.stringify(data));
}

export function createDeepSeekMockServer(options: MockOptions = {}) {
  const port = options.port ?? 19800;
  const scenario = options.scenario ?? "text";

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Route by scenario from header or query
    const scenarioHeader = req.headers["x-mock-scenario"] as string || scenario;

    if (scenarioHeader === "401") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Invalid API Key", type: "authentication_error", code: "invalid_api_key" } }));
      return;
    }
    if (scenarioHeader === "403") {
      res.writeHead(403);
      res.end(JSON.stringify({ error: { message: "Access denied", type: "permission_error" } }));
      return;
    }
    if (scenarioHeader === "429") {
      res.writeHead(429, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
      return;
    }
    if (scenarioHeader === "timeout") {
      // Just hang — don't respond
      return;
    }
    if (scenarioHeader === "500") {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: "Internal server error" } }));
      return;
    }
    if (scenarioHeader === "empty") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      return;
    }
    if (scenarioHeader === "invalid-json") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {invalid json here\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }

    // Collect request body for multi-round tracking
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const messages = (parsed.messages as Array<Record<string, unknown>>) ?? [];
      const hasTools = Array.isArray(parsed.tools) && (parsed.tools as Array<unknown>).length > 0;
      const isRetry = messages.some((m) => m.role === "tool");

      if (scenarioHeader === "tool-call" || (hasTools && !isRetry)) {
        // Emit text delta first
        res.write(sse({ id: "chatcmpl-1", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat", choices: [{ index: 0, delta: { content: "Let me check the workspace." }, finish_reason: null }] }));

        // Emit tool call
        res.write(sse({
          id: "chatcmpl-1", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "fs_list", arguments: JSON.stringify({ path: "." }) } }] }, finish_reason: "tool_calls" }]
        }));
        res.end("data: [DONE]\n\n");
        return;
      }

      if (scenarioHeader === "multi-round" || isRetry) {
        res.write(sse({ id: "chatcmpl-2", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat", choices: [{ index: 0, delta: { content: "Based on the tool results, I can now answer. The project is a React app." }, finish_reason: null }] }));
        res.write(sse({
          id: "chatcmpl-2", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 }
        }));
        res.end("data: [DONE]\n\n");
        return;
      }

      // Default: plain text with reasoning
      if (scenarioHeader === "reasoning") {
        res.write(sse({ id: "chatcmpl-0", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat", choices: [{ index: 0, delta: { reasoning_content: "The user wants a pomodoro timer." }, finish_reason: null }] }));
      }

      res.write(sse({ id: "chatcmpl-0", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat", choices: [{ index: 0, delta: { content: "I'll help you build" }, finish_reason: null }] }));
      res.write(sse({ id: "chatcmpl-0", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat", choices: [{ index: 0, delta: { content: " a Pomodoro Timer!" }, finish_reason: null }] }));
      res.write(sse({
        id: "chatcmpl-0", object: "chat.completion.chunk", created: Date.now(), model: "deepseek-chat",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      }));
      res.end("data: [DONE]\n\n");
    });
  });

  return {
    server,
    url: `http://localhost:${port}`,
    start() { return new Promise<void>((resolve) => server.listen(port, resolve)); },
    stop() { return new Promise<void>((resolve) => server.close(() => resolve())); }
  };
}
