import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// UI fixtures only: no model is called and no production conversation is changed.
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3018';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const output = '.tmp-ui-artifacts/main-workspace';
await fs.mkdir(output, { recursive: true });
const bootstrap = await (await browser.contexts()[0].request.get(`${base}/api/bootstrap`)).json();
const agents = bootstrap.agents.filter(agent => agent.isBuiltin);
const conductor = agents.find(agent => agent.isConductor) || agents[0];
const developer = agents.find(agent => agent.name.includes('前端')) || agents[1];
const designer = agents.find(agent => agent.name.includes('UI')) || agents[2];
const reviewer = agents.find(agent => agent.name.includes('Reviewer')) || agents[3];
const now = Date.now();
const conversation = { ...bootstrap.conversations[0], title: 'Todo 应用 · 设计与实现', agentIds: agents.map(agent => agent.id) };
const second = { ...conversation, id: 'ui_main_empty', title: '新想法', pinnedAt: null };
const makeMessage = (index, role, agent, content, parts = []) => ({
  id: `ui_main_${index}`, conversationId: conversation.id, role, origin: role === 'user' ? 'human' : 'agent',
  agentId: agent?.id ?? null, runId: null, parts: [{ type: 'text', content }, ...parts],
  status: 'complete', mentionedAgentIds: [], parentMessageId: null, createdAt: now + index * 60000, updatedAt: now
});
const artifact = {
  id: 'ui_main_artifact', conversationId: conversation.id, createdByAgentId: designer.id, type: 'document',
  title: 'Todo · 界面规范', version: 1, parentArtifactId: null, createdAt: now, updatedAt: now,
  content: { type: 'document', format: 'markdown', content: '# Todo · 界面规范\n\n## 视觉方向\n\n以内容为中心，减少干扰，保持清晰的任务层级。\n\n| 元素 | 规格 |\n| --- | --- |\n| 正文 | 14px / 24px |\n| 内容宽度 | 720px |\n| 间距 | 4 / 8 / 16 / 24 |\n\n## 交互状态\n\n- 新建任务后保持输入焦点\n- 完成状态支持撤销\n- 空列表保持操作入口\n\n## 验收\n\n桌面与移动端均可完成完整任务流程。' }
};
const messages = [
  makeMessage(0, 'user', null, '做一个简洁的 Todo 应用，支持分类、优先级和截止日期。先统一设计，再开始实现。'),
  makeMessage(1, 'agent', conductor, '我会把这次任务分成三个阶段，先确定边界，再让设计与开发接力。\n\n1. PM 明确功能范围和验收标准\n2. UI 设计师整理界面规范\n3. 前端工程师实现，Reviewer 核对结果'),
  makeMessage(2, 'agent', designer, '界面规范已经整理完成。以任务列表为中心，用少量颜色区分优先级；筛选条件放在列表上方，避免分散注意力。\n\n**已覆盖**：任务输入、分类切换、日期选择和空状态。', [{ type: 'artifact_ref', artifactId: artifact.id }]),
  makeMessage(3, 'user', null, '可以，注意小屏幕的输入体验。完成后跑一下构建和测试。'),
  makeMessage(4, 'agent', developer, '已完成任务列表与筛选，并补齐小屏幕布局。\n\n- 新建、编辑和完成任务\n- 分类、优先级与截止日期筛选\n- 本地保存，刷新后恢复\n\n构建和测试均通过，接下来交给 Reviewer 做最终检查。', [
    { type: 'tool_use', callId: 'ui_main_read', toolName: 'fs_read', args: { path: 'src/App.tsx' } },
    { type: 'tool_result', callId: 'ui_main_read', result: { content: 'Verified component source.' } },
    { type: 'tool_use', callId: 'ui_main_build', toolName: 'bash', args: { command: 'npm run build' } },
    { type: 'tool_result', callId: 'ui_main_build', result: { exitCode: 0, stdout: 'Build completed successfully.' } }
  ]),
  makeMessage(5, 'agent', reviewer, '验收完成，当前没有阻塞问题。任务操作、筛选组合以及刷新后的数据恢复符合约定。\n\n**建议下一步**：增加键盘导航的端到端回归测试。')
];
const fixture = { ...bootstrap, conversations: [conversation, second], messagesByConversation: { [conversation.id]: messages, [second.id]: [] }, artifactsByConversation: { [conversation.id]: [artifact], [second.id]: [] } };
const errors = [];
const pages = [];
async function pageAt(width, height = 900) {
  const page = await browser.newPage({ viewport: { width, height } });
  pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace-transcript').waitFor();
  return page;
}
async function capture(page, name) {
  await page.screenshot({ path: `${output}/${name}.png` });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  const composer = await page.locator('.workspace-compose-box').boundingBox();
  assert(composer && composer.y + composer.height <= page.viewportSize().height, `${name}: composer visible`);
}
try {
  const page = await pageAt(1536, 960);
  assert.equal(await page.locator('.ui-right-pane').count(), 0, 'First view does not reserve an empty preview pane');
  const bodyStyle = await page.locator('.workspace-message.is-agent .workspace-message-body').first().evaluate(node => ({ border: getComputedStyle(node).borderWidth, shadow: getComputedStyle(node).boxShadow }));
  assert.equal(bodyStyle.border, '0px');
  assert.equal(bodyStyle.shadow, 'none');
  await capture(page, 'desktop-conversation');

  await page.getByLabel('消息', { exact: true }).fill('保留这条尚未发送的任务草稿');
  const scroller = page.locator('.workspace-chat-scroller');
  await scroller.evaluate(node => { node.scrollTop = 90; node.dispatchEvent(new Event('scroll')); });
  const position = await scroller.evaluate(node => node.scrollTop);
  await page.getByTitle('Agents', { exact: true }).click();
  assert.equal(await page.locator('.workspace-conversation').isVisible(), false);
  assert((await page.locator('.workspace-view').boundingBox()).width > 900, 'Agent management uses the main surface');
  await captureView(page, 'desktop-team');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留这条尚未发送的任务草稿');
  assert(Math.abs(await scroller.evaluate(node => node.scrollTop) - position) < 2, 'Returning from management preserves reading position');
  await page.getByLabel('消息', { exact: true }).fill('');

  await page.getByTitle('工作区文件', { exact: true }).click();
  await page.getByRole('separator', { name: '调整工作区文件面板宽度', exact: true }).waitFor();
  await page.getByTitle('产物库', { exact: true }).click();
  await page.locator('.workspace-view').getByRole('button', { name: /Todo · 界面规范/ }).first().click();
  assert.equal(await page.locator('.workspace-conversation').isVisible(), true, 'Library selection returns to the owning conversation');
  await page.locator('.ui-right-pane').waitFor();
  await page.getByTitle('关闭预览', { exact: true }).waitFor();
  await page.getByTitle('工作区文件', { exact: true }).click();
  await page.getByTitle('点击在右侧预览', { exact: true }).click();
  await page.getByTitle('关闭预览', { exact: true }).waitFor();
  await capture(page, 'desktop-split');
  await page.getByTitle('深色模式', { exact: true }).click();
  await capture(page, 'desktop-dark-split');
  await page.getByTitle('关闭预览', { exact: true }).click();
  await page.getByTitle('浅色模式', { exact: true }).click();

  await page.getByTitle('选择回复 Agent', { exact: true }).click();
  await page.getByRole('checkbox', { name: `@${developer.name}`, exact: true }).check();
  await page.getByRole('checkbox', { name: `@${reviewer.name}`, exact: true }).check();
  await page.keyboard.press('Escape');
  assert((await page.getByTitle('选择回复 Agent', { exact: true }).innerText()).includes(developer.name));
  let submitted;
  await page.route(`**/api/conversations/${conversation.id}/messages`, async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { message: makeMessage(6, 'user', null, submitted.content) } });
  });
  await page.getByLabel('消息', { exact: true }).fill('请验证键盘导航');
  await page.getByTitle('发送', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').value === '');
  assert.deepEqual(new Set(submitted.mentionedAgentIds), new Set([developer.id, reviewer.id]));
  assert.equal(submitted.content, '请验证键盘导航');

  let approvalRequests = 0;
  let currentConversation = { ...conversation };
  await page.route(`**/api/conversations/${conversation.id}`, async route => {
    approvalRequests++;
    const patch = route.request().postDataJSON();
    await new Promise(resolve => setTimeout(resolve, 200));
    currentConversation = { ...currentConversation, ...patch };
    await route.fulfill({ json: { conversation: currentConversation } });
  });
  await page.getByRole('button', { name: '自动审批', exact: true }).dblclick();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="自动审批"]').disabled);
  assert.equal(approvalRequests, 1, 'Approval toggle serializes requests');

  await page.getByTitle('筛选会话', { exact: true }).click();
  await page.getByLabel('筛选会话', { exact: true }).fill('不存在的会话');
  await page.getByText('没有匹配的会话', { exact: true }).waitFor();
  await page.getByTitle('清除筛选', { exact: true }).click();
  await page.getByTitle(`更多操作：${conversation.title}`, { exact: true }).click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.locator('dialog[open] input').fill('Todo 应用 · 验收完成');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: 'Todo 应用 · 验收完成', exact: true }).waitFor();
  await page.getByTitle('更多操作：Todo 应用 · 验收完成', { exact: true }).click();
  await page.getByRole('button', { name: '置顶', exact: true }).click();
  await page.getByText('已置顶', { exact: true }).waitFor();
  await page.getByTitle('折叠侧栏', { exact: true }).click();
  assert.equal((await page.locator('.workspace-sidebar').boundingBox()).width, 56);
  await page.getByTitle('展开侧栏', { exact: true }).click();

  for (const width of [1280, 1024, 768, 390]) {
    const compact = await pageAt(width, width === 390 ? 844 : 820);
    await capture(compact, `${width}-conversation`);
    await compact.getByTitle('选择回复 Agent', { exact: true }).click();
    const menu = await compact.getByRole('dialog', { name: '选择回复 Agent', exact: true }).boundingBox();
    assert(menu.x >= 0 && menu.x + menu.width <= width && menu.y >= 0, 'Recipient selector stays in viewport');
    await compact.keyboard.press('Escape');
    await compact.getByTitle('Artifact Workspace', { exact: true }).click();
    await capture(compact, `${width}-split`);
    await compact.getByTitle('关闭预览', { exact: true }).click();
    await compact.getByTitle('深色模式', { exact: true }).click();
    await capture(compact, `${width}-dark`);
    if (width <= 900) {
      await compact.getByTitle('展开侧栏', { exact: true }).click();
      await compact.getByTitle(second.title, { exact: true }).click();
      assert.equal(await compact.locator('.workspace-nav-backdrop').count(), 0, 'Selecting a mobile conversation dismisses navigation');
    } else await compact.getByTitle(second.title, { exact: true }).click();
    await compact.getByRole('heading', { name: '准备好开始了', exact: true }).waitFor();
    await capture(compact, `${width}-empty`);
  }
  assert.deepEqual(errors, [], 'No React runtime errors');
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ result: 'passed', viewportWidths: [1536, 1280, 1024, 768, 390], errors, checkedAt: new Date().toISOString() }, null, 2));
  console.log('Passed main workspace layouts, full-width management, draft/scroll preservation, recipient routing, serialized approval toggle, mobile navigation and empty states.');
} catch (error) {
  for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: `${output}/failure-${index}.png` });
  throw error;
} finally {
  for (const page of pages) await page.close();
  await browser.close();
}
async function captureView(page, name) {
  await page.screenshot({ path: `${output}/${name}.png` });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}
