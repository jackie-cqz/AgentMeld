import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  describeSkippedResources,
  importInboundResources,
  safeAttachmentName
} from "@/server/channels/feishu/attachment-import";
import { getDatabase } from "@/db/client";
import { createConversation, getWorkspaceForConversation } from "@/server/repositories";
import { createWorkspace } from "@/server/conversation-service";

/** The attachments the importer wrote, read the way the API route reads them. */
function storedAttachments(conversationId: string) {
  return getDatabase()
    .prepare(
      "SELECT id, kind, file_name, file_path, size FROM attachments WHERE conversation_id = ? ORDER BY created_at"
    )
    .all(conversationId) as Array<{
    id: string;
    kind: string;
    file_name: string;
    file_path: string;
    size: number;
  }>;
}

const { channelsByAgent, downloads } = vi.hoisted(() => ({
  channelsByAgent: new Map<string, unknown>(),
  downloads: [] as Array<{ messageId: string; fileKey: string; type: string }>
}));

vi.mock("@/server/channels/feishu/registry", () => ({
  getFeishuChannelForAgent: (agentId: string) => {
    const channel = channelsByAgent.get(agentId);
    if (!channel) return null;
    return {
      downloadResource: async (messageId: string, fileKey: string, type: string) => {
        downloads.push({ messageId, fileKey, type });
        const behaviour = (channel as { behaviour?: (key: string) => unknown }).behaviour;
        const result = behaviour ? behaviour(fileKey) : Buffer.from(`bytes of ${fileKey}`);
        if (result instanceof Error) throw result;
        return result as Buffer;
      }
    };
  }
}));

const AGENT = "ag_pm";

describe("safeAttachmentName", () => {
  it("keeps an ordinary name", () => {
    expect(safeAttachmentName("report.md", "fallback")).toBe("report.md");
  });

  it("strips what a filesystem must not be told", () => {
    expect(safeAttachmentName("../../etc/passwd", "fallback")).toBe("..-..-etc-passwd");
    expect(safeAttachmentName("a/b\\c:d.txt", "fallback")).toBe("a-b-cd.txt");
  });

  it("refuses a name that is only a traversal", () => {
    expect(safeAttachmentName("..", "fallback")).toBe("fallback");
    expect(safeAttachmentName(".", "fallback")).toBe("fallback");
    expect(safeAttachmentName("", "fallback")).toBe("fallback");
    expect(safeAttachmentName(null, "fallback")).toBe("fallback");
  });
});

describe("describeSkippedResources", () => {
  it("says nothing when nothing was skipped", () => {
    expect(describeSkippedResources([])).toBeNull();
  });

  it("names what did not arrive, so the sender knows", () => {
    expect(describeSkippedResources(["a.pdf（下载失败）"])).toContain("a.pdf");
  });
});

