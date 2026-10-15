import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getAgent, getWorkspaceForConversation } from "@/server/repositories";
import { newMessageId } from "@/shared/ids";
import { buildPiTaskPacket } from "./runtime";
import type { PiInvocationInput } from "./types";

function input(): PiInvocationInput {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  const workspace = getWorkspaceForConversation(conversation.id)!;
  return { agent: getAgent("ag_mock_builder")!, conversation, workspace, conversationId: conversation.id, workspacePath: workspace.rootPath,
    triggerMessage: createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", origin: "human", parts: [{ type: "text", content: "/new is task text, not a native command" }], status: "complete", now: Date.now() }), runId: "fixture", toolNames: [], systemPrompt: "", recentMessages: [], apiKey: null };
}

describe("Pi cross-task context packet", () => {
  it("wraps raw slash commands rather than letting Pi interpret them as session commands", () => {
    expect(buildPiTaskPacket(input()).startsWith("<current_platform_task>")).toBe(true);
  });
  it("injects a compiled child context once without the entire group history", () => {
    const value = input();
    value.parentRunId = "parent";
    value.contextXml = "<task_context>Current authoritative facts</task_context>";
    value.history = [{ role: "user", content: "irrelevant old group history" }];
    const packet = buildPiTaskPacket(value);
    expect(packet.split("Current authoritative facts")).toHaveLength(2);
    expect(packet).not.toContain("irrelevant old group history");
  });
  it("includes only attachment references belonging to this conversation", () => {
    const value = input();
    const other = input();
    const insert = getDatabase().prepare("INSERT INTO attachments (id,conversation_id,kind,file_name,file_path,size,mime_type,created_at) VALUES (?,?,?,?,?,?,?,?)");
    insert.run("att_owned", value.conversationId, "file", "owned.txt", path.join(value.workspacePath, "owned.txt"), 1, "text/plain", 1);
    insert.run("att_foreign", other.conversationId, "file", "private.txt", path.join(other.workspacePath, "private.txt"), 1, "text/plain", 1);
    value.triggerMessage.parts.push(...["att_owned", "att_foreign"].map(attachmentId => ({ type: "file_attachment" as const, attachmentId, fileName: "file.txt", size: 1, mimeType: "text/plain" })));
    const packet = buildPiTaskPacket(value);
    expect(packet).toContain("att_owned");
    expect(packet).not.toContain("att_foreign");
    expect(packet).not.toContain("private.txt");
  });
});
