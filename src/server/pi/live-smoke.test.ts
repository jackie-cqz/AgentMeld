import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getWorkspaceForConversation, listArtifacts } from "@/server/repositories";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";
import { newMessageId, newRunId } from "@/shared/ids";
import { runPiInvocation } from "./runtime";
import type { StreamEvent } from "@/shared/types";

// The configured gateway serves a DeepSeek-compatible model under its own id;
// it does not serve the public `deepseek-chat` name. Keep this in step with the
// gateway (overridable for a machine pointed at a different deployment) rather
// than hardcoding a model the provider will reject.
const liveModelId = process.env.DEEPSEEK_MODEL_ID?.trim() || "deepseek-v4-flash";

// Explicit opt-in: the ordinary suite never sends requests to a paid provider.
it.runIf(process.env.AGENTMELD_PI_LIVE_SMOKE === "1")("real provider: native read, edit, verification and stored artifact", async () => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key.includes("your_")) throw new Error("Live Pi smoke requires a configured DeepSeek credential.");
  const agent = createAgent({ name: "Pi live smoke", description: "Isolated acceptance fixture", adapterName: "pi", modelProvider: "deepseek", modelId: liveModelId, apiKey: key,
    apiBaseUrl: resolveProviderBaseUrl("deepseek"), toolNames: ["fs_read", "fs_patch", "bash", "write_artifact"], systemPrompt: "Complete the exact small task using real tools. Do not claim success before verifying." });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto" });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  fs.writeFileSync(path.join(workspace.rootPath, "note.txt"), "old greeting\n");
  fs.writeFileSync(path.join(workspace.rootPath, "package.json"), JSON.stringify({ scripts: { test: "node --test smoke.test.cjs" } }));
  fs.writeFileSync(path.join(workspace.rootPath, "smoke.test.cjs"), 'const assert=require("node:assert/strict"); const fs=require("node:fs"); require("node:test")("greeting",()=>assert.equal(fs.readFileSync("note.txt","utf8"),"Pi verified\\n"));');
  const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", origin: "human", parts: [{ type: "text", content: "Read note.txt, use native edit to replace old greeting with Pi verified (preserve its final newline). Then execute exactly npm run test. If tests pass, call write_artifact to save a short Markdown document titled Pi smoke result with the real verification outcome. Do not write or change any other workspace files. Finish with a short confirmation." }], status: "complete", now: Date.now() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const events: StreamEvent[] = [];
  try {
    try {
      for await (const event of runPiInvocation({ agent, conversation, triggerMessage, workspace, workspacePath: workspace.rootPath, conversationId: conversation.id, runId: newRunId(), recentMessages: [], apiKey: key, apiBaseUrl: agent.apiBaseUrl, toolNames: agent.toolNames, systemPrompt: agent.systemPrompt }, controller.signal)) events.push(event);
    } catch (error) {
      // A provider that rejects the model must fail honestly and say which
      // model/endpoint it rejected; never fall back to a different model.
      throw new Error(`Pi live smoke failed against model "${liveModelId}" at ${agent.apiBaseUrl}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    expect(fs.readFileSync(path.join(workspace.rootPath, "note.txt"), "utf8")).toBe("Pi verified\n");
    const calls = events.filter(event => event.type === "tool.call");
    for (const name of ["read", "edit", "bash", "write_artifact"]) {
      expect(calls.some(call => call.toolName === name && events.some(event => event.type === "tool.result" && event.callId === call.callId && !event.isError)), `successful ${name} receipt`).toBe(true);
    }
    const usage = events.find((event): event is Extract<StreamEvent, { type: "run.usage" }> => event.type === "run.usage");
    expect(usage?.usage.modelId, "the run reports the model the gateway actually served").toBe(liveModelId);
    expect(listArtifacts(conversation.id)).toHaveLength(1);
    if (process.env.AGENTMELD_PI_LIVE_SMOKE_TRACE === "1") {
      const artifacts = listArtifacts(conversation.id);
      console.info(`[pi live smoke] model=${liveModelId} endpoint=${agent.apiBaseUrl}`);
      console.info(`[pi live smoke] tool calls=${JSON.stringify(calls.map(call => call.toolName))}`);
      console.info(`[pi live smoke] usage=${JSON.stringify(usage?.usage)}`);
      console.info(`[pi live smoke] artifacts=${JSON.stringify(artifacts.map(artifact => ({ id: artifact.id, type: artifact.type, title: artifact.title })))}`);
    }
  } finally { clearTimeout(timer); }
}, 120000);
