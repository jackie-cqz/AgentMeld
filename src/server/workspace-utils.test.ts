import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathWithinWorkspace,
  isPathWithin,
  resolveSafePath,
  scanWorkspaceUsage,
  getEffectiveCwd,
  SANDBOX_MAX_BYTES,
  SANDBOX_MAX_FILES
} from "@/server/workspace-utils";
import type { Workspace } from "@/shared/types";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-ws-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sandboxWorkspace(rootPath: string): Workspace {
  return {
    id: "ws_test",
    conversationId: "conv_test",
    mode: "sandbox",
    rootPath,
    boundPath: null,
    createdAt: 1,
    updatedAt: 1
  };
}

describe("workspace-utils", () => {
  describe("getEffectiveCwd", () => {
    it("returns rootPath for sandbox mode", () => {
      const ws = sandboxWorkspace("/tmp/ws");
      expect(getEffectiveCwd(ws)).toBe("/tmp/ws");
    });

    it("returns boundPath for local mode", () => {
      const ws: Workspace = {
        ...sandboxWorkspace("/tmp/ws"),
        mode: "local",
        boundPath: "/home/user/project"
      };
      expect(getEffectiveCwd(ws)).toBe("/home/user/project");
    });
  });

  describe("isPathWithin", () => {
    it("returns true for a child path", () => {
      expect(isPathWithin("/tmp/ws/src/file.ts", "/tmp/ws")).toBe(true);
    });

    it("returns true for the same path", () => {
      expect(isPathWithin("/tmp/ws", "/tmp/ws")).toBe(true);
    });

    it("returns false for a path outside", () => {
      expect(isPathWithin("/etc/passwd", "/tmp/ws")).toBe(false);
    });

    it("returns false for path traversal attempts", () => {
      expect(isPathWithin("/tmp/ws/../../etc/passwd", "/tmp/ws")).toBe(false);
    });
  });

  describe("resolveSafePath", () => {
    it("resolves a relative path within workspace", () => {
      const resolved = resolveSafePath(tempDir, "src/file.ts");
      expect(resolved).toBe(path.join(tempDir, "src/file.ts"));
    });

    it("rejects path traversal outside workspace", () => {
      expect(() => resolveSafePath(tempDir, "../../etc/passwd")).toThrow("outside workspace");
    });

    it("resolves '.' to the workspace root", () => {
      const resolved = resolveSafePath(tempDir, ".");
      expect(resolved).toBe(tempDir);
    });
  });

  describe("assertPathWithinWorkspace", () => {
    it("returns resolved path for valid input", () => {
      const resolved = assertPathWithinWorkspace(tempDir, "subdir/file.txt");
      expect(resolved).toBe(path.join(tempDir, "subdir/file.txt"));
    });

    it("throws for path escaping workspace", () => {
      expect(() => assertPathWithinWorkspace(tempDir, "../../../etc/hosts")).toThrow();
    });
  });

  describe("scanWorkspaceUsage", () => {
    it("counts files and bytes in a directory", () => {
      fs.writeFileSync(path.join(tempDir, "a.txt"), "hello");
      fs.writeFileSync(path.join(tempDir, "b.txt"), "world!!");

      const usage = scanWorkspaceUsage(tempDir);
      expect(usage.totalFiles).toBe(2);
      expect(usage.totalBytes).toBeGreaterThan(0);
    });

    it("returns zero for an empty directory", () => {
      const usage = scanWorkspaceUsage(tempDir);
      expect(usage.totalFiles).toBe(0);
      expect(usage.totalBytes).toBe(0);
    });

    it("traverses subdirectories", () => {
      const sub = path.join(tempDir, "sub");
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(tempDir, "root.txt"), "x");
      fs.writeFileSync(path.join(sub, "nested.txt"), "yy");

      const usage = scanWorkspaceUsage(tempDir);
      expect(usage.totalFiles).toBe(2);
    });

    it("does not infinite-loop on symlink cycles", () => {
      // Create a directory and a symlink pointing to parent
      const sub = path.join(tempDir, "sub");
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, "file.txt"), "data");

      // Only test symlink on POSIX; Windows requires admin for symlinks
      if (process.platform !== "win32") {
        fs.symlinkSync(tempDir, path.join(sub, "loop"), "dir");
        // Should not throw or hang
        const usage = scanWorkspaceUsage(tempDir);
        expect(usage.totalFiles).toBeGreaterThan(0);
      }
    });
  });
});
