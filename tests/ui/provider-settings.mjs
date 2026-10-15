import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Entire credential/connection API is mocked. No real credential is read, written or tested.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3018';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const output = '.tmp-ui-artifacts/provider-settings';
await fs.mkdir(output, { recursive: true });
const errors = [];
const pages = [];
const keyFields = { deepseek: 'deepseekApiKey', openai: 'openaiApiKey', 'volcano-ark': 'arkApiKey', anthropic: 'anthropicApiKey' };
const initial = { deepseekApiKey: 'fixture-existing-deepseek-key', openaiApiKey: null, arkApiKey: null, anthropicApiKey: null, anthropicBaseUrl: null,
  deploymentPublishEnabled: false, deploymentPublishDir: null, deploymentPublicBaseUrl: null };
function masked(value) { return value ? '*'.repeat(Math.max(1, value.length - 4)) + value.slice(-4) : null; }
async function newPage(width = 1440, height = 900, empty = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  pages.push(page);
  const state = { ...initial, deepseekApiKey: empty ? null : initial.deepseekApiKey };
  const environment = empty ? [] : ['openai'];
  const requests = [];
  const tests = [];
  let failNext = false;
  const snapshot = () => ({ settings: { ...state, ...Object.fromEntries(Object.values(keyFields).map(key => [key, masked(state[key])])) },
    keySources: Object.fromEntries(Object.entries(keyFields).map(([provider, key]) => [provider, state[key] ? 'app_settings' : environment.includes(provider) ? 'environment' : 'missing'])) });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: snapshot() });
    const patch = route.request().postDataJSON(); requests.push(patch);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: '供应商保存暂时失败，请重试。' } }); }
    Object.assign(state, patch);
    return route.fulfill({ json: snapshot() });
  });
  await page.route('**/api/settings/test-connection', route => { tests.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, latencyMs: 42 } }); });
  await page.route('**/api/model-providers', route => route.fulfill({ json: { providers: [], environmentPresets: [] } }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  return { page, requests, tests, state, failNext: () => { failNext = true; } };
}
async function open(page) {
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('heading', { name: '模型供应商', exact: true }).waitFor();
}
async function capture(page, name) {
  const modal = page.locator('dialog[open]').last();
  const box = await modal.boundingBox();
  const { width, height } = page.viewportSize();
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${name}: modal bounds`);
  assert(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: no modal overflow`);
  const footer = await modal.locator('footer').boundingBox();
  assert(footer.y + footer.height <= height + 1, `${name}: footer stays visible`);
  assert(await modal.evaluate(node => node.contains(document.activeElement)), `${name}: focus remains in modal`);
  await page.screenshot({ path: `${output}/${name}.png` });
}
async function editorGone(page, name) { await page.getByRole('dialog', { name, exact: true }).waitFor({ state: 'detached' }); }

