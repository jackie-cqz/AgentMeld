import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Paired disposable fixture server only. No LLM calls, auth reset, or real credentials.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
assert((await context.request.get(`${base}/api/bootstrap`)).ok(), 'Use a paired isolated fixture browser');
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const output = '.tmp-ui-artifacts/agent-create-avatar';
await fs.mkdir(output, { recursive: true });
const name = `UI Avatar Creation ${Date.now()}`;
const ids = [];
let providerId;
async function json(response) { assert(response.ok(), `HTTP ${response.status()}`); return response.json(); }
async function capture(name) {
  const dialog = page.locator('dialog[open]').last();
  const box = await dialog.boundingBox(); const size = page.viewportSize();
  assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `${name}: dialog bounds`);
  assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: no horizontal overflow`);
  const footer = await dialog.locator('footer').boundingBox();
  assert(Math.abs(footer.y + footer.height - box.y - box.height) <= 2, `${name}: pinned footer`);
  assert(await dialog.evaluate(node => node.contains(document.activeElement)), `${name}: focus contained`);
  await page.screenshot({ path: `${output}/${name}.png` });
}
async function pick(label) {
  await page.getByRole('button', { name: '选择头像', exact: true }).click();
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('button', { name: '完成', exact: true }).click();
}
const row = label => page.locator('.workspace-agent-row').filter({ has: page.getByText(label, { exact: true }) });
try {
  const { provider } = await json(await context.request.post(`${base}/api/model-providers`, { data: {
    name: `${name} Supplier`, protocol: 'chat-completions', presetId: null, baseUrl: 'https://fixture.invalid/v1', defaultModel: 'fixture-model', models: ['fixture-model'], apiKey: 'fixture-avatar-creation-key'
  } })); providerId = provider.id;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click();
  await page.getByTitle('新建 Agent', { exact: true }).click();
  for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${height}-${theme}-entry`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /快速创建/ }).click();
  await page.getByLabel('Agent 职责描述', { exact: true }).fill('负责研究资料和验收文档');
  await capture('quick-create');
  await page.getByRole('button', { name: '生成草稿并预览', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '选择头像', exact: true }).click();
  assert.equal(await page.getByRole('radio').count(), 17);
  await page.getByRole('radio', { name: '自动匹配头像', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert(await page.getByRole('radio', { name: '机器人', exact: true }).isChecked());
  await page.keyboard.press('ArrowLeft');
  assert(await page.getByRole('radio', { name: '自动匹配头像', exact: true }).isChecked());
  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 768, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${height}-${theme}-picker`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('radio', { name: '探索', exact: true }).check();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.agent-identity-preview [data-avatar-preset="av:globe"]').count(), 1);
  await capture('basic-selected-avatar');
  await page.getByRole('tab', { name: '模型与适配器', exact: true }).click();
  await page.getByRole('button', { name: '供应商 *', exact: true }).click();
  await page.getByRole('button', { name: `选择供应商 ${name} Supplier`, exact: true }).click();
  let failSave = true;
  await page.route('**/api/agents', route => {
    if (failSave && route.request().method() === 'POST') { failSave = false; return route.fulfill({ status: 503, json: { error: '头像保存重试测试' } }); }
    return route.continue();
  });
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.getByText('头像保存重试测试', { exact: true }).waitFor();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  let agent = (await json(await context.request.get(`${base}/api/agents`))).agents.find(agent => agent.name === name);
  assert(agent); ids.push(agent.id); assert.equal(agent.avatar, 'av:globe');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor(); await page.getByTitle('Agents', { exact: true }).click();
  assert.equal(await row(name).locator('[data-avatar-preset="av:globe"]').count(), 1);
  await row(name).getByTitle('编辑', { exact: true }).click();
  await pick('交付');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.locator('.agent-identity-preview [data-avatar-preset="av:rocket"]').count(), 1);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  agent = (await json(await context.request.get(`${base}/api/agents`))).agents.find(item => item.id === agent.id);
  assert.equal(agent.avatar, 'av:rocket');
  const { agent: legacy } = await json(await context.request.post(`${base}/api/agents`, { data: { name: `${name} Legacy`, avatar: 'AB', description: 'Legacy avatar preservation', adapterName: 'custom', modelProvider: `profile:${providerId}`, modelId: 'fixture-model', toolNames: [] } })); ids.push(legacy.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor(); await page.getByTitle('Agents', { exact: true }).click();
  await row(legacy.name).getByTitle('编辑', { exact: true }).click();
  await page.getByLabel('Agent 描述', { exact: true }).fill('An unrelated field update');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal((await json(await context.request.get(`${base}/api/agents`))).agents.find(agent => agent.id === legacy.id).avatar, 'AB');
  // A fresh detailed flow does not inherit the previous draft's avatar.
  await page.getByTitle('新建 Agent', { exact: true }).click();
  await page.getByRole('button', { name: /详细配置/ }).click();
  assert.equal(await page.locator('.agent-identity-preview [data-avatar-preset="auto"]').count(), 1);
  await pick('机器人');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, presets: 16, automaticOption: true, flows: ['quick', 'detailed', 'edit', 'legacy-preservation', 'save-retry', 'draft-reset'], viewportThemes: 6, errors }));
} finally {
  await page.close();
  for (const id of ids) await context.request.delete(`${base}/api/agents/${id}`);
  if (providerId) await context.request.delete(`${base}/api/model-providers`, { data: { id: providerId } });
  await browser.close();
}
