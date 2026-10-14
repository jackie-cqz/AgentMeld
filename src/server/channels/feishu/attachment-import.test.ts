import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import {
  describeSkippedResources,
  importInboundResources
} from "@/server/channels/feishu/attachment-import";
import { safeFileName } from "@/server/channels/feishu/file-name";
import { getDatabase } from "@/db/client";
import { createConversation, getWorkspaceForConversation } from "@/server/repositories";
import { createWorkspace } from "@/server/conversation-service";

/** The attachments the importer wrote, read the way the API route reads them. */
function storedAttachments(conversationId: string) {
  return getDatabase()
    .prepare(
      "SELECT id, kind, file_name, file_path, size, mime_type FROM attachments WHERE conversation_id = ? ORDER BY created_at"
    )
    .all(conversationId) as Array<{
    id: string;
    kind: string;
    file_name: string;
    file_path: string;
    size: number;
    mime_type: string;
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
      downloadResourceToFile: async (
        messageId: string,
        fileKey: string,
        type: string,
        destPath: string
      ) => {
        downloads.push({ messageId, fileKey, type });
        const behaviour = (channel as { behaviour?: (key: string) => unknown }).behaviour;
        const result = behaviour ? behaviour(fileKey) : Buffer.from(`bytes of ${fileKey}`);
        if (result instanceof Error) throw result;
        // The real call writes to disk and reports what it wrote; a mock that
        // only returned bytes would not exercise the streaming path at all.
        const body = result as { body: Buffer; contentType?: string } | Buffer;
        const bytes = Buffer.isBuffer(body) ? body : body.body;
        fs.writeFileSync(destPath, bytes);
        return {
          bytesWritten: bytes.length,
          contentType: Buffer.isBuffer(body) ? undefined : body.contentType
        };
      }
    };
  }
}));

const AGENT = "ag_pm";

describe("safeAttachmentName", () => {
  it("keeps an ordinary name", () => {
    expect(safeFileName("report.md", "fallback")).toBe("report.md");
  });

  it("strips what a filesystem must not be told", () => {
    expect(safeFileName("../../etc/passwd", "fallback")).toBe("..-..-etc-passwd");
    expect(safeFileName("a/b\\c:d.txt", "fallback")).toBe("a-b-cd.txt");
  });

  it("refuses a name that is only a traversal", () => {
    expect(safeFileName("..", "fallback")).toBe("fallback");
    expect(safeFileName(".", "fallback")).toBe("fallback");
    expect(safeFileName("", "fallback")).toBe("fallback");
    expect(safeFileName(null, "fallback")).toBe("fallback");
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

  it("records an image as an image even though the platform sends no filename", async () => {
    // The old test passed `fileName: "图.png"`, which the platform NEVER sends
    // for an image — the SDK's own converter produces `{ type: "image",
    // fileKey }` with no name. Inferring the kind from a filename therefore made
    // every pasted screenshot a generic file, and the test had invented the
    // input it was asserting on.
    channelsByAgent.set(AGENT, {
      behaviour: () => ({ body: Buffer.from("png-bytes"), contentType: "image/png" })
    });

    await importOnce([{ type: "image", fileKey: "fk_png", fileName: null }]);

    const stored = storedAttachments("conv_1")[0];
    expect(stored.kind).toBe("image");
    expect(stored.mime_type).toBe("image/png");
    // The server's content-type supplies the extension the name lacked.
    expect(stored.file_name).toBe("attachment-1.png");
  });

  it("requests audio and video as files, which is what the API takes", async () => {
    // `ResourceDescriptor.type` carries audio/video/sticker, but the download
    // API accepts only 'image' or 'file'.
    await importOnce([{ type: "audio", fileKey: "fk_a", fileName: "a.m4a" }]);
    expect(downloads[0].type).toBe("file");
  });

  it("does not ask for a sticker, which the platform will not serve", async () => {
    const outcome = await importOnce([{ type: "sticker", fileKey: "fk_s", fileName: null }]);

    if (outcome.status !== "imported") throw new Error("expected imported");
    expect(downloads).toHaveLength(0);
    expect(outcome.skipped.join()).toContain("平台不提供此类资源");
  });

  it("removes the partial file when it exceeds the cap", async () => {
    // Streamed to disk, so the cap can only be applied after the write — and a
    // file left behind would make the cap decorative.
    channelsByAgent.set(AGENT, { behaviour: () => Buffer.alloc(31 * 1024 * 1024) });

    await importOnce([{ type: "file", fileKey: "fk_big", fileName: "大.bin" }]);

    const workspace = getWorkspaceForConversation("conv_1")!;
    const leftovers = fs
      .readdirSync(`${workspace.rootPath}/attachments`)
      .filter((name) => name.endsWith(".part"));
    expect(leftovers).toEqual([]);
    expect(storedAttachments("conv_1")).toHaveLength(0);
  });

  it("truncates a long name by code point, leaving no lone surrogate", async () => {
    // Slicing by UTF-16 unit splits a surrogate pair, and the filesystem turns
    // the orphan into U+FFFD — so the stored name and the file on disk differ.
    const name = `${"图".repeat(130)}.png`;
    await importOnce([{ type: "file", fileKey: "fk_1", fileName: name }]);

    const stored = storedAttachments("conv_1")[0];
    expect(/[\uD800-\uDFFF]/.test(stored.file_name)).toBe(false);
    // And the name on disk is the name in the row.
    expect(fs.existsSync(stored.file_path)).toBe(true);
    expect(stored.file_path.endsWith(stored.file_name)).toBe(true);
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
