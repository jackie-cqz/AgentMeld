import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { createConversation } from "@/server/conversation-service";
import { getDatabase } from "@/db/client";
import { newWorkspaceId } from "@/shared/ids";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-ws-sec-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Helper: create a conversation with workspace and return the workspace path
function setupWorkspace() {
  const conv = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  const workspaceDir = path.join(getDataDir(), "workspaces", conv.id);
  // The conversation creation already creates the workspace
  const wsDir = path.join(tempDir, "workspaces", conv.id);
  // Write a test file
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "test.txt"), "hello world");
  fs.writeFileSync(path.join(wsDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  return { conv, wsDir };
}

function getDataDir() {
  return process.env.AGENTMELD_DATA_DIR!;
}

// Mock Next.js request
function mockRequest(path: string, read?: boolean): Request {
  const url = read
    ? `http://localhost/api/test?path=${encodeURIComponent(path)}&read=1`
    : `http://localhost/api/test?path=${encodeURIComponent(path)}`;
  return new Request(url);
}

describe("workspace file browser security", () => {
  it("rejects path traversal with ..", async () => {
    const { conv, wsDir } = setupWorkspace();
    const outsideFile = path.join(tempDir, "outside.txt");
    fs.writeFileSync(outsideFile, "secret");

    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("../outside.txt", true), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(400);
  });

  it("rejects absolute path", async () => {
    const { conv } = setupWorkspace();
    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("/etc/passwd", true), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(400);
  });

  it("rejects binary files", async () => {
    const { conv } = setupWorkspace();
    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("binary.bin", true), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(415);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Binary");
  });

  it("lists directory entries", async () => {
    const { conv } = setupWorkspace();
    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("."), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Array<{ name: string; type: string }> };
    expect(body.entries.some((e) => e.name === "test.txt")).toBe(true);
    expect(body.entries.some((e) => e.name === "binary.bin")).toBe(true);
  });

  it("reads text file content", async () => {
    const { conv } = setupWorkspace();
    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("test.txt", true), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string };
    expect(body.content).toContain("hello world");
  });

  it("returns 404 for non-existent file", async () => {
    const { conv } = setupWorkspace();
    const { GET } = await import("@/app/api/conversations/[id]/workspace-files/route");
    const res = await GET(mockRequest("nonexistent.txt", true), { params: Promise.resolve({ id: conv.id }) });
    expect(res.status).toBe(404);
  });
});
