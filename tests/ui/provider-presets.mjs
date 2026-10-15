import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Run only against the isolated UI fixture server. Keys are synthetic; LLM calls are mocked.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3018';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const output = '.tmp-ui-artifacts/provider-presets';
await fs.mkdir(output, { recursive: true });
const page = await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const suffix = Date.now();
const name = `UI Preset GLM ${suffix}`;
const agentName = `UI Preset Agent ${suffix}`;
const errors = [];
const testCalls = [];
let providerId;
let agentId;
page.on('pageerror', error => errors.push(error.message));
async function openSettings() {
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('heading', { name: '模型供应商', exact: true }).waitFor();
}
async function capture(name) {
  const modal = page.locator('dialog[open]').last();
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: modal bounds`);
  assert(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: no horizontal overflow`);
  const footer = await modal.locator('footer').boundingBox();
  assert(footer.y + footer.height <= viewport.height + 1, `${name}: pinned footer`);
  assert(await modal.evaluate(node => node.contains(document.activeElement)), `${name}: focus in modal`);
  await page.screenshot({ path: `${output}/${name}.png` });
}
try {
  assert((await page.request.get(`${base}/api/bootstrap`)).ok(), 'Use a paired isolated fixture browser');
  await page.route('**/api/settings/test-connection', route => { testCalls.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, latencyMs: 23 } }); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await openSettings();
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  assert(await page.locator('.provider-catalog > button').count() >= 29);
  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 768, 'dark'], [768, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${theme}-catalog`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.getByRole('button', { name: 'Coding Plan', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '添加 Kimi / Moonshot 国内', exact: true }).count(), 0, 'Protocol-incompatible Kimi coding route is not masquerading as Chat Completions');
  await page.getByLabel('搜索供应商').fill('GLM');
  await page.getByRole('button', { name: '添加 智谱 GLM Coding Plan 国内', exact: true }).click();
  assert.equal(await page.getByLabel('供应商 API 地址').inputValue(), 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(await page.getByLabel('默认模型', { exact: true }).inputValue(), 'glm-5.2');
  await page.getByLabel('配置名称', { exact: true }).fill(name);
  await page.getByLabel('供应商 API Key', { exact: true }).fill('fixture-profile-preset-key');
  await page.getByLabel('供应商 API 地址').fill('file:///invalid');
  assert(await page.getByRole('button', { name: '保存供应商', exact: true }).isDisabled());
  await page.getByLabel('供应商 API 地址').fill('https://fixture.invalid/api/coding/paas/v4');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接成功，23 ms', { exact: true }).waitFor();
  assert.deepEqual(testCalls[0], { provider: 'openai-compatible', presetId: 'glm-coding-plan-cn', apiBaseUrl: 'https://fixture.invalid/api/coding/paas/v4', modelId: 'glm-5.2', apiKey: 'fixture-profile-preset-key' });
  await page.getByLabel('默认模型', { exact: true }).fill('glm-4.7');
  assert.equal(await page.getByText('连接成功，23 ms', { exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('配置名称').inputValue(), name);
  await page.route('**/api/model-providers', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await page.unroute('**/api/model-providers');
    return route.fulfill({ status: 503, json: { error: '预设保存重试测试' } });
  });
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await page.getByText('预设保存重试测试', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('供应商 API Key').inputValue(), 'fixture-profile-preset-key');
  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 768, 'dark'], [768, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${theme}-editor`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).waitFor();
  let profiles = await (await page.request.get(`${base}/api/model-providers`)).json();
  const profile = profiles.providers.find(item => item.name === name);
  assert(profile);
  providerId = profile.id;
  assert(!JSON.stringify(profiles).includes('fixture-profile-preset-key'));
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).click();
  assert.equal(await page.getByLabel('供应商 API Key').inputValue(), '', 'Stored key is write-only');
  await page.getByLabel('默认模型', { exact: true }).fill('glm-5.1');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByTitle('Agents', { exact: true }).click();
  await page.getByTitle('新建 Agent', { exact: true }).click();
  await page.getByRole('button', { name: /详细配置/ }).click();
  await page.getByLabel('名称', { exact: true }).fill(agentName);
  await page.getByLabel('Agent 描述', { exact: true }).fill('Isolated provider preset integration test');
  await page.getByRole('tab', { name: '模型与适配器', exact: true }).click();
  await page.getByRole('button', { name: '供应商 *', exact: true }).click();
  await page.getByRole('button', { name: `选择供应商 ${name}`, exact: true }).click();
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('glm-5.1'));
  await capture('desktop-agent-profile-selection');
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  const agents = await (await page.request.get(`${base}/api/agents`)).json();
  const agent = agents.agents.find(item => item.name === agentName);
  assert(agent);
  agentId = agent.id;
  assert.equal(agent.modelProvider, `profile:${providerId}`);
  assert.equal(agent.modelId, 'glm-5.1');
  assert.equal(agent.apiKey, null);
  assert.equal(agent.apiBaseUrl, null);
  await openSettings();
  await page.getByRole('button', { name: `配置 ${name}`, exact: true }).waitFor();
  assert(await page.getByRole('button', { name: `移除 ${name}`, exact: true }).isDisabled());
  assert.equal((await page.request.delete(`${base}/api/model-providers`, { data: { id: providerId } })).status(), 409);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.request.delete(`${base}/api/agents/${agentId}`);
  agentId = undefined;
  await openSettings();
  await page.getByRole('button', { name: `移除 ${name}`, exact: true }).click();
  await page.getByRole('dialog', { name: '移除供应商？', exact: true }).getByRole('button', { name: '移除供应商', exact: true }).click();
  await page.getByText('供应商已移除。', { exact: true }).waitFor();
  profiles = await (await page.request.get(`${base}/api/model-providers`)).json();
  assert(!profiles.providers.some(item => item.id === providerId));
  providerId = undefined;
  assert.deepEqual(errors, []);
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ passed: true, viewports: 6, checks: ['catalog-search-filter', 'plan-endpoint-defaults', 'editable-models', 'write-only-secret', 'retry-preserves-draft', 'unsaved-guard', 'agent-reference', 'delete-protection', 'delete-roundtrip'], errors }, null, 2));
  console.log('Provider presets: catalog, responsive editors, persistence, Agent selection, deletion guard passed.');
} finally {
  if (agentId) await page.request.delete(`${base}/api/agents/${agentId}`);
  if (providerId) await page.request.delete(`${base}/api/model-providers`, { data: { id: providerId } });
  await page.close();
  await browser.close();
}
