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
import {
  setChannelProjectionPaused,
  stopChannelProjectionForTests
} from "@/server/channels/feishu/projection";
import { eventBus } from "@/server/event-bus";
import {
  createChannelConversation,
  addChannelConversationMember,
  createConversation,
  getConversation,
  upsertChannelBinding
} from "@/server/repositories";
import { getDatabase } from "@/db/client";
import type { Artifact, Workspace } from "@/shared/types";

const { channelsByAgent, sent, failingAgents } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  sent: [] as Array<{ agentId: string; chatId: string; input: unknown }>,
  failingAgents: new Set<string>()
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    if (!channelsByAgent.has(agentId)) return null;
    return {
      send: async (chatId: string, input: unknown) => {
        if (failingAgents.has(agentId)) throw new Error(`bot ${agentId} is not a member of ${chatId}`);
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

  /** A workspace record the guard can resolve, pointed at a real directory. */
  function workspaceAt(root: string): Workspace {
    return {
      id: "ws", conversationId: "conv_1", mode: "sandbox", rootPath: root,
      boundPath: null, createdAt: 1, updatedAt: 1
    };
  }

  it("reads a code file out of the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      fs.writeFileSync(path.join(root, "main.ts"), "export const a = 1;");
      const file = artifactFileFor(
        artifact({
          title: "main.ts",
          content: { type: "code_file", workspacePath: "main.ts" }
        }),
        workspaceAt(root)
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
        workspaceAt(root)
      );
      expect("reason" in file).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points out of the workspace", () => {
    // The review's find, with a probe: the lexical check passed a link whose
    // target was outside, and the target's contents were read and sent. A
    // symlink to ~/.ssh would have gone to the group.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

      const file = artifactFileFor(
        artifact({ title: "link.txt", content: { type: "code_file", workspacePath: "link.txt" } }),
        workspaceAt(root)
      );

      expect("reason" in file).toBe(true);
      if ("reason" in file) expect(file.reason).toContain("escapes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file larger than it will read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024));

      const file = artifactFileFor(
        artifact({ title: "big", content: { type: "code_file", workspacePath: "big.bin" } }),
        workspaceAt(root)
      );

      expect("reason" in file && file.reason).toContain("over the");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("decodes an inline image, because an image IS one file", () => {
    // The earlier refusal said an image "has no single file to send", which was
    // simply wrong — it is a single image.
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const file = artifactFileFor(
      artifact({
        title: "图",
        content: { type: "image", url: `data:image/png;base64,${png.toString("base64")}` }
      }),
      null
    );

    if ("reason" in file) throw new Error("expected a file");
    expect(file.name).toBe("图.png");
    expect(file.content.equals(png)).toBe(true);
  });

  it("will not fetch a URL a model supplied", () => {
    // Fetching it would make this process a request to anywhere the model names.
    const file = artifactFileFor(
      artifact({ content: { type: "image", url: "http://169.254.169.254/latest/meta-data/" } }),
      null
    );
    expect("reason" in file && file.reason).toContain("will not fetch");
  });

  it("sends a web app as one self-contained page, not a refusal", () => {
    // The old answer was "a .html attachment is not [opening it in a browser]".
    // A single-page app now becomes ONE file that opens on its own.
    const web = artifactFileFor(
      artifact({ content: { type: "web_app", files: { "index.html": "<p>x</p>" }, entry: "index.html" } }),
      null
    );
    expect("name" in web && web.name).toMatch(/\.html$/);
    expect("content" in web && web.content.toString("utf-8")).toContain("<p>x</p>");
  });

  it("zips a web app whose entry cannot stand alone", () => {
    // No reference to the other file: inlining it would silently drop it.
    const web = artifactFileFor(
      artifact({
        content: {
          type: "web_app",
          files: { "index.html": "<p>x</p>", "data.json": "{\"a\":1}" },
          entry: "index.html"
        }
      }),
      null
    );
    expect("name" in web && web.name).toMatch(/\.zip$/);
    expect("content" in web && web.content.includes(Buffer.from("data.json"))).toBe(true);
  });

  it("returns a reason for malformed web app content instead of throwing", () => {
    // The contract is "bytes or why": a TypeError here is swallowed by the
    // subscriber's catch, so the not-delivering log line would never appear.
    for (const files of [undefined, null, "nope", { "index.html": 42 }]) {
      const file = artifactFileFor(
        artifact({ content: { type: "web_app", files, entry: "index.html" } as never }),
        null
      );
      expect("reason" in file).toBe(true);
    }
  });

  it("refuses an empty web app rather than delivering an empty archive", () => {
    const file = artifactFileFor(
      artifact({ content: { type: "web_app", files: {}, entry: "index.html" } }),
      null
    );
    expect("reason" in file && file.reason).toContain("no files");
  });

  it("measures the ceiling on what is delivered, not on the source", () => {
    // A zip adds per-entry overhead, so a source at the limit can deliver over
    // it. Here the description bytes alone push the packaged size past the cap.
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`file-${String(i).padStart(3, "0")}.txt`] = "x".repeat(2600);
    const file = artifactFileFor(artifact({ content: { type: "web_app", files, entry: "index.html" } }), null);
    expect("reason" in file && file.reason).toContain("over the");
  });

  it("sends a change as a .diff file that says whether it was applied", () => {
    // The positive path had no test at all: only the empty diff was exercised,
    // so nothing asserted the name, the bytes, or the applied marker.
    const file = artifactFileFor(
      artifact({
        title: "登录页改动",
        content: {
          type: "diff",
          targetArtifactId: "art_1",
          applied: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" const a = 1;", "+const b = 2;"] }]
        }
      }),
      null
    );
    if (!("name" in file)) throw new Error("expected a file");
    expect(file.name).toBe("登录页改动.diff");
    const text = file.content.toString("utf-8");
    expect(text).toContain("已应用");
    expect(text).toContain("+const b = 2;");
    expect(text).toContain("@@ -1,1 +1,2 @@");
  });

  it("refuses a change that renders past the byte ceiling", () => {
    // The cap exists for diffs too, and deleting it used to leave every test
    // green.
    const lines = Array.from({ length: 60_000 }, () => `+${"x".repeat(40)}`);
    const file = artifactFileFor(
      artifact({ content: { type: "diff", targetArtifactId: "art_1", applied: false, hunks: [{ lines }] } }),
      null
    );
    expect("reason" in file && file.reason).toContain("over the");
  });

  it("says why an empty change is not sent", () => {
    // This used to be the example of a type that cannot be sent at all; a diff
    // is deliverable now, and what is left is malformed content — which must
    // still come back as a reason rather than a throw, because a throw would be
    // swallowed by the subscriber and leave no not-delivering line.
    const diff = artifactFileFor(
      artifact({ content: { type: "diff", targetArtifactId: "a", hunks: [], applied: false } }),
      null
    );
    expect("reason" in diff && diff.reason).toContain("no hunks");
  });

  it("says why a type it will never send is not sent", () => {
    // The net for a union member added later, which the compiler cannot check.
    const unknown = artifactFileFor(
      artifact({ content: { type: "hologram" } as never }),
      null
    );
    expect("reason" in unknown && unknown.reason).toContain("hologram");
  });

  it("says the file is gone rather than sending something empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-artifact-"));
    try {
      const file = artifactFileFor(
        artifact({ content: { type: "code_file", workspacePath: "missing.ts" } }),
        workspaceAt(root)
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
    failingAgents.clear();
    stopChannelArtifactDeliveryForTests();
    // The rate limit is a rolling window per conversation, and it lives in
    // globalThis — so a test that spends the budget leaves the next one unable
    // to send anything, failing for a reason that has nothing to do with it.
    stopChannelProjectionForTests();
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
    // Who is IN the group, which is the member table — not the conversation's
    // agentIds, which only says who may speak in it.
    addChannelConversationMember({ channelConversationId: "cc_1", agentId: AGENT, now: 1 });
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

  it("files the file delivery under the artifact's conversation and agent", async () => {
    const { clearDeliveryHealthForTests, getDeliveryHealth } = await import(
      "@/server/channels/feishu/delivery"
    );
    clearDeliveryHealthForTests();

    await projectArtifact(artifact());

    const [entry] = getDeliveryHealth();
    expect(entry).toMatchObject({ conversationId: "conv_1", agentId: AGENT, sent: 1 });
    clearDeliveryHealthForTests();
  });

  it("logs a skip the operator is told to grep for", async () => {
    // The operations guide says to grep `[feishu] not delivering`, so that line
    // is an interface: it vanished once with no test to notice.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const outcome = await projectArtifact(
        // A type that is still refused: web_app folds into a file now (#56),
        // so the skip this test is about needs a shape that has no single-file
        // form at all.
        artifact({ id: "art_unfoldable", content: { type: "diff", targetArtifactId: "a", hunks: [], applied: false } })
      );
      expect(outcome.status).toBe("skipped");
      const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("not delivering art_unfoldable");
    } finally {
      info.mockRestore();
    }
  });

  it("says why when nobody in the group can carry the file", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      channelsByAgent.clear();
      const outcome = await projectArtifact(artifact({ createdByAgentId: null }));
      expect(outcome).toEqual({
        status: "skipped",
        reason: "no agent observed in this group has a live channel"
      });
      const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("no agent observed in this group has a live channel");
    } finally {
      info.mockRestore();
      errors.mockRestore();
    }
  });

  it("reports every candidate failure, and the reason it gave up", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const second = "ag_designer";
      channelsByAgent.set(second, {});
      addChannelConversationMember({ channelConversationId: "cc_1", agentId: second, now: 2 });
      failingAgents.add(AGENT);
      failingAgents.add(second);

      const outcome = await projectArtifact(artifact({ createdByAgentId: null }));

      expect(outcome.status).toBe("skipped");
      expect(errors.mock.calls.length).toBe(2);
      const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("not delivering art_1");
    } finally {
      info.mockRestore();
      errors.mockRestore();
    }
  });

  it("stays silent for a conversation that is not on a channel", async () => {
    const outcome = await projectArtifact(artifact({ conversationId: "conv_other" }));
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(sent).toHaveLength(0);
  });

  it("stays silent rather than delivering as the wrong agent", async () => {
    channelsByAgent.clear();
    failingAgents.clear();
    const outcome = await projectArtifact(artifact());
    expect(outcome).toEqual({ status: "skipped", reason: "agent has no live channel" });
  });

  it("hands over an artifact nobody authored, using a bot in the conversation", async () => {
    // Web-created artifacts have no author. Skipping them made the whole
    // create path dead code: the row was stored and the room never heard.
    const delivered = await projectArtifact(artifact({ createdByAgentId: null }));
    expect(delivered).toMatchObject({ status: "delivered" });
  });

  it("carries an authorless artifact with a bot OBSERVED in the group", async () => {
    // conversation.agentIds says who may speak; the member table says who is in
    // the room. A bot that is only in the first list is not a carrier.
    const outsider = "ag_not_in_group";
    // Has a live channel, is in the conversation's agentIds — and was never
    // OBSERVED in the group, so it is not a carrier.
    channelsByAgent.set(outsider, {});
    // The outsider comes FIRST in agentIds; the bot actually in the group is
    // second, and the member table is the only source that says so.
    // The conversation already exists; make the outsider its FIRST agent, so a
    // carrier list taken from agentIds would pick the wrong bot.
    getDatabase()
      .prepare("UPDATE conversations SET agent_ids = ? WHERE id = ?")
      .run(JSON.stringify([outsider, AGENT]), "conv_1");
    expect(getConversation("conv_1")?.agentIds).toEqual([outsider, AGENT]);

    await projectArtifact(artifact({ createdByAgentId: null }));

    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe(AGENT);
  });

  it("tries the next observed member when the first cannot send", async () => {
    const second = "ag_designer";
    channelsByAgent.set(second, {});
    // Later first_seen_at, so the member order is definitely [failing, second]
    // (the list is ordered by first_seen_at, and equal timestamps leave the
    // order unspecified — which made an earlier version of this test pass even
    // with the fallback removed).
    addChannelConversationMember({ channelConversationId: "cc_1", agentId: second, now: 2 });
    failingAgents.add(AGENT);

    const outcome = await projectArtifact(artifact({ createdByAgentId: null }));

    expect(outcome).toMatchObject({ status: "delivered" });
    expect(sent).toHaveLength(1);
    expect(sent[0].agentId).toBe(second);
  });

  it("stays silent for an artifact nobody authored when no bot can carry it", async () => {
    // Nobody observed in the group has a channel any more.
    channelsByAgent.clear();
    failingAgents.clear();
    const outcome = await projectArtifact(artifact({ createdByAgentId: null }));
    expect(outcome).toEqual({
      status: "skipped",
      reason: "no agent observed in this group has a live channel"
    });
  });

  it("yields to the pause switch", async () => {
    setChannelProjectionPaused(true);
    expect(await projectArtifact(artifact())).toEqual({ status: "skipped", reason: "paused" });
  });

  it("does not deliver the same artifact twice", async () => {
    // Nothing stopped a second: `deploy_artifact` on a document re-announces it,
    // and the same artifact can arrive from two places.
    const first = await projectArtifact(artifact());
    const second = await projectArtifact(artifact());

    expect(first.status).toBe("delivered");
    expect(second).toEqual({ status: "skipped", reason: "already delivered" });
    expect(sent).toHaveLength(1);
  });

  it("counts what it sends against the rate limit", async () => {
    // The check existed and never counted, so twenty-five artifacts went out
    // inside a twenty-message window.
    for (let i = 0; i < 25; i += 1) {
      await projectArtifact(artifact({ id: `art_${i}`, title: `f${i}` }));
    }

    expect(sent.length).toBeLessThanOrEqual(20);
    expect(sent.length).toBeGreaterThan(0);
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
