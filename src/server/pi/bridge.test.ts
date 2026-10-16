import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getWorkspaceForConversation, SYSTEM_RESOLVED_BY } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { newRunId } from "@/shared/ids";
import { getAllPendingWrites, approvePendingWrite } from "@/server/pending-writes";
import { getFileWrites } from "@/server/dispatch-file-writes";
import { setTimeout as delay } from "node:timers/promises";
import { createPiBridge } from "./bridge";
import { provisionedPlatformToolNames } from "./tool-surface";
import { acquirePiWorkspace, type PiWorkspaceLease } from "./workspace-lease";
import { toolRegistry } from "@/server/tools/registry";

const bridges: Array<Awaited<ReturnType<typeof createPiBridge>>> = [];
const leases: PiWorkspaceLease[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  leases.splice(0).forEach(lease => lease.release());
  vi.restoreAllMocks();
});
async function fixture(toolNames: string[] = ["fs_write"], onBudgetExceeded = () => {}, agentGrants: string[] = toolNames, withLease = false) {
  const agent = createAgent({ name: "Bridge test", adapterName: "pi", modelId: "fixture", toolNames: agentGrants.filter(name => name !== "report_task_result") });
  const conversation = createConversation({ mode: "single", agentIds: [agent.id] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  const runId = newRunId();
  const lease = withLease ? await acquirePiWorkspace(workspace.rootPath, new AbortController().signal) : null;
  if (lease) { lease.attachChild(process.pid); leases.push(lease); }
  const bridge = await createPiBridge({ agent, conversationId: conversation.id, runId, workspacePath: workspace.rootPath, toolNames, systemPrompt: "Fixture" } as never, new AbortController().signal, onBudgetExceeded, lease);
  bridges.push(bridge);
  const post = (route: string, body: unknown, token = bridge.token) => fetch(`${bridge.url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { bridge, post, runId, workspace, conversation };
}

describe("private Pi bridge admission", () => {
  it("pauses source tool admission during a peer workspace loan and resumes only after release", async () => {
    const originalExecute = toolRegistry.execute.bind(toolRegistry);
    let finishPeer!: () => void;
    const peerStopped = new Promise<void>(resolve => { finishPeer = resolve; });
    let peerStarted = false;
    vi.spyOn(toolRegistry, "execute").mockImplementation(async (name, args, ctx, meta) => {
      if (name !== "consult_agent") return originalExecute(name, args, ctx, meta);
      const peer = ctx.consultationLease!;
      peer.attachChild(process.pid);
      peerStarted = true;
      await peerStopped;
      peer.release();
      return { ok: true, value: { status: "replied" } };
    });
    const { post } = await fixture(["consult_agent", "fs_write"], () => {}, [], true);
    const consulting = post("/tool", { callId: "peer", name: "consult_agent", args: {} });
    try {
      await vi.waitFor(() => expect(peerStarted).toBe(true));
      const blocked = await post("/native/authorize", { callId: "during-peer", name: "write", args: { path: "blocked.txt" } });
      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("waiting for its peer") });
      finishPeer();
      expect((await consulting).status).toBe(200);
      expect((await post("/native/authorize", { callId: "after-peer", name: "write", args: { path: "resumed.txt" } })).status).toBe(200);
    } finally { finishPeer(); await consulting; }
  });

  it("does not lend ownership while an admitted native operation is unfinished", async () => {
    const { post } = await fixture(["consult_agent", "fs_write"], () => {}, [], true);
    expect((await post("/native/authorize", { callId: "write", name: "write", args: { path: "pending.txt" } })).status).toBe(200);
    const blocked = await post("/tool", { callId: "peer", name: "consult_agent", args: {} });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("Finish other tool calls") });
  });
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
    // Retired executors and terminal platform protocol tools are not ordinary
    // capabilities. The same-conversation roster is available to all Agents.
    expect(provisioned).not.toContain("job_start");
    expect(provisioned).not.toContain("plan_tasks");
    expect(provisioned).not.toContain("respond_to_consultation");
    expect(provisioned).toContain("list_team_members");
    const { post } = await fixture(provisioned, () => {}, []);
    expect((await post("/native/authorize", { callId: "write", name: "write", args: { path: "granted.txt" } })).status).toBe(200);
    expect((await post("/native/authorize", { callId: "shell", name: "bash", args: { command: "mkdir -p src && cat > src/App.css" } })).status).toBe(200);
    expect((await post("/tool", { callId: "artifact", name: "read_artifact", args: { artifactId: "art_missing" } })).status).toBe(200);
    const roster = await post("/tool", { callId: "roster", name: "list_team_members", args: {} });
    expect(roster.status).toBe(200);
    expect(await roster.json()).toMatchObject({ ok: true, value: { members: expect.any(Array) } });
  });

  it("advertises the roster line only to a run provisioned with the roster tool", async () => {
    const manifest = (bridge: Awaited<ReturnType<typeof createPiBridge>>) =>
      fetch(`${bridge.url}/manifest`, { headers: { Authorization: `Bearer ${bridge.token}` } }).then(response => response.json());

    // Workers and planners can both discover current peers without role grants.
    const worker = await fixture(provisionedPlatformToolNames(), () => {}, []);
    const workerManifest = await manifest(worker.bridge) as { systemPrompt: string; definitions: Array<{ name: string }> };
    expect(workerManifest.definitions.map(definition => definition.name)).toContain("list_team_members");
    expect(workerManifest.systemPrompt).toContain("use list_team_members for the current roster");

    const planner = await fixture(["list_team_members", "plan_tasks"], () => {}, []);
    const plannerManifest = await manifest(planner.bridge) as { systemPrompt: string; definitions: Array<{ name: string }> };
    expect(plannerManifest.definitions.map(definition => definition.name)).toContain("list_team_members");
    expect(plannerManifest.systemPrompt).toContain("use list_team_members for the current roster");
  });

  it("admits a native write that resolves outside the workspace and records it", async () => {
    // Issue #79: native file tools are full-access, so `../` is not a refusal.
    // The path is still resolved (against the workspace root for a relative
    // path) and the resulting change is still recorded as evidence.
    const { post, bridge, runId, workspace } = await fixture();
    const outside = path.resolve(workspace.rootPath, "..", "escape.txt");
    expect((await post("/native/authorize", { callId: "escape", name: "write", args: { path: "../escape.txt", content: "no" } })).status).toBe(200);
    expect((await post("/native/change", { callId: "escape", path: outside, content: "no" })).status).toBe(200);
    // Pi performs the bytes; the bridge only authorizes and then observes.
    fs.writeFileSync(outside, "no");
    expect((await post("/native/result", { callId: "escape", result: { content: [{ type: "text", text: "wrote ../escape.txt" }] }, isError: false })).status).toBe(200);
    expect(bridge.result("escape")?.ok).toBe(true);
    expect(getFileWrites(runId).has(outside)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("no");
    fs.rmSync(outside, { force: true });
  });
  it("admits and records writes through a directory link outside the workspace", async () => {
    const { post, bridge, runId, workspace } = await fixture();
    const outside = path.join(workspace.rootPath, "..", "outside-pi-bridge-fixture");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace.rootPath, "linked"), "junction");
    const linked = path.join(workspace.rootPath, "linked", "escape.txt");
    expect((await post("/native/authorize", { callId: "linked", name: "write", args: { path: "linked/escape.txt", content: "no" } })).status).toBe(200);
    expect((await post("/native/change", { callId: "linked", path: linked, content: "no" })).status).toBe(200);
    fs.writeFileSync(linked, "no");
    expect((await post("/native/result", { callId: "linked", result: { content: [{ type: "text", text: "wrote linked/escape.txt" }] }, isError: false })).status).toBe(200);
    expect(bridge.result("linked")?.ok).toBe(true);
    expect(getFileWrites(runId).has(linked)).toBe(true);
    expect(fs.readFileSync(path.join(outside, "escape.txt"), "utf8")).toBe("no");
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
