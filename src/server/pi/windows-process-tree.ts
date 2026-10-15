import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PiRuntimeError } from "./process";

const exec = promisify(execFile);
export interface ProcessReceipt { pid: number; parent: number; born: string }

export function descendantReceipts(table: ProcessReceipt[], root: number): ProcessReceipt[] {
  const owned = new Set([root]);
  const receipts: ProcessReceipt[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) {
      if (!owned.has(row.pid) && owned.has(row.parent)) {
        if (!row.born) throw new PiRuntimeError("Cannot identify the native process owner.", "cleanup_failed");
        owned.add(row.pid); receipts.push(row); changed = true;
      }
    }
  }
  return receipts;
}

async function processTable(): Promise<ProcessReceipt[]> {
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const script = "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; born=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } } | ConvertTo-Json -Compress";
  const { stdout } = await exec(path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(row => {
    if (!row || typeof row !== "object" || !("pid" in row) || !("parent" in row) || !("born" in row) || !Number.isInteger(row.pid) || !Number.isInteger(row.parent) || typeof row.born !== "string") throw new PiRuntimeError("Invalid Windows process ownership response.", "cleanup_failed");
    return row as ProcessReceipt;
  });
}

export async function captureWindowsDescendants(root: number): Promise<ProcessReceipt[]> {
  return descendantReceipts(await processTable(), root);
}

/** Only birth-time-matched descendants of our own Pi child may be terminated. */
export async function stopWindowsDescendants(receipts: ProcessReceipt[]): Promise<void> {
  if (!receipts.length) return;
  const current = await processTable();
  const remaining = receipts.filter(receipt => current.some(row => row.pid === receipt.pid && row.born === receipt.born));
  const system = process.env.SystemRoot ?? "C:\\Windows";
  for (const receipt of remaining.reverse()) {
    try { await exec(path.join(system, "System32", "taskkill.exe"), ["/pid", String(receipt.pid), "/t", "/f"], { windowsHide: true, timeout: 10000 }); }
    catch { /* It may have exited since the ownership check. Verify below. */ }
  }
  for (let n = 0; n < 50; n++) {
    if (remaining.every(receipt => !alive(receipt.pid))) return;
    await delay(100);
  }
  const final = await processTable();
  if (remaining.some(receipt => final.some(row => row.pid === receipt.pid && row.born === receipt.born))) {
    throw new PiRuntimeError("A native command descendant is still alive; workspace remains locked.", "cleanup_failed");
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}
