import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const phase = process.argv[2] || 'before';
const dir = `.tmp-ui-artifacts/${phase}`;
await fs.mkdir(dir, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:3018', { waitUntil: 'domcontentloaded' });
await page.getByTitle('设置', { exact: true }).first().click();
await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
await page.screenshot({ path: `${dir}/settings.png` });
await page.getByRole('button', { name: '取消', exact: true }).first().click();
await page.getByRole('button', { name: 'Agents', exact: true }).click();
await page.getByTitle('新建 Agent', { exact: true }).click();
await page.getByRole('button', { name: /详细配置/ }).click();
await page.screenshot({ path: `${dir}/agent-basic.png` });
await page.getByRole(phase === 'before' ? 'button' : 'tab', { name: phase === 'before' ? '工具与提示词' : '工具权限' }).click();
await page.screenshot({ path: `${dir}/agent-tools.png` });
if (phase !== 'before') {
  await page.getByRole('tab', { name: '系统提示词', exact: true }).click();
  await page.screenshot({ path: `${dir}/agent-prompt.png` });
}
await page.close();
await browser.close();
console.log(`Saved ${phase} screenshots in ${dir}`);
