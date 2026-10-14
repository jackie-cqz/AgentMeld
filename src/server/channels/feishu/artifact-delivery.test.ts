import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  artifactFileFor,
  projectArtifact,
  startChannelArtifactDelivery,
  stopChannelArtifactDeliveryForTests
} from "@/server/channels/feishu/artifact-delivery";
import { setChannelProjectionPaused } from "@/server/channels/feishu/projection";
import { eventBus } from "@/server/event-bus";
import {
  createChannelConversation,
  createConversation,
  upsertChannelBinding
} from "@/server/repositories";
import type { Artifact } from "@/shared/types";

const { channelsByAgent, sent } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    if (!channelsByAgent.has(agentId)) return null;
    return {
      send: async (chatId: string, input: unknown) => {
        sent.push({ agentId, chatId, input });
        return { messageId: `om_${sent.length}` };
      }
    };
  }
}));

const AGENT = "ag_pm";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_1",
    conversationId: "conv_1",
    createdByAgentId: AGENT,
    type: "document",
    title: "登录页说明",
    content: { type: "document", content: "# 说明\n\n这是内容。" },
    version: 1,
    parentArtifactId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe("artifactFileFor", () => {
  it("turns a document into a markdown file", () => {
    const file = artifactFileFor(artifact(), null);
    expect("reason" in file).toBe(false);
    if ("reason" in file) return;
    expect(file.name).toBe("登录页说明.md");
    expect(file.content.toString("utf-8")).toContain("这是内容");
  });

  it("strips what a filename must not contain", () => {
    // A title is model-written, and a slash in it would either fail the upload
    // or, worse, suggest a path.
    const file = artifactFileFor(artifact({ title: "a/b\\c:d*e?f<g>h" }), null);
    if ("reason" in file) throw new Error("expected a file");
    expect(file.name).toBe("a-b-cdefgh.md");
  });

  it("falls back to a name when the title is empty", () => {
    const file = artifactFileFor(artifact({ title: "" }), null);
    if ("reason" in file) throw new Error("expected a file");
    expect(file.name).toBe("artifact.md");
  });

  it("reads a code file out of the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      fs.writeFileSync(path.join(root, "main.ts"), "export const a = 1;");
      const file = artifactFileFor(
        artifact({
          title: "main.ts",
          content: { type: "code_file", workspacePath: "main.ts" }
        }),
        root
      );
      if ("reason" in file) throw new Error("expected a file");
      expect(file.content.toString("utf-8")).toContain("export const a = 1;");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to read outside the workspace", () => {
    // The stored path is not a reason to trust it; the file browser uses the
    // same guard.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      const file = artifactFileFor(
        artifact({ content: { type: "code_file", workspacePath: "../../etc/passwd" } }),
        root
      );
      expect("reason" in file).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("says why a type it cannot send is not sent", () => {
    // Not sending a web app is a decision; looking like an oversight is not.
    const web = artifactFileFor(
      artifact({ content: { type: "web_app", files: { "index.html": "<p>x</p>" }, entry: "index.html" } }),
      null
    );
    expect("reason" in web && web.reason).toContain("set of files");

    const diff = artifactFileFor(
      artifact({ content: { type: "diff", targetArtifactId: "a", hunks: [], applied: false } }),
      null
    );
    expect("reason" in diff).toBe(true);
  });

  it("says the file is gone rather than sending something empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      const file = artifactFileFor(
        artifact({ content: { type: "code_file", workspacePath: "missing.ts" } }),
        root
      );
      expect("reason" in file && file.reason).toContain("no longer on disk");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("delivering an artifact into the room", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-artifact-");
    sent.length = 0;
    channelsByAgent.clear();
    stopChannelArtifactDeliveryForTests();
    setChannelProjectionPaused(false);

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    createChannelConversation({
      id: "cc_1", channel: "feishu", chatId: "oc_1", conversationId: "conv_1", now: 1
    });
    channelsByAgent.set(AGENT, {});
    upsertChannelBinding({
      id: "cb_pm", agentId: AGENT, channel: "feishu", appId: "cli_pm", appSecret: "s",
      boundByOpenId: "ou_user", now: 1
    });
  });

  afterEach(() => {
    stopChannelArtifactDeliveryForTests();
    teardown();
  });

  it("hands the file to the room through the agent that made it", async () => {
    const outcome = await projectArtifact(artifact());

    expect(outcome.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe(AGENT);
    expect(sent[0].chatId).toBe("oc_1");
    const input = sent[0].input as { file: { fileName: string } };
    expect(input.file.fileName).toBe("登录页说明.md");
  });

  it("sends file bytes, not a path the room cannot reach", async () => {
    // The point of the whole thing: an artifact is local, and a chat member has
    // no route to a local path.
    await projectArtifact(artifact());
    const input = sent[0].input as { file: { source: Buffer } };
    expect(Buffer.isBuffer(input.file.source)).toBe(true);
    expect(input.file.source.toString("utf-8")).toContain("# 说明");
  });

  it("stays silent for a conversation that is not on a channel", async () => {
    const outcome = await projectArtifact(artifact({ conversationId: "conv_other" }));
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(sent).toHaveLength(0);
  });

  it("stays silent rather than delivering as the wrong agent", async () => {
    channelsByAgent.clear();
    const outcome = await projectArtifact(artifact());
    expect(outcome).toEqual({ status: "skipped", reason: "agent has no live channel" });
  });

  it("stays silent for an artifact nobody authored", async () => {
    const outcome = await projectArtifact(artifact({ createdByAgentId: null }));
    expect(outcome).toEqual({ status: "skipped", reason: "the artifact has no author" });
  });

  it("yields to the pause switch", async () => {
    setChannelProjectionPaused(true);
    expect(await projectArtifact(artifact())).toEqual({ status: "skipped", reason: "paused" });
  });

  it("subscribes once and delivers on creation", async () => {
    const first = startChannelArtifactDelivery();
    expect(startChannelArtifactDelivery()).toBe(first);

    eventBus.publish({
      type: "artifact.create",
      conversationId: "conv_1",
      timestamp: 1,
      artifact: artifact()
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
  });
});
