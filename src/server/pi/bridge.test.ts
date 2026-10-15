import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation, SYSTEM_RESOLVED_BY } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { newRunId } from "@/shared/ids";
import { getAllPendingWrites, approvePendingWrite } from "@/server/pending-writes";
import { setTimeout as delay } from "node:timers/promises";
import { createPiBridge } from "./bridge";

const bridges: Array<Awaited<ReturnType<typeof createPiBridge>>> = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });
async function fixture(toolNames: string[] = ["fs_write"], onBudgetExceeded = () => {}) {
  const agent = createAgent({ name: "Bridge test", adapterName: "pi", modelId: "fixture", toolNames: toolNames.filter(name => name !== "report_task_result") });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  const runId = newRunId();
  const bridge = await createPiBridge({ agent, conversationId: conversation.id, runId, workspacePath: workspace.rootPath, toolNames, systemPrompt: "Fixture" } as never, new AbortController().signal, onBudgetExceeded);
  bridges.push(bridge);
  const post = (route: string, body: unknown, token = bridge.token) => fetch(`${bridge.url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { bridge, post, runId, workspace, conversation };
}

describe("private Pi bridge admission", () => {
  it("rejects missing credentials, unknown capabilities and call ID replay", async () => {
    const { post } = await fixture();
    expect((await post("/native/authorize", { callId: "missing", name: "write", args: {} }, "wrong")).status).toBe(403);
    expect((await post("/tool", { callId: "unknown", name: "deploy_workspace", args: {} })).status).toBe(403);
    expect((await post("/native/authorize", { callId: "unknown", name: "write", args: { path: "a" } })).status).toBe(400);
  });
  it("rejects path traversal and ungranted native tools", async () => {
    const { post, bridge } = await fixture();
    expect((await post("/native/authorize", { callId: "escape", name: "write", args: { path: "../escape.txt", content: "no" } })).status).toBe(400);
    expect(bridge.result("escape")?.ok).toBe(false);
    expect((await post("/native/authorize", { callId: "shell", name: "bash", args: { command: "npm test" } })).status).toBe(400);
  });
  it("rejects writes through a directory link outside the workspace", async () => {
    const { post, workspace } = await fixture();
    const outside = path.join(workspace.rootPath, "..", "outside-pi-bridge-fixture");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace.rootPath, "linked"), "junction");
    expect((await post("/native/authorize", { callId: "linked", name: "write", args: { path: "linked/escape.txt", content: "no" } })).status).toBe(400);
    expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
  });
  it("rejects turns past the runtime budget instead of declaring completion", async () => {
    let exceeded = false;
    const { post } = await fixture([], () => { exceeded = true; });
    for (let n = 0; n < 64; n++) expect((await post("/turn", {})).status).toBe(200);
    expect((await post("/turn", {})).status).toBe(409);
    expect(exceeded).toBe(true);
  });
  it("invalidates approval if the file changes before the decision", async () => {
    const { post, runId, workspace, conversation } = await fixture();
    getDatabase().prepare("UPDATE conversations SET fs_write_approval_mode='review' WHERE id=?").run(conversation.id);
    const file = path.join(workspace.rootPath, "file.txt");
    fs.writeFileSync(file, "original");
    expect((await post("/native/authorize", { callId: "change", name: "write", args: { path: "file.txt", content: "proposed" } })).status).toBe(200);
    const pending = post("/native/change", { callId: "change", path: file, content: "proposed" });
    for (let n = 0; n < 50 && !getAllPendingWrites().some(write => write.runId === runId); n++) await delay(10);
    const approval = getAllPendingWrites().find(write => write.runId === runId)!;
    expect(approval).toBeDefined();
    fs.writeFileSync(file, "external update");
    expect(approvePendingWrite(approval.id, SYSTEM_RESOLVED_BY)).toBe(true);
    expect((await pending).status).toBe(400);
    expect(fs.readFileSync(file, "utf8")).toBe("external update");
    expect(approvePendingWrite(approval.id, SYSTEM_RESOLVED_BY)).toBe(false);
  });
  it("does not admit mutations after a terminal task report", async () => {
    const { post } = await fixture(["report_task_result", "fs_write"]);
    const result = await post("/tool", { callId: "report", name: "report_task_result", args: { status: "complete", summary: "Fixture", acceptanceResults: [] } });
    expect(result.status).toBe(200);
    expect((await post("/native/authorize", { callId: "late", name: "write", args: { path: "late.txt" } })).status).toBe(400);
  });
});
