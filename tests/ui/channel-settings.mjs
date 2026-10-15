import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// All Feishu reads/actions are fixtures. No external application is created or removed.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3018';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const output = '.tmp-ui-artifacts/channel-settings';
await fs.mkdir(output, { recursive: true });
const context = browser.contexts()[0];
const authStatus = await context.request.get(`${base}/api/auth/status`);
assert(authStatus.ok(), 'The isolated fixture server must expose auth status');
if (!(await authStatus.json()).paired) {
  const minted = await context.request.post(`${base}/api/auth/pair/code`);
  assert(minted.ok(), 'Could not mint an initial pairing code for the isolated fixture server');
  const { code } = await minted.json();
  const paired = await context.request.post(`${base}/api/auth/pair`, { data: { code } });
  assert(paired.ok(), 'Could not pair the fixture browser');
}
const bootstrapResponse = await context.request.get(`${base}/api/bootstrap`);
assert(bootstrapResponse.ok(), 'Use a paired fixture browser; never reset an existing owner to run this suite');
const bootstrap = await bootstrapResponse.json();
const agents = bootstrap.agents.slice(0, 6).map((agent, index) => ({ ...agent, name: ['Conductor', '产品经理', '视觉设计师', '前端工程师', 'Reviewer', '研究 Agent'][index] }));
agents.push({ ...agents[5], id: 'ag_ui_channel_extra', name: '负责分析跨渠道协作结果与历史审查材料的研究助手' });
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const errors = [];
const calls = [];
let bindingReads = 0;
let failRead = false;
let failCancel = false;
let failUnbind = false;
let sessionMode = 'valid';
let session;
let sessionCount = 0;
const bindings = agents.slice(0, 4).map((agent, index) => ({ id: `ui_channel_binding_${index}`, agentId: agent.id, appId: `cli_fixture_application_${index}_long_id`, channel: 'feishu', createdAt: 1, updatedAt: 1 }));
const connections = [0, 1, 3].map(index => ({ agentId: agents[index].id, appId: bindings[index].appId, status: index === 1 ? 'error' : 'connected', botName: `${agents[index].name} Bot`, botOpenId: `ou_fixture_${index}`, connectedAt: 1, lastError: index === 1 ? '连接被远端拒绝，请检查应用权限。' : index === 3 ? 'rejected:bot_loop' : null }));
const failed = { id: 'ui_failed_attempt', agentId: agents[5].id, status: 'failed', expiresAt: 1, error: 'access_denied: 授权被拒绝。' };
async function event(payload) {
  await page.evaluate(payload => window.uiEventSource.onmessage(new MessageEvent('message', { data: JSON.stringify(payload) })), { conversationId: '', timestamp: Date.now(), ...payload });
}
async function capture(name) {
  const modal = page.locator('dialog[open]').last();
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: modal bounds`);
  assert(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: modal overflow`);
  const content = page.locator('.channel-settings:visible');
  if (await content.count() && await page.locator('dialog[open]').count() === 1) assert(await content.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${name}: content overflow`);
  const footer = await modal.locator('footer').boundingBox();
  assert(footer.y + footer.height <= viewport.height + 1, `${name}: pinned footer`);
  assert(await modal.evaluate(node => node.contains(document.activeElement)), `${name}: modal focus`);
  await page.screenshot({ path: `${output}/${name}.png` });
}
const row = index => page.locator('.channel-agent-row').filter({ has: page.getByText(agents[index].name, { exact: true }) });
try {
  await page.addInitScript(() => { const Native = window.EventSource; window.EventSource = class extends Native { constructor(...args) { super(...args); window.uiEventSource = this; } }; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: { ...bootstrap, agents } }));
  await page.route('**/api/channels/feishu/bindings', async route => {
    if (route.request().method() === 'GET') {
      bindingReads++;
      if (failRead) { failRead = false; return route.fulfill({ status: 503, json: { error: '绑定状态暂时不可用' } }); }
      return route.fulfill({ json: { data: { bindings, sessions: [failed, ...(session ? [session] : [])] } } });
    }
    calls.push({ type: 'start', body: route.request().postDataJSON() });
    session = { id: `ui_scan_${++sessionCount}`, agentId: route.request().postDataJSON().agentId, status: 'awaiting_scan', expiresAt: sessionMode === 'expired' ? 1 : Date.now() + 300000,
      ...(sessionMode === 'missing' ? {} : { qrUrl: sessionMode === 'unsafe' ? 'javascript:alert(1)' : 'https://open.feishu.cn/test-only-launcher?code=fixture' }) };
    sessionMode = 'valid';
    await new Promise(resolve => setTimeout(resolve, 100));
    return route.fulfill({ json: { data: { session } } });
  });
  await page.route('**/api/channels/feishu/connections', route => route.fulfill({ json: { data: { connections } } }));
  await page.route('**/api/channels/feishu/bindings/sessions/*/cancel', async route => {
    calls.push({ type: 'cancel' });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (failCancel) { failCancel = false; return route.fulfill({ status: 503, json: { error: '取消绑定暂时失败' } }); }
    session = { ...session, status: 'cancelled' };
    return route.fulfill({ json: { data: { session } } });
  });
  await page.route('**/api/channels/feishu/bindings/ui_channel_binding_*', async route => {
    calls.push({ type: 'unbind' });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (failUnbind) { failUnbind = false; return route.fulfill({ status: 503, json: { error: '解绑暂时失败' } }); }
    const id = route.request().url().split('/').at(-1);
    bindings.splice(bindings.findIndex(binding => binding.id === id), 1);
    return route.fulfill({ json: { success: true } });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('button', { name: '渠道绑定', exact: true }).click();
  await page.getByText('连接有告警', { exact: true }).waitFor();
  assert.equal(await page.locator('.channel-agent-row').count(), 7);
  assert.equal(await row(2).getByText('状态未知', { exact: true }).count(), 1, 'Unobserved connection is not shown as an error');
  await page.getByRole('button', { name: '已绑定', exact: true }).click();
  assert.equal(await page.locator('.channel-agent-row').count(), 4);
  await page.getByRole('button', { name: '需处理', exact: true }).click();
  assert.equal(await page.locator('.channel-agent-row').count(), 3);
  await row(3).getByText('查看原因', { exact: true }).click();
  await page.getByText('rejected:bot_loop', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByLabel('搜索渠道 Agent').fill('cli_fixture_application_2');
  assert.equal(await page.locator('.channel-agent-row').count(), 1);
  await page.getByLabel('搜索渠道 Agent').fill('no-such-agent');
  await page.getByText('没有匹配的 Agent', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [1024, 768, 'light'], [768, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 740, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await capture(`${width}-${height}-${theme}-overview`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  failRead = true;
  await page.getByRole('button', { name: '刷新渠道状态', exact: true }).click();
  await page.getByText('绑定状态暂时不可用', { exact: true }).waitFor();
  const before = bindingReads;
  await page.getByRole('button', { name: '刷新渠道状态', exact: true }).click();
  await page.getByText('绑定状态暂时不可用', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(bindingReads, before + 1);
  await page.getByRole('button', { name: `绑定 ${agents[4].name} 到飞书`, exact: true }).dblclick();
  await page.getByRole('dialog', { name: `绑定飞书 · ${agents[4].name}`, exact: true }).waitFor();
  assert.equal(calls.filter(call => call.type === 'start').length, 1);
  assert.equal(await page.locator('.channel-qr svg').count(), 1);
  assert.equal(await page.getByRole('link', { name: '打开确认页', exact: true }).getAttribute('href'), session.qrUrl);
  await capture('desktop-qr');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await capture('mobile-dark-qr');
  failCancel = true;
  await page.getByRole('button', { name: '取消绑定', exact: true }).click();
  await page.getByRole('dialog', { name: `绑定飞书 · ${agents[4].name}`, exact: true }).getByText('取消绑定暂时失败', { exact: true }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 2, 'Cancel failure retains the scan dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: `绑定飞书 · ${agents[4].name}`, exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Escape cancels scan, not Settings');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  for (const mode of ['expired', 'unsafe', 'missing']) {
    sessionMode = mode;
    await page.getByRole('button', { name: `绑定 ${agents[4].name} 到飞书`, exact: true }).click();
    await page.getByRole('button', { name: '重新获取', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '打开确认页', exact: true }).count(), 0, `${mode}: no unusable link`);
    assert.equal(await page.getByRole('img', { name: '飞书绑定二维码', exact: true }).count(), 0, `${mode}: no invalid QR code`);
    await capture(`desktop-${mode}-qr`);
    await page.getByRole('button', { name: '重新获取', exact: true }).click();
    await page.getByRole('link', { name: '打开确认页', exact: true }).waitFor();
    if (mode === 'missing') {
      const binding = { id: 'ui_channel_binding_success', agentId: agents[4].id, appId: 'cli_success', channel: 'feishu', createdAt: 1, updatedAt: 1 };
      bindings.push(binding);
      session = { ...session, status: 'succeeded' };
      await event({ type: 'channel.binding.updated', agentId: agents[4].id, sessionId: session.id, status: 'succeeded', bindingId: binding.id, appId: binding.appId });
      await page.getByRole('dialog', { name: `绑定飞书 · ${agents[4].name}`, exact: true }).waitFor({ state: 'detached' });
      await row(4).getByText('cli_success', { exact: true }).waitFor();
    } else {
      await page.getByRole('button', { name: '取消绑定', exact: true }).click();
      await page.getByRole('dialog', { name: `绑定飞书 · ${agents[4].name}`, exact: true }).waitFor({ state: 'detached' });
    }
  }
  await page.getByRole('button', { name: `解绑 ${agents[0].name} 的飞书应用`, exact: true }).click();
  failUnbind = true;
  await page.getByRole('button', { name: '确认解绑', exact: true }).dblclick();
  await page.getByRole('dialog', { name: '解绑飞书应用？', exact: true }).getByText('解绑暂时失败', { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.type === 'unbind').length, 1);
  await capture('desktop-unbind-retry');
  await page.getByRole('button', { name: '确认解绑', exact: true }).click();
  await page.getByRole('dialog', { name: '解绑飞书应用？', exact: true }).waitFor({ state: 'detached' });
  await row(0).getByText('未绑定应用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '模型供应商', exact: true }).click();
  session = { id: 'ui_scan_hidden', agentId: agents[0].id, status: 'awaiting_scan', expiresAt: 0 };
  await event({ type: 'channel.binding.updated', sessionId: session.id, agentId: session.agentId, status: 'awaiting_scan' });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Hidden Channels tab never opens a scan dialog over provider settings');
  await page.getByRole('button', { name: '渠道绑定', exact: true }).click();
  await page.getByRole('dialog', { name: `绑定飞书 · ${agents[0].name}`, exact: true }).waitFor();
  await page.getByText('二维码暂不可用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消绑定', exact: true }).click();
  await page.getByRole('dialog', { name: `绑定飞书 · ${agents[0].name}`, exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ passed: true, viewports: 8, externalFeishu: 'mocked', checks: ['search-filter', 'unknown-health', 'warning-details', 'refresh-retry', 'single-submit', 'scan-cancel', 'expired-unsafe-missing-link', 'renew-link', 'SSE-binding-success', 'unbind-retry', 'inactive-tab-guard', 'responsive-theme-focus'], calls, errors }, null, 2));
  console.log('Channel Settings: filters, refresh, scan/renew/cancel, SSE success, unbind/retry and 8 responsive/theme cases passed.');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally { await page.close(); await browser.close(); }
