import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { browserCheckTool, browserScreenshotPath } from "@/server/tools/browser-check";
import type { ToolContext } from "@/server/tools/types";

let root: string; let ctx: ToolContext;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-browser-check-"));
  ctx = { workspacePath: root, conversationId: "conv_browser", agentId: "ag_browser", runId: "run_browser", abortSignal: new AbortController().signal };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const browserAvailable = fs.existsSync(process.env.AGENTMELD_BROWSER_EXECUTABLE_PATH || chromium.executablePath()) || (process.platform === "win32" && fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe"));

describe("isolated browser verification", () => {
  it("rejects arbitrary URLs, escaped roots and malformed interactions", async () => {
    for (const args of [{ path: "http://127.0.0.1:3018" }, { path: ".." }, { steps: [{ action: "evaluate", value: "alert(1)" }] }]) expect((await browserCheckTool.handler(args, ctx)).ok).toBe(false);
    expect(() => browserScreenshotPath("../../.env")).toThrow();
  });
  it.runIf(browserAvailable)("verifies add/reload persistence on desktop and mobile with screenshots", async () => {
    fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Checklist</title></head><body><h1>Checklist</h1><input id="task" aria-label="Task"><button id="add">Add</button><ul id="items"></ul><script>
      const items=document.querySelector('#items'); const tasks=JSON.parse(localStorage.getItem('tasks')||'[]');
      const render=()=>{items.textContent='';tasks.forEach(text=>{const item=document.createElement('li');item.textContent=text;items.append(item)})};render();
      document.querySelector('#add').onclick=()=>{tasks.push(document.querySelector('#task').value);localStorage.setItem('tasks',JSON.stringify(tasks));render()};
      </script></body></html>`);
    for (const viewport of ["desktop", "mobile"]) {
      const result = await browserCheckTool.handler({ path: ".", viewport, steps: [{ action: "fill", selector: "#task", value: "Ship toolkit" }, { action: "click", selector: "#add" }, { action: "assert_text", selector: "#items", value: "Ship toolkit" }, { action: "reload" }, { action: "assert_text", selector: "#items", value: "Ship toolkit" }] }, ctx);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const value = result.value as { passed: boolean; screenshotUrl: string; errors: string[]; results: unknown[] };
      expect(value).toMatchObject({ passed: true, errors: [] }); expect(value.results).toHaveLength(5);
      const file = browserScreenshotPath(value.screenshotUrl.split("/").at(-1)!); const png = fs.readFileSync(file);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); expect(png.length).toBeGreaterThan(1000);
    }
  }, 60000);
  it.runIf(browserAvailable)("blocks external/private network, captures JS errors and failed assertions", async () => {
    fs.writeFileSync(path.join(root, "index.html"), '<body><h1>Broken</h1><img src="http://127.0.0.1:9/private"><script>console.error("fixture-console-error");throw new Error("fixture-page-error")</script></body>');
    const result = await browserCheckTool.handler({ path: ".", steps: [{ action: "assert_text", selector: "h1", value: "Expected text" }] }, ctx);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ passed: false, blockedRequests: ["http://127.0.0.1:9/private"], errors: expect.arrayContaining(["fixture-console-error", "fixture-page-error"]), results: [expect.objectContaining({ passed: false })] });
  }, 30000);
});