describe("importing attachments a person sent", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-attachments-");
    downloads.length = 0;
    channelsByAgent.clear();

    createConversation({
      id: "conv_1", title: "飞书群", mode: "group", agentIds: [AGENT],
      fsWriteApprovalMode: "auto", now: 1
    });
    // The repository insert does not create a workspace, and the importer needs
    // one to write into.
    createWorkspace("conv_1", 1);
    channelsByAgent.set(AGENT, {});
  });

  afterEach(() => {
    teardown();
  });

  const importOnce = (resources: Array<{ type: string; fileKey: string; fileName: string | null }>) =>
    importInboundResources({
      agentId: AGENT,
      conversationId: "conv_1",
      platformMessageId: "om_1",
      resources
    });

  it("fetches the bytes as the bot that received them", async () => {
    // The platform scopes a resource to the app it was sent to, so the download
    // has to be made as that agent.
    const outcome = await importOnce([
      { type: "file", fileKey: "fk_1", fileName: "报告.md" }
    ]);

    expect(outcome.status).toBe("imported");
    if (outcome.status !== "imported") return;
    expect(outcome.attachmentIds).toHaveLength(1);
    expect(downloads[0]).toEqual({ messageId: "om_1", fileKey: "fk_1", type: "file" });
  });

  it("puts the file where the web uploader puts files", async () => {
    // One convention for the agent, whichever door the file came through.
    await importOnce([{ type: "file", fileKey: "fk_1", fileName: "报告.md" }]);

    const workspace = getWorkspaceForConversation("conv_1");
    const stored = storedAttachments("conv_1")[0];
    expect(stored.file_path.startsWith(`${workspace!.rootPath}/attachments/`)).toBe(true);
    expect(fs.readFileSync(stored.file_path, "utf-8")).toBe("bytes of fk_1");
    expect(stored.size).toBe("bytes of fk_1".length);
  });

  it("records an image as an image", async () => {
    await importOnce([{ type: "image", fileKey: "fk_png", fileName: "图.png" }]);
    expect(storedAttachments("conv_1")[0].kind).toBe("image");
  });

  it("gives a traversal-shaped name nowhere to go", async () => {
    await importOnce([{ type: "file", fileKey: "fk_1", fileName: "../../escape.md" }]);

    const stored = storedAttachments("conv_1")[0];
    const workspace = getWorkspaceForConversation("conv_1");
    // The path may contain the dashes the name now has, but it must still be
    // inside the attachments directory.
    expect(stored.file_path.startsWith(`${workspace!.rootPath}/attachments/`)).toBe(true);
    expect(stored.file_name).not.toContain("/");
  });

  it("says which file did not arrive instead of dropping it quietly", async () => {
    channelsByAgent.set(AGENT, {
      behaviour: (key: string) => (key === "fk_bad" ? new Error("nope") : Buffer.from("ok"))
    });

    const outcome = await importOnce([
      { type: "file", fileKey: "fk_bad", fileName: "坏的.pdf" },
      { type: "file", fileKey: "fk_ok", fileName: "好的.pdf" }
    ]);

    if (outcome.status !== "imported") throw new Error("expected imported");
    // One failure does not lose the other file.
    expect(outcome.attachmentIds).toHaveLength(1);
    expect(outcome.skipped.join()).toContain("坏的.pdf");
    expect(storedAttachments("conv_1")).toHaveLength(1);
  });

  it("refuses a file too large to pull in, by name", async () => {
    channelsByAgent.set(AGENT, { behaviour: () => Buffer.alloc(31 * 1024 * 1024) });

    const outcome = await importOnce([{ type: "file", fileKey: "fk_big", fileName: "大.bin" }]);

    if (outcome.status !== "imported") throw new Error("expected imported");
    expect(outcome.attachmentIds).toHaveLength(0);
    expect(outcome.skipped.join()).toContain("超过大小上限");
  });

  it("stops at a bounded number and says so", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      type: "file",
      fileKey: `fk_${i}`,
      fileName: `f${i}.txt`
    }));

    const outcome = await importOnce(many);

    if (outcome.status !== "imported") throw new Error("expected imported");
    expect(outcome.attachmentIds).toHaveLength(10);
    expect(outcome.skipped.join()).toContain("另有 2 个");
  });

  it("has nothing to do without attachments", async () => {
    expect(await importOnce([])).toEqual({ status: "skipped", reason: "no attachments" });
    expect(downloads).toHaveLength(0);
  });

  it("stays silent without a channel to fetch them with", async () => {
    channelsByAgent.clear();
    expect(await importOnce([{ type: "file", fileKey: "fk", fileName: "a" }])).toEqual({
      status: "skipped",
      reason: "agent has no live channel"
    });
  });

  it("stays silent without a workspace to put them in", async () => {
    expect(
      await importInboundResources({
        agentId: AGENT,
        conversationId: "conv_missing",
        platformMessageId: "om_1",
        resources: [{ type: "file", fileKey: "fk", fileName: "a" }]
      })
    ).toEqual({ status: "skipped", reason: "the conversation has no workspace" });
  });
});
