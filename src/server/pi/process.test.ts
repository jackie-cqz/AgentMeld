import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiProcess } from "./process";

let folder: string;
const children: PiProcess[] = [];
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-contract-")); });
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.close()));
  fs.rmSync(folder, { recursive: true, force: true });
});
function processFixture(source: string): PiProcess {
  const file = path.join(folder, "fixture.cjs");
  fs.writeFileSync(file, source);
  const child = new PiProcess({ cliPath: file, cwd: folder, args: [], env: { ...process.env }, requestTimeoutMs: 1000, shutdownTimeoutMs: 100 });
  children.push(child);
  return child;
}

describe("Pi subprocess failure contract", () => {
  it("rejects corrupt stdout and confirms exit even if the process ignores stdin EOF", async () => {
    const child = processFixture('process.stdout.write("broken json\\n"); process.stdin.resume(); setInterval(()=>{},1000);');
    await expect(child.request("get_state")).rejects.toMatchObject({ category: "protocol" });
    await child.close();
    expect(() => process.kill(child.pid!, 0)).toThrow();
    await child.close();
  }, 15000);
  it("does not treat an early process exit as successful request completion", async () => {
    const child = processFixture("process.exit(2);");
    await expect(child.request("get_state")).rejects.toMatchObject({ category: "process_exit" });
  }, 15000);
  it("bounds an unacknowledged command and tears down its owner", async () => {
    const child = processFixture("process.stdin.resume(); setInterval(()=>{},1000);");
    await expect(child.request("get_state")).rejects.toMatchObject({ category: "timeout" });
    await child.close();
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }, 15000);
});
