import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
const output = '.tmp-ui-artifacts/error-states';
await fs.mkdir(output, { recursive: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let reads = 0;
let allowRead = false;
let saves = 0;
try {
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') {
      reads++;
      if (!allowRead) await route.fulfill({ status: 503, json: { error: '设置暂时不可用，请重试。' } });
      else await route.continue();
      return;
    }
    saves++;
    await new Promise(resolve => setTimeout(resolve, 300));
    if (saves === 1) await route.fulfill({ status: 503, json: { error: '保存失败：' + '服务暂时不可用。'.repeat(30) } });
    else await route.fulfill({ json: { ok: true } });
  });
  await page.goto(process.env.UI_BASE_URL || 'http://127.0.0.1:3018', { waitUntil: 'domcontentloaded' });
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('alert').getByText('设置暂时不可用，请重试。', { exact: true }).waitFor();
  assert(await page.getByLabel('DeepSeek API Key').isDisabled());
  allowRead = true;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByLabel('DeepSeek API Key').fill('not-a-real-key-ui-test');
  await page.getByRole('button', { name: '保存设置', exact: true }).dblclick();
  await page.getByRole('alert').getByText(/保存失败/).waitFor();
  assert.equal(saves, 1, 'Double click must not duplicate a save');
  assert.equal(await page.getByLabel('DeepSeek API Key').inputValue(), 'not-a-real-key-ui-test');
  const footer = await page.locator('dialog[open] footer').boundingBox();
  assert(footer.y + footer.height <= 420, 'Long error cannot hide footer actions');
  await page.screenshot({ path: `${output}/retry-and-long-error.png` });
  await page.getByRole('button', { name: '关闭设置', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert(await page.locator('dialog[open]').evaluate(node => node.contains(document.activeElement)), 'Reverse Tab stays in modal');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(saves, 2);
  assert.deepEqual(errors, []);
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ result: 'passed', reads, saves, errors }, null, 2));
  console.log('Passed load retry, double-click protection, error/input preservation, short-window footer and reverse focus checks.');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally { await page.close(); await browser.close(); }
