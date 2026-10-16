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
import { provisionedPlatformToolNames } from "./tool-surface";

const bridges: Array<Awaited<ReturnType<typeof createPiBridge>>> = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });
async function fixture(toolNames: string[] = ["fs_write"], onBudgetExceeded = () => {}, agentGrants: string[] = toolNames) {
  const agent = createAgent({ name: "Bridge test", adapterName: "pi", modelId: "fixture", toolNames: agentGrants.filter(name => name !== "report_task_result") });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  const runId = newRunId();
  const bridge = await createPiBridge({ agent, conversationId: conversation.id, runId, workspacePath: workspace.rootPath, toolNames, systemPrompt: "Fixture" } as never, new AbortController().signal, onBudgetExceeded);
  bridges.push(bridge);
  const post = (route: string, body: unknown, token = bridge.token) => fetch(`${bridge.url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { bridge, post, runId, workspace, conversation };
}

describe("private Pi bridge admission", () => {
  it("rejects missing credentials, unmapped native names and call ID replay", async () => {
    const { post } = await fixture();
    expect((await post("/native/authorize", { callId: "missing", name: "write", args: {} }, "wrong")).status).toBe(403);
    // There is no native mapping for this name, so there is nothing to run.
    expect((await post("/native/authorize", { callId: "no_mapping", name: "not_a_native_tool", args: {} })).status).toBe(400);
    // Replay/dedup protection stays: a consumed call ID cannot be admitted twice.
    expect((await post("/native/authorize", { callId: "replay", name: "write", args: { path: "a.txt" } })).status).toBe(200);
    expect((await post("/native/authorize", { callId: "replay", name: "write", args: { path: "a.txt" } })).status).toBe(400);
  });

  it("still scopes platform-internal business tools to what was provisioned", async () => {
    // The bridge is a faithful provisioner: it executes only the business tools
    // this invocation listed. An Agent run lists everything (see the tests
    // below); the Conductor's PLAN stage deliberately lists a narrow set.
    const { post } = await fixture();
    expect((await post("/tool", { callId: "unprovisioned", name: "deploy_workspace", args: {} })).status).toBe(403);
  });

  it("provisions an Agent with no stored grants with the whole Pi toolset", async () => {
    // Issue #79: agent-runner provisions every Agent run with
    // provisionedPlatformToolNames(), whatever the Agent record says. Here the
    // Agent has NO grants at all, yet native and business tools are admitted.
    const provisioned = provisionedPlatformToolNames();
    expect(provisioned).toEqual(expect.arrayContaining(["fs_read", "fs_write", "fs_patch", "bash", "read_artifact", "write_artifact", "deploy_workspace", "web_fetch", "browser_check"]));
    // The retired job_* kernel and the Conductor's PLAN protocol tool are not
    // Agent capabilities; the PLAN stage provisions plan_tasks for itself.
    expect(provisioned).not.toContain("job_start");
    expect(provisioned).not.toContain("plan_tasks");
    const { post } = await fixture(provisioned, () => {}, []);
    expect((await post("/native/authorize", { callId: "write", name: "write", args: { path: "granted.txt" } })).status).toBe(200);
    expect((await post("/native/authorize", { callId: "shell", name: "bash", args: { command: "mkdir -p src && cat > src/App.css" } })).status).toBe(200);
    expect((await post("/tool", { callId: "artifact", name: "read_artifact", args: { artifactId: "art_missing" } })).status).toBe(200);
  });

  it("rejects path traversal through a native tool", async () => {
    const { post, bridge } = await fixture();
    expect((await post("/native/authorize", { callId: "escape", name: "write", args: { path: "../escape.txt", content: "no" } })).status).toBe(400);
    expect(bridge.result("escape")?.ok).toBe(false);
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