try {
  const app = await newPage();
  const { page } = app;
  await open(page);
  assert.equal(await page.locator('.provider-row').count(), 2);
  assert.equal(await page.locator('dialog[open] input[type=password]').count(), 0, 'Overview contains no credential forms');
  assert(await page.getByRole('button', { name: '移除 OpenAI 本地配置', exact: true }).isDisabled(), 'Environment configuration is not deletable from this page');
  await capture(page, 'desktop-overview');

  await page.getByRole('button', { name: '配置 DeepSeek', exact: true }).click();
  assert.equal(await page.getByLabel('DeepSeek API Key').inputValue(), '', 'A stored mask is never loaded into the editor');
  assert(await page.getByRole('button', { name: '保存供应商', exact: true }).isDisabled());
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接成功，42 ms', { exact: true }).waitFor();
  assert.deepEqual(app.tests[0], { provider: 'deepseek', modelId: 'deepseek-chat' }, 'Inherited credential test never sends a masked key');
  await page.getByLabel('DeepSeek API Key').fill('fixture-new-key');
  assert.equal(await page.getByText('连接成功，42 ms', { exact: true }).count(), 0, 'Editing a key invalidates the old connection result');
  await page.getByRole('button', { name: '显示新输入的密钥', exact: true }).click();
  assert.equal(await page.getByLabel('DeepSeek API Key').getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏新输入的密钥', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('DeepSeek API Key').inputValue(), 'fixture-new-key');
  app.failNext();
  await page.getByRole('button', { name: '保存供应商', exact: true }).dblclick();
  await page.getByText('供应商保存暂时失败，请重试。', { exact: true }).waitFor();
  assert.equal(app.requests.length, 1, 'Double-click produces one mutation');
  assert.equal(await page.getByLabel('DeepSeek API Key').inputValue(), 'fixture-new-key');
  await capture(page, 'desktop-editor-retry');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await editorGone(page, '配置 DeepSeek');
  assert.deepEqual(app.requests[1], { deepseekApiKey: 'fixture-new-key' }, 'Provider save is a minimal partial patch');
  assert.equal(app.state.openaiApiKey, null);

  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '添加 DeepSeek', exact: true }).count(), 0, 'Existing providers cannot be added twice');
  await capture(page, 'desktop-catalog');
  await page.getByLabel('搜索供应商').fill('Anthropic');
  await page.getByRole('button', { name: '添加 Anthropic', exact: true }).click();
  await page.getByLabel('Anthropic API Key').fill('fixture-anthropic-key');
  await page.getByText('自定义设置', { exact: true }).click();
  await page.getByLabel('Anthropic API 地址').fill('javascript:invalid');
  assert(await page.getByRole('button', { name: '保存供应商', exact: true }).isDisabled());
  await page.getByLabel('Anthropic API 地址').fill('https://example.com/anthropic');
  assert.equal(await page.getByRole('button', { name: '测试连接', exact: true }).count(), 0, 'Unsupported Anthropic diagnostics are not simulated');
  await capture(page, 'desktop-add-anthropic');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('dialog', { name: '添加模型供应商', exact: true }).waitFor();
  assert.equal(app.state.anthropicApiKey, null, 'Returning from an unsaved editor creates no provider');
  await page.getByLabel('搜索供应商').fill('Anthropic');
  await page.getByRole('button', { name: '添加 Anthropic', exact: true }).click();
  await page.getByLabel('Anthropic API Key').fill('fixture-anthropic-key');
  await page.getByText('自定义设置', { exact: true }).click();
  await page.getByLabel('Anthropic API 地址').fill('https://example.com/anthropic');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await editorGone(page, '添加 Anthropic');
  assert.deepEqual(app.requests.at(-1), { anthropicApiKey: 'fixture-anthropic-key', anthropicBaseUrl: 'https://example.com/anthropic' });
  await page.getByRole('button', { name: '移除 Anthropic 本地配置', exact: true }).click();
  await page.getByRole('button', { name: '移除配置', exact: true }).click();
  await editorGone(page, '移除本地配置？');
  assert.equal(await page.getByRole('button', { name: '配置 Anthropic', exact: true }).count(), 0);

  await page.getByRole('button', { name: '配置 OpenAI', exact: true }).click();
  await page.getByLabel('OpenAI API Key').fill('fixture-openai-local-key');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await editorGone(page, '配置 OpenAI');
  await page.getByRole('button', { name: '移除 OpenAI 本地配置', exact: true }).click();
  await page.getByRole('button', { name: '移除配置', exact: true }).click();
  await editorGone(page, '移除本地配置？');
  assert(await page.getByRole('button', { name: '移除 OpenAI 本地配置', exact: true }).isDisabled());
  await page.getByText('OpenAI 的本地配置已移除，当前使用环境变量。', { exact: true }).waitFor();

  await page.getByRole('button', { name: '发布与预览', exact: true }).click();
  await page.getByRole('switch', { name: '外部静态发布', exact: true }).click();
  await page.getByLabel('发布根目录', { exact: true }).fill('fixture-unsaved-publish');
  await page.getByRole('button', { name: '模型供应商', exact: true }).click();
  await page.getByRole('button', { name: '配置 DeepSeek', exact: true }).click();
  await page.getByLabel('DeepSeek API Key').fill('fixture-second-new-key');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await editorGone(page, '配置 DeepSeek');
  await page.getByRole('button', { name: '发布与预览', exact: true }).click();
  assert.equal(await page.getByLabel('发布根目录', { exact: true }).inputValue(), 'fixture-unsaved-publish');
  assert.equal(await page.getByRole('switch', { name: '外部静态发布', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await editorGone(page, '设置');
  assert.deepEqual(Object.keys(app.requests.at(-1)).sort(), ['deploymentPublicBaseUrl', 'deploymentPublishDir', 'deploymentPublishEnabled']);

  for (const width of [1024, 768, 390]) {
    for (const dark of [false, true]) {
      const compact = (await newPage(width, width === 390 ? 844 : 720)).page;
      if (dark) await compact.getByTitle('深色模式', { exact: true }).click();
      await open(compact);
      await capture(compact, `${width}-${dark ? 'dark' : 'light'}-overview`);
      await compact.getByRole('button', { name: '添加供应商', exact: true }).click();
      await capture(compact, `${width}-${dark ? 'dark' : 'light'}-catalog`);
      await compact.getByRole('button', { name: '添加 火山方舟', exact: true }).click();
      await compact.getByLabel('火山方舟 API Key').fill('fixture-ark-key');
      await compact.getByText('连接诊断', { exact: true }).click();
      await capture(compact, `${width}-${dark ? 'dark' : 'light'}-editor`);
    }
  }
  const firstRun = (await newPage(1280, 420, true)).page;
  await open(firstRun);
  await firstRun.getByText('尚未添加模型供应商', { exact: true }).waitFor();
  await capture(firstRun, 'empty-short-window');
  await firstRun.getByRole('button', { name: '添加供应商', exact: true }).click();
  await firstRun.getByRole('button', { name: '添加 DeepSeek', exact: true }).click();
  await firstRun.getByLabel('DeepSeek API Key').fill('fixture-first-key');
  await capture(firstRun, 'first-provider-short-window');
  assert.deepEqual(errors, [], 'No React errors');
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ result: 'passed', viewports: [1440, 1024, 768, 390, '1280x420'], assertions: ['no credential wall', 'source accuracy', 'write-only key editor', 'minimal patches', 'test connection', 'duplicates', 'failure retention', 'unsaved guards', 'removal fallback', 'publishing draft retention', 'mobile/dark/fixed footer'], errors }, null, 2));
  console.log('Passed provider list/add/edit/remove, key security, diagnostics, partial saves, environment fallback, publishing draft retention and responsive/theme checks.');
} catch (error) {
  for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: `${output}/failure-${index}.png` });
  throw error;
} finally { for (const page of pages) await page.close(); await browser.close(); }
