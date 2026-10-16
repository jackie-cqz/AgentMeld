import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Frontend can use the hot-reloading preview, but every API call is sent to
// the disposable fixture server. Never pair or mutate the shared preview.
const api = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
const frontend = process.env.UI_FRONTEND_URL || api;
assert.notEqual(new URL(api).port, '3018', 'Use an isolated API fixture');
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
assert((await context.request.get(`${api}/api/bootstrap`)).ok(), 'Fixture browser must already be paired');
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const source = new URL(route.request().url());
  if (source.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture stream\nretry: 60000\n\n' });
  const response = await route.fetch({ url: `${api}${source.pathname}${source.search}` });
  await route.fulfill({ response });
});
const output = '.tmp-ui-artifacts/agent-editor-tabs'; await fs.mkdir(output, { recursive: true });
const suffix = Date.now(); const name = `UI Separate Tabs ${suffix}`; const supplier = `UI Tabs Supplier ${suffix}`;
let providerId; let agentId; let screenshots = 0;
const tabs = ['基本信息', '模型与适配器', '运行时工具', '系统提示词'];
const prompt = 'You are a focused reviewer. Read evidence, preserve user changes, and report remaining risks.';
async function json(response) { assert(response.ok(), `${response.status()}: ${await response.text()}`); return response.json(); }
async function tab(label) {
  await page.getByRole('tab', { name: label, exact: true }).click();
  assert(await page.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected') === 'true');
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  assert(await page.getByRole('tabpanel', { name: label, exact: true }).isVisible());
}
async function capture(file) {
  const dialog = page.locator('dialog[open]').last(); const bounds = await dialog.boundingBox(); const viewport = page.viewportSize();
  assert(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'Dialog fits viewport');
  assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'No dialog overflow');
  const footer = await dialog.locator('footer').boundingBox(); assert(Math.abs(footer.y + footer.height - bounds.y - bounds.height) <= 2, 'Pinned footer');
  await page.screenshot({ path: `${output}/${file}.png` }); screenshots++;
  const nav = await page.getByRole('tablist', { name: 'Agent 配置', exact: true }).boundingBox();
  for (const label of tabs) { const button = page.getByRole('tab', { name: label, exact: true }); const box = await button.boundingBox(); assert(box.x >= nav.x - 1 && box.x + box.width <= nav.x + nav.width + 1, JSON.stringify({ file, label, nav, box, font: await button.evaluate(node => getComputedStyle(node).fontSize) })); }
}
async function layoutChecks(mode) {
  for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height }); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await tab('运行时工具'); assert.equal(await page.getByRole('textbox', { name: '系统提示词', exact: true }).count(), 0);
    await capture(`${mode}-${width}-${height}-${theme}-tools`);
    await page.getByText('运行时可用的工具', { exact: true }).scrollIntoViewIfNeeded();
    await tab('系统提示词'); assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '系统提示词', exact: true }).inputValue(), prompt);
    assert.equal(await page.locator('dialog[open] [data-ui-scroll]').evaluate(node => node.scrollTop), 0);
    await capture(`${mode}-${width}-${height}-${theme}-prompt`);
  }
}
try {
  const { provider } = await json(await context.request.post(`${api}/api/model-providers`, { data: { name: supplier, protocol: 'chat-completions', presetId: null, baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture-model', models: ['fixture-model'], apiKey: 'fixture-tabs-key' } })); providerId = provider.id;
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(frontend, { waitUntil: 'domcontentloaded' }); await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click(); await page.getByTitle('新建 Agent', { exact: true }).click(); await page.getByRole('button', { name: /详细配置/ }).click();
  assert.equal(await page.getByRole('tab').count(), 4);
  await page.getByLabel('名称', { exact: true }).fill(name); await page.getByLabel('Agent 描述', { exact: true }).fill('Separate permissions and prompt fixture');
  await tab('模型与适配器'); await page.getByRole('button', { name: '供应商 *', exact: true }).click(); await page.getByRole('button', { name: `选择供应商 ${supplier}`, exact: true }).click();
  await tab('运行时工具');
  assert(await page.getByText('运行时可用的工具', { exact: true }).isVisible());
  assert.equal(await page.getByRole('checkbox').count(), 0, 'Agent editor offers no tool choice');
  assert.equal(await page.getByLabel('工具记录预设', { exact: true }).count(), 0, 'No tool record picker remains');
  await tab('系统提示词'); await page.getByRole('textbox', { name: '系统提示词', exact: true }).fill(prompt);
  await tab('基本信息'); await page.getByRole('tab', { name: '基本信息', exact: true }).focus(); await page.keyboard.press('End');
  assert(await page.getByRole('tab', { name: '系统提示词', exact: true }).evaluate(node => node === document.activeElement && node.getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('ArrowLeft'); assert(await page.getByRole('tab', { name: '运行时工具', exact: true }).evaluate(node => node === document.activeElement));
  await layoutChecks('create');
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  let bootstrap = await json(await context.request.get(`${api}/api/bootstrap`)); const created = bootstrap.agents.find(item => item.name === name); assert(created); agentId = created.id;
  assert.equal(created.systemPrompt, prompt); assert(created.toolNames.length > 0, 'Server default record is seeded on create');
  await page.setViewportSize({ width: 1440, height: 900 });
  const row = page.locator('.workspace-agent-row').filter({ has: page.getByText(name, { exact: true }) }); await row.getByTitle('编辑', { exact: true }).click();
  await layoutChecks('edit');
  await tab('运行时工具'); assert.equal(await page.getByRole('checkbox').count(), 0, 'Editing offers no tool choice');
  await tab('系统提示词'); await page.getByRole('textbox', { name: '系统提示词', exact: true }).fill(`${prompt}\nUse the current task context only.`);
  await tab('运行时工具'); assert(await page.getByText('运行时可用的工具', { exact: true }).isVisible()); await tab('系统提示词');
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  bootstrap = await json(await context.request.get(`${api}/api/bootstrap`)); const edited = bootstrap.agents.find(item => item.id === agentId);
  assert.equal(edited.systemPrompt, `${prompt}\nUse the current task context only.`);
  assert.deepEqual(edited.toolNames, created.toolNames, 'Saving the editor leaves the stored record untouched');
  await row.getByTitle('编辑', { exact: true }).click(); await tab('系统提示词'); await page.getByRole('textbox', { name: '系统提示词', exact: true }).fill('Unsaved draft');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await page.getByRole('textbox', { name: '系统提示词', exact: true }).inputValue(), 'Unsaved draft');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByTitle('新建 Agent', { exact: true }).click(); await page.getByRole('button', { name: /快速创建/ }).click();
  await page.getByLabel('Agent 职责描述', { exact: true }).fill('研究资料和验收记录'); await page.getByRole('button', { name: '生成草稿并预览', exact: true }).click();
  await tab('系统提示词'); assert((await page.getByRole('textbox', { name: '系统提示词', exact: true }).inputValue()).includes('研究资料和验收记录'));
  await tab('运行时工具'); assert.equal(await page.getByRole('checkbox').count(), 0, 'Quick draft offers no tool choice');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, modes: ['create', 'edit', 'quick-draft'], screenshots, checks: ['independent-panels', 'draft-retention', 'persistence', 'keyboard', 'unsaved-confirmation', 'responsive-footer'], errors }));
} finally {
  if (!agentId) { const bootstrap = await (await context.request.get(`${api}/api/bootstrap`)).json(); agentId = bootstrap.agents?.find(item => item.name === name)?.id; }
  if (agentId) await context.request.delete(`${api}/api/agents/${agentId}`);
  if (providerId) await context.request.delete(`${api}/api/model-providers/${providerId}`);
  await page.close(); await browser.close();
}
