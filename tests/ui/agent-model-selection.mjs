import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Use a separate, disposable server/database. Never pair the user's shared preview.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
assert(!new URL(base).port || new URL(base).port !== '3018', 'Do not pair the shared preview server');
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
const output = '.tmp-ui-artifacts/agent-model-selection';
await fs.mkdir(output, { recursive: true });
const status = await (await context.request.get(`${base}/api/auth/status`)).json();
if (!status.paired) {
  const { code } = await (await context.request.post(`${base}/api/auth/pair/code`)).json();
  assert((await context.request.post(`${base}/api/auth/pair`, { data: { code } })).ok());
}
assert((await context.request.get(`${base}/api/bootstrap`)).ok(), 'Fixture browser needs its own valid session');
const suffix = Date.now();
const profileName = `UI Model Supplier ${suffix}`;
const agentName = `UI Model Agent ${suffix}`;
const profiles = [];
const agentIds = [];
const errors = [];
const writes = [];
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
page.on('pageerror', error => errors.push(error.message));
async function json(response) { assert(response.ok(), `HTTP ${response.status()}: ${await response.text()}`); return response.json(); }
async function openModelTab() { await page.getByRole('tab', { name: '模型与适配器', exact: true }).click(); }
async function chooseSupplier(name) {
  await page.getByRole('button', { name: '供应商 *', exact: true }).click();
  await page.getByRole('button', { name: `选择供应商 ${name}`, exact: true }).click();
}
async function editAgent() {
  await page.locator('.workspace-agent-row').filter({ has: page.getByText(agentName, { exact: true }) }).getByTitle('编辑', { exact: true }).click();
  await openModelTab();
}
async function capture(name) {
  const modal = page.locator('dialog[open]').last();
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: modal bounds`);
  assert(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: horizontal overflow`);
  const footer = await modal.locator(':scope > footer').boundingBox();
  assert(footer.y + footer.height <= viewport.height + 1, `${name}: footer visible`);
  assert(Math.abs(footer.y + footer.height - box.y - box.height) <= 2, `${name}: footer pinned to dialog bottom`);
  assert(await modal.evaluate(node => node.contains(document.activeElement)), `${name}: focus inside`);
  await page.screenshot({ path: `${output}/${name}.png` });
}
try {
  for (const [name, model] of [[profileName, 'glm-default'], [`${profileName} Other`, 'other-default']]) {
    const { provider } = await json(await context.request.post(`${base}/api/model-providers`, { data: {
      name, protocol: 'chat-completions', presetId: null, baseUrl: 'https://fixture.invalid/api/coding/paas/v4', defaultModel: model,
      models: [model, 'glm-fast', 'model-with-a-long-identifier-for-narrow-screen-layout-verification'], apiKey: 'fixture-agent-model-global-key'
    } }));
    profiles.push(provider);
  }
  let failLoad = false;
  let failSave = false;
  let hideProfiles = false;
  await page.route('**/api/model-providers', route => {
    if (failLoad && route.request().method() === 'GET') { failLoad = false; return route.fulfill({ status: 503, json: { error: '供应商暂时不可用' } }); }
    if (hideProfiles && route.request().method() === 'GET') return route.fulfill({ json: { providers: [], environmentPresets: [] } });
    return route.continue();
  });
  await page.route('**/api/agents', route => {
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      if (failSave) { failSave = false; return route.fulfill({ status: 503, json: { error: 'Agent 保存重试测试' } }); }
    }
    return route.continue();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click();
  await page.getByTitle('新建 Agent', { exact: true }).click();
  failLoad = true;
  await page.getByRole('button', { name: /详细配置/ }).click();
  await page.getByLabel('名称', { exact: true }).fill(agentName);
  await page.getByLabel('Agent 描述', { exact: true }).fill('Isolated model selection persistence test');
  await openModelTab();
  await page.getByText('供应商暂时不可用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await chooseSupplier(profileName);
  assert(await page.getByRole('button', { name: '模型 *', exact: true }).innerText().then(text => text.includes('glm-default')));
  assert.equal(await page.getByLabel('Agent API Key', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '模型 *', exact: true }).click();
  await page.getByLabel('搜索模型', { exact: true }).fill('glm-fast');
  assert.equal(await page.locator('.agent-model-options > button').count(), 1);
  await page.getByRole('button', { name: '选择模型 glm-fast', exact: true }).click();
  failSave = true;
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.getByText('Agent 保存重试测试', { exact: true }).waitFor();
  assert.equal(writes[0].modelProvider, `profile:${profiles[0].id}`);
  assert.equal(writes[0].modelId, 'glm-fast');
  assert.equal(writes[0].apiKey, null);
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '详细配置', exact: true }).waitFor({ state: 'detached' });
  const allAgents = await json(await context.request.get(`${base}/api/agents`));
  const agent = allAgents.agents.find(item => item.name === agentName);
  assert(agent); agentIds.push(agent.id);
  assert.equal(agent.modelId, 'glm-fast');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click();
  await editAgent();
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('glm-fast'));
  // Inline provider management updates the catalog without replacing the Agent draft.
  await page.getByRole('button', { name: '管理供应商', exact: true }).click();
  await page.getByRole('button', { name: `配置 ${profileName}`, exact: true }).click();
  await page.getByLabel('默认模型', { exact: true }).fill('glm-new-default');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await page.getByRole('button', { name: '返回模型配置', exact: true }).click();
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('glm-fast'));
  await page.getByRole('button', { name: '模型 *', exact: true }).click();
  await page.getByRole('button', { name: '选择模型 glm-new-default', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('heading', { name: '编辑 Agent', exact: true }).count(), 1, 'Escape returns to config without closing the Agent draft');
  await page.locator('.agent-model-advanced summary').click();
  await page.getByLabel('Agent API Key', { exact: true }).fill('fixture-agent-private-key');
  await page.getByLabel('Agent API 地址', { exact: true }).fill('https://override.fixture.invalid/v1');
  await chooseSupplier(`${profileName} Other`);
  await page.getByRole('button', { name: '保留当前配置', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Agent API Key', { exact: true }).inputValue(), 'fixture-agent-private-key');
  await page.getByRole('button', { name: '模型 *', exact: true }).click();
  await page.getByRole('button', { name: '手动填写模型 ID', exact: true }).click();
  await page.getByLabel('手动模型 ID', { exact: true }).fill('private-manual-model');
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  assert.equal(await page.getByLabel('Agent API Key', { exact: true }).inputValue(), 'fixture-agent-private-key');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('heading', { name: '编辑 Agent', exact: true }).waitFor({ state: 'detached' });
  const saved = (await json(await context.request.get(`${base}/api/agents`))).agents.find(item => item.id === agent.id);
  assert.equal(saved.modelId, 'private-manual-model');
  assert.equal(saved.apiBaseUrl, 'https://override.fixture.invalid/v1');
  await editAgent();
  await chooseSupplier(`${profileName} Other`);
  await page.getByRole('button', { name: '切换并清除覆盖', exact: true }).click();
  await page.locator('.agent-model-advanced summary').click();
  assert.equal(await page.getByLabel('Agent API Key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Agent API 地址', { exact: true }).inputValue(), '');
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('other-default'));
  await page.locator('.agent-model-advanced summary').click();
  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 768, 'dark'], [768, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${height}-${theme}-editor`);
    await page.getByRole('button', { name: '模型 *', exact: true }).click();
    await capture(`${width}-${height}-${theme}-models`);
    await page.getByLabel('搜索模型', { exact: true }).fill('no-match');
    await page.getByText('未找到模型', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '供应商 *', exact: true }).click();
    await capture(`${width}-${height}-${theme}-suppliers`);
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  hideProfiles = true;
  await editAgent();
  await page.getByText('原供应商配置', { exact: true }).waitFor();
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('private-manual-model'));
  await page.locator('.agent-model-advanced summary').click();
  assert.equal(await page.getByLabel('Agent API Key', { exact: true }).inputValue(), 'fixture-agent-private-key');
  await page.keyboard.press('Escape');
  hideProfiles = false;
  const { agent: legacy } = await json(await context.request.post(`${base}/api/agents`, { data: {
    name: `${agentName} Legacy`, description: 'Independent legacy Agent model', adapterName: 'custom', modelProvider: 'openai-compatible',
    modelId: 'legacy-private-model', apiKey: 'fixture-legacy-private-key', apiBaseUrl: 'https://legacy.fixture.invalid/v1', toolNames: []
  } }));
  agentIds.push(legacy.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click();
  await page.locator('.workspace-agent-row').filter({ has: page.getByText(legacy.name, { exact: true }) }).getByTitle('编辑', { exact: true }).click();
  await openModelTab();
  await page.getByText('独立 OpenAI-Compatible', { exact: true }).waitFor();
  assert((await page.getByRole('button', { name: '模型 *', exact: true }).innerText()).includes('legacy-private-model'));
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', persistence: 'profile + catalog + custom model + independent overrides', viewports: 7, screenshots: 21, consoleErrors: errors.length }));
} finally {
  await page.close();
  for (const id of agentIds) await context.request.delete(`${base}/api/agents/${id}`);
  for (const profile of profiles) await context.request.delete(`${base}/api/model-providers`, { data: { id: profile.id } });
  await browser.close();
}
