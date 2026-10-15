import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Paired disposable server only; never mint or revoke the user's browser session.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
const response = await context.request.get(`${base}/api/bootstrap`);
assert(response.ok(), 'Use a paired isolated fixture server');
const bootstrap = await response.json();
const now = Date.now();
const conversation = bootstrap.conversations[0];
const agents = [...bootstrap.agents, { ...bootstrap.agents[0], id: 'ag_avatar_custom', name: 'Atlas Helper', isConductor: false, capabilities: [] }];
const messages = agents.map((agent, index) => ({ id: `ui_avatar_${index}`, conversationId: conversation.id, role: 'agent', origin: 'agent', agentId: agent.id, runId: null,
  parts: [{ type: 'text', content: ['已整理任务依赖，接下来交给团队协作。', '已确认需求范围和验收标准。', '视觉规范已更新，组件状态已经补齐。', '实现和构建验证已完成。', '审查完成，结果已附上。', '相关资料已整理。'][index % 6] }],
  status: 'complete', mentionedAgentIds: [], parentMessageId: null, createdAt: now + index, updatedAt: now + index }));
const fixture = { ...bootstrap, agents, conversations: bootstrap.conversations.map(item => item.id === conversation.id ? { ...item, agentIds: agents.map(agent => agent.id) } : item), messagesByConversation: { ...bootstrap.messagesByConversation, [conversation.id]: messages } };
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const output = '.tmp-ui-artifacts/agent-avatars';
await fs.mkdir(output, { recursive: true });
async function checkAvatars(scope) {
  const avatars = scope.locator('.agent-avatar:visible');
  assert(await avatars.count() > 0, 'Avatars remain visible');
  for (const avatar of await avatars.all()) {
    const metrics = await avatar.evaluate(node => {
      const style = getComputedStyle(node); const bounds = node.getBoundingClientRect();
      return { w: bounds.width, h: bounds.height, radius: parseFloat(style.borderRadius), bg: style.backgroundColor, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    assert(Math.abs(metrics.w - metrics.h) < 1, 'Square avatar');
    assert(metrics.w >= 20 && metrics.w <= 44, 'Stable avatar sizes');
    assert(metrics.radius < metrics.w / 2, 'Soft-square avatar, not old circle');
    assert(!metrics.overflow, 'Avatar content fits');
  }
}
try {
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.route('**/api/channels/feishu/bindings', route => route.fulfill({ json: { data: { bindings: [], sessions: [] } } }));
  await page.route('**/api/channels/feishu/connections', route => route.fulfill({ json: { data: { connections: [] } } }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('对话', { exact: true }).click();
  await page.getByRole('heading', { name: conversation.title, exact: true }).waitFor();
  for (const [width, height, theme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [768, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await checkAvatars(page.locator('.workspace-team-members'));
    await checkAvatars(page.locator('.workspace-transcript'));
    await page.locator('.workspace-chat-scroller').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: `${output}/${width}-${theme}-conversation.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.getByTitle(`查看 ${agents[0].name}`, { exact: true }).first().click();
  await page.locator('[data-avatar-size="lg"]').waitFor();
  await checkAvatars(page);
  await page.screenshot({ path: `${output}/agent-profile.png` });
  await page.keyboard.press('Escape');
  await page.getByTitle('选择回复 Agent', { exact: true }).click();
  await checkAvatars(page.locator('.workspace-recipient-menu'));
  assert.equal(await page.getByRole('checkbox', { name: '@Atlas Helper', exact: true }).count(), 1);
  await page.screenshot({ path: `${output}/recipient-picker.png` });
  await page.keyboard.press('Escape');
  await page.getByTitle('管理会话 Agent', { exact: true }).click();
  await checkAvatars(page.locator('dialog[open]'));
  await page.screenshot({ path: `${output}/team-manager.png` });
  await page.keyboard.press('Escape');
  await page.getByTitle('Agents', { exact: true }).click();
  await checkAvatars(page.locator('.workspace-agent-library'));
  await page.screenshot({ path: `${output}/agent-library.png` });
  const custom = page.locator('.workspace-agent-row').filter({ has: page.getByText('Atlas Helper', { exact: true }) });
  assert.equal(await custom.locator('.agent-avatar-monogram').innerText(), 'AH');
  await custom.getByRole('button', { name: '查看 Atlas Helper 的详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑配置', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('button', { name: '渠道绑定', exact: true }).click();
  await page.locator('.channel-agent-list').getByText('Atlas Helper', { exact: true }).waitFor();
  await checkAvatars(page.locator('dialog[open]'));
  await page.screenshot({ path: `${output}/channel-settings.png` });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, themes: 2, viewportSizes: 3, contexts: ['conversation', 'team-strip', 'profile', 'recipient-picker', 'team-manager', 'agent-library', 'channel-settings'], errors }));
} finally { await page.close(); await browser.close(); }
