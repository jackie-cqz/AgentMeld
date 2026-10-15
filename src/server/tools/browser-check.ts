import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { getDataDir } from "@/db/client";
import { safeWorkspacePath } from "@/server/tools/workspace-access";
import type { ToolDef } from "@/server/tools/types";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";

const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector: z.string().min(1).max(500) }),
  z.object({ action: z.literal("fill"), selector: z.string().min(1).max(500), value: z.string().max(2000) }),
  z.object({ action: z.literal("assert_visible"), selector: z.string().min(1).max(500) }),
  z.object({ action: z.literal("assert_text"), selector: z.string().min(1).max(500), value: z.string().max(2000) }),
  z.object({ action: z.literal("reload") }),
]);
const schema = z.object({ path: z.string().default("dist"), viewport: z.enum(["desktop", "mobile"]).default("desktop"), steps: z.array(stepSchema).max(20).default([]) });
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon" };
let activeChecks = 0;

export function browserScreenshotPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid screenshot id.");
  return path.join(getDataDir(), "browser-checks", `${id}.png`);
}

function saveScreenshot(buffer: Buffer) {
  if (buffer.length > 5 * 1024 * 1024) throw new Error("Screenshot exceeds 5 MiB.");
  const id = randomUUID(); const file = browserScreenshotPath(id); const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // This private, server-owned directory never contains workspace/source files.
  const existing = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.png$/.test(name)).map(name => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => a.time - b.time);
  for (const old of existing.slice(0, Math.max(0, existing.length - 99))) fs.unlinkSync(path.join(dir, old.name));
  fs.writeFileSync(file, buffer, { flag: "wx" });
  return `/api/browser-checks/${id}`;
}

export const browserCheckTool: ToolDef = {
  capabilities: TOOL_CAPABILITIES.browser_check,
  name: "browser_check",
  description: "Verify a built, static workspace web app in a fresh isolated headless Chromium (no user cookies). path must contain index.html. Optional click/fill/assert_visible/assert_text/reload steps, max 20; desktop/mobile screenshots, console errors and failed requests are returned. All external network is blocked: build/bundle dependencies locally first. No arbitrary URLs, shell or browser JavaScript. Checks only the specified interactions, not full app correctness.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Static build directory inside this workspace, default dist." },
      viewport: { type: "string", enum: ["desktop", "mobile"] },
      steps: { type: "array", maxItems: 20, items: { type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["click", "fill", "assert_visible", "assert_text", "reload"] }, selector: { type: "string" }, value: { type: "string" }
      } } }
    }
  },
  async handler(args, ctx) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { ok: false, error: `Invalid browser check arguments: ${parsed.error.message}` };
    if (activeChecks >= 2) return { ok: false, error: "Browser check concurrency limit reached. Try again when a check finishes." };
    activeChecks++;
    let browser: Browser | undefined; let server: http.Server | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { void browser?.close().catch(() => {}); server?.closeAllConnections(); };
    try {
      ctx.abortSignal.throwIfAborted();
      const root = safeWorkspacePath(ctx.workspacePath, parsed.data.path);
      if (!fs.statSync(root).isDirectory()) throw new Error("path must be a static app directory.");
      safeWorkspacePath(root, "index.html");
      server = http.createServer((req, res) => {
        try {
          if (!["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
          const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
          const file = safeWorkspacePath(root, pathname === "/" ? "index.html" : `.${pathname}`);
          const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("Not a readable static file.");
          res.writeHead(200, { "Content-Type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'" });
          if (req.method === "HEAD") res.end(); else fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
        } catch { res.writeHead(404).end("Static file not found."); }
      });
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const executable = process.env.AGENTMELD_BROWSER_EXECUTABLE_PATH || (process.platform === "win32" && fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe") ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
      browser = await chromium.launch({ headless: true, executablePath: executable, timeout: 15000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, args: ["--disable-background-networking", "--disable-extensions", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
      timer = setTimeout(cancel, 30000); ctx.abortSignal.addEventListener("abort", cancel, { once: true });
      ctx.abortSignal.throwIfAborted();
      const context = await browser.newContext({ viewport: parsed.data.viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: "block", acceptDownloads: false });
      const blockedRequests: string[] = []; const errors: string[] = []; const failedRequests: string[] = [];
      await context.route("**/*", route => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        if (blockedRequests.length < 30) blockedRequests.push(url.slice(0, 1000));
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", socket => socket.close());
      const page = await context.newPage(); page.setDefaultTimeout(3000); page.setDefaultNavigationTimeout(10000);
      context.on("page", popup => { if (popup !== page) void popup.close(); });
      page.on("pageerror", error => { if (errors.length < 30) errors.push(error.message.slice(0, 1000)); });
      page.on("console", message => { if (message.type() === "error" && errors.length < 30) errors.push(message.text().slice(0, 1000)); });
      page.on("requestfailed", request => { if (failedRequests.length < 30 && !request.url().endsWith("/favicon.ico")) failedRequests.push(request.url().slice(0, 1000)); });
      page.on("response", response => { if (response.status() >= 400 && failedRequests.length < 30 && !response.url().endsWith("/favicon.ico")) failedRequests.push(`${response.status()} ${response.url()}`.slice(0, 1000)); });
      await page.goto(origin, { waitUntil: "load" });
      const results: Array<{ action: string; selector?: string; passed: boolean; error?: string }> = [];
      for (const step of parsed.data.steps) {
        ctx.abortSignal.throwIfAborted();
        try {
          if (step.action === "reload") await page.reload({ waitUntil: "load" });
          else {
            const locator = page.locator(step.selector);
            if (step.action === "click") await locator.click();
            if (step.action === "fill") await locator.fill(step.value);
            if (step.action === "assert_visible") await locator.waitFor({ state: "visible" });
            if (step.action === "assert_text") await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent?.includes(value) === true, { selector: step.selector, value: step.value }, { timeout: 3000 });
          }
          results.push({ ...step, passed: true });
        } catch (error) { results.push({ action: step.action, selector: "selector" in step ? step.selector : undefined, passed: false, error: (error instanceof Error ? error.message : "Interaction failed.").slice(0, 500) }); break; }
      }
      const screenshotUrl = saveScreenshot(await page.screenshot({ type: "png", fullPage: false, timeout: 5000 }));
      const layout = await page.evaluate(() => ({ horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, bodyElements: document.body.querySelectorAll("*").length }));
      const passed = results.every(result => result.passed) && !errors.length && !failedRequests.length && !blockedRequests.length && !layout.horizontalOverflow && layout.bodyElements > 0;
      return { ok: true, value: { passed, sourcePath: parsed.data.path, viewport: parsed.data.viewport, title: await page.title(), results, errors, failedRequests, blockedRequests, screenshotUrl, ...layout, checkedAt: Date.now(), untrusted: true } };
    } catch (error) { return { ok: false, error: `Browser check failed: ${error instanceof Error ? error.message : "unknown error"}. Install Chromium with pnpm exec playwright install chromium, or set AGENTMELD_BROWSER_EXECUTABLE_PATH to an installed browser.` }; }
    finally { activeChecks--; if (timer) clearTimeout(timer); ctx.abortSignal.removeEventListener("abort", cancel); await browser?.close().catch(() => {}); server?.closeAllConnections(); await new Promise<void>(resolve => { if (server?.listening) server.close(() => resolve()); else resolve(); }); }
  }
};
