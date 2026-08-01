import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { chromium } from "playwright";


const cases = JSON.parse(fs.readFileSync(".benchmark/hidden/cases.json", "utf8"));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-html-filter-"));
const browser = await chromium.launch({ headless: true });

try {
  for (let index = 0; index < cases.malicious.length; index += 1) {
    const target = path.join(tempRoot, `case-${index}.html`);
    fs.writeFileSync(target, cases.malicious[index], "utf8");
    const result = spawnSync(process.env.PYTHON ?? "python", ["filter.py", target], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`filter.py failed for browser case ${index}: ${result.stderr}`);
    }

    const output = fs.readFileSync(target, "utf8");
    const page = await browser.newPage();
    let dialogTriggered = false;
    page.on("dialog", async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });
    await page.setContent(output, { waitUntil: "load" });
    await page.waitForTimeout(100);
    await page.close();
    if (dialogTriggered) throw new Error(`filtered browser case ${index} executed a dialog`);
  }
} finally {
  await browser.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`verified ${cases.malicious.length} filtered attack samples in Chromium`);
