#!/usr/bin/env node
/**
 * The stdio MCP server OpenCode spawns for one AgentMeld invocation.
 *
 * OpenCode 1.19.3 loads a `local` MCP server from its config and exposes every
 * tool that server advertises as `<server>_<tool>` (verified against the pinned
 * package: the model sees `agentmeld_write_artifact`, and the tool part carries
 * that name). This process only speaks MCP; the platform's neutral tool bridge
 * is behind the loopback endpoint named by the environment.
 *
 * It must never write to stdout except protocol messages. Diagnostics go to
 * stderr, which OpenCode keeps out of the model context.
 */
const BRIDGE_URL = process.env.AGENTMELD_OPENCODE_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.AGENTMELD_OPENCODE_BRIDGE_TOKEN;
if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  process.stderr.write("AgentMeld OpenCode MCP server: bridge environment is missing.\n");
  process.exit(1);
}

const SERVER_NAME = "agentmeld";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL = "2024-11-05";

/** One platform tool result as MCP content. */
function toolContent(result) {
  if (result && result.ok === true) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.value ?? null) }],
      isError: false,
    };
  }
  const message = result && typeof result.error === "string"
    ? result.error
    : "The platform tool failed.";
  return { content: [{ type: "text", text: message }], isError: true };
}

async function post(operation, body) {
  const response = await fetch(`${BRIDGE_URL}${operation}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload && typeof payload.error === "string"
      ? payload.error
      : "The platform tool bridge rejected the request.";
    return { refused: true, message };
  }
  return { refused: false, payload };
}

let manifest;
async function loadManifest() {
  if (manifest) return manifest;
  const response = await fetch(`${BRIDGE_URL}/manifest`, {
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
  });
  if (!response.ok) throw new Error("The platform tool catalogue is unavailable.");
  manifest = await response.json();
  return manifest;
}

async function toolsList() {
  const catalogue = await loadManifest();
  await post("/ready", { kind: "mcp" });
  return {
    tools: catalogue.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    })),
  };
}

async function toolsCall(requestId, params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  // The JSON-RPC request id is the transport's replay key: the bridge refuses a
  // consumed id, exactly as it does for Pi's per-call ids.
  const outcome = await post("/tool", { callId: `mcp:${String(requestId)}`, name, args });
  if (outcome.refused) return { content: [{ type: "text", text: outcome.message }], isError: true };
  return toolContent(outcome.payload);
}

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respondError(id, code, message) {
  respond({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const id = message.id;
  const isRequest = id !== undefined && id !== null;
  const method = message.method;
  if (typeof method !== "string") return;
  try {
    if (method === "initialize") {
      if (!isRequest) return;
      const requested = message.params && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : SUPPORTED_PROTOCOL;
      respond({
        jsonrpc: "2.0",
        id,
        result: {
          // Echo a requested version only when it is one this server implements;
          // otherwise declare the version it does.
          protocolVersion: requested === "2025-03-26" || requested === "2025-06-18" ? requested : SUPPORTED_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    if (!isRequest) return; // notifications/initialized, notifications/cancelled, …
    if (method === "ping") {
      respond({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      respond({ jsonrpc: "2.0", id, result: await toolsList() });
      return;
    }
    if (method === "tools/call") {
      respond({ jsonrpc: "2.0", id, result: await toolsCall(id, message.params) });
      return;
    }
    respondError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    respondError(id, -32603, error instanceof Error ? error.message : "Internal error");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      respondError(null, -32700, "Parse error");
      continue;
    }
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
