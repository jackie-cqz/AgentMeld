import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Attach to an isolated Chrome instance and an isolated AgentMeld data directory.
// No real model calls or Feishu application registrations are made by this suite.
const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:3018';
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const output = '.tmp-ui-artifacts/regression';
await fs.mkdir(output, { recursive: true });
const errors = [];
const results = [];
const bootstrap = await (await browser.contexts()[0].request.get(`${baseUrl}/api/bootstrap`)).json();
const conversation = bootstrap.conversations[0];
assert(conversation, 'A seeded conversation is required');
const agent = bootstrap.agents.find(item => item.isConductor) || bootstrap.agents[0];
const now = Date.now();
const artifacts = [1, 2].map(version => ({
  id: `ui_artifact_${version}`, conversationId: conversation.id, createdByAgentId: agent.id,
  type: 'document', title: '协作验收清单', content: { type: 'document', format: 'markdown', content: `# 验收清单\n\n版本 ${version}\n\n- 布局一致\n- 工具证据可追踪` },
  version, parentArtifactId: version === 2 ? 'ui_artifact_1' : null, createdAt: now, updatedAt: now
}));
const messages = Array.from({ length: 16 }, (_, index) => ({
  id: `ui_message_${index}`, conversationId: conversation.id, role: index % 2 ? 'agent' : 'user',
  origin: index % 2 ? 'agent' : 'human', agentId: index % 2 ? agent.id : null, runId: index === 15 ? 'ui_trace_run' : null,
  parts: [{ type: 'text', content: index % 2 ? `已核对当前任务的相关输入。\n\n${'本轮仅采用可验证的工具结果与产物。'.repeat(index === 15 ? 35 : 2)}` : '请检查这轮协作结果。' }],
  status: 'complete', mentionedAgentIds: [], parentMessageId: null, createdAt: now + index, updatedAt: now + index
}));
messages[15].parts.push(
  { type: 'tool_use', callId: 'ui_tool_1', toolName: 'fs_read', args: { path: 'acceptance.md' } },
  { type: 'tool_result', callId: 'ui_tool_1', result: { content: 'Acceptance evidence' } },
  { type: 'tool_use', callId: 'ui_tool_2', toolName: 'ask_user', args: { questions: [] } },
  { type: 'tool_result', callId: 'ui_tool_2', result: { answered: true } }
);
const fixture = { ...bootstrap, messagesByConversation: { ...bootstrap.messagesByConversation, [conversation.id]: messages },
  artifactsByConversation: { ...bootstrap.artifactsByConversation, [conversation.id]: artifacts } };
async function newPage(width = 1440, height = 900, pending = false) {
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.localStorage.setItem('agentmeld:right-panel-width', '640');
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(...args) { super(...args); window.uiEventSource = this; }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  if (pending) {
    const common = { conversationId: conversation.id, agentId: agent.id, runId: 'ui_run', createdAt: now };
    const question = { ...common, id: 'ui_question', questions: [
      { header: '验收范围', question: '先验证哪一部分？', options: [{ label: '完整流程' }, { label: '重点界面' }] },
      { header: '补充要求', question: '还有哪些验收要求？', options: [] }
    ] };
    const command = { ...common, id: 'ui_bash', command: 'npm run build -- --configuration=production-with-a-long-readable-command', cwd: 'workspace/project/long-path/src', reason: '验证构建结果' };
    const write = { ...common, id: 'ui_write', path: 'src/acceptance.ts', absolutePath: '/test-only/src/acceptance.ts', oldContent: 'export const ready = false;', newContent: 'export const ready = true;' };
    const workerId = conversation.agentIds.find(id => bootstrap.agents.some(item => item.id === id && !item.isConductor));
    const plan = { ...common, id: 'ui_plan', plan: [{ id: 't1', agentId: workerId, task: '检查主要界面的布局、可访问性和工具执行结果', dependsOn: [], acceptanceCriteria: ['构建通过', '小屏没有遮挡'] }] };
    await page.route('**/pending-questions', route => route.fulfill({ json: { pendingQuestions: [question] } }));
    await page.route('**/pending-bash-commands', route => route.fulfill({ json: { pendingBashCommands: [command] } }));
    await page.route('**/pending-writes', route => route.fulfill({ json: { pendingWrites: [write] } }));
    await page.route('**/pending-dispatch-plans', route => route.fulfill({ json: { pendingDispatchPlans: [plan] } }));
  }
  await page.route('**/api/artifacts/ui_artifact_*/versions', route => route.fulfill({ json: { versions: artifacts, latestId: 'ui_artifact_2' } }));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Artifact Workspace', { exact: true }).click();
  return page;
}
async function screenshot(page, name) { await page.screenshot({ path: `${output}/${name}.png` }); }
async function noOverflow(page, name) {
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  assert(dimensions.scroll <= dimensions.client + 1, `${name}: page overflow ${JSON.stringify(dimensions)}`);
}
async function railGap(page) {
  const rail = await page.getByTitle('跳转到第 1 条消息', { exact: true }).boundingBox();
  const avatar = await page.locator('#message-ui_message_14').getByText('我', { exact: true }).last().boundingBox();
  assert(rail && avatar && rail.x > avatar.x + avatar.width + 6, 'Timeline remains to the right of user avatar');
  return rail.x - avatar.x - avatar.width;
}
async function modalCheck(page, name) {
  const modal = page.locator('dialog[open]').last();
  await modal.waitFor();
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${name}: modal outside viewport`);
  const overflow = await modal.evaluate(node => node.scrollWidth > node.clientWidth + 1);
  assert(!overflow, `${name}: modal horizontal overflow`);
  if (await modal.locator('footer').count()) {
    const footer = await modal.locator('footer').boundingBox();
    assert(footer.y + footer.height <= viewport.height + 1, `${name}: footer inaccessible`);
  }
  assert(await page.evaluate(() => document.querySelector('dialog[open]:last-of-type')?.contains(document.activeElement)), `${name}: focus outside dialog`);
  await noOverflow(page, name);
}

try {
  for (const width of [1440, 1280, 1024, 768, 390]) {
    for (const theme of ['light', 'dark']) {
      const page = await newPage(width, width === 390 ? 720 : 800);
      if (theme === 'dark') await page.getByTitle('深色模式', { exact: true }).click();
      await screenshot(page, `${width}-${theme}-panel-open`);
      await noOverflow(page, `${width}-${theme}-panel-open`);
      if (width >= 1024) {
        const handle = page.getByRole('separator', { name: '调整 Artifact Workspace 宽度' });
        const before = (await page.locator('.ui-right-pane').boundingBox()).width;
        await handle.focus();
        await page.keyboard.press('ArrowRight');
        const narrower = (await page.locator('.ui-right-pane').boundingBox()).width;
        assert(narrower < before, `${width}: first resize key must change rendered width`);
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x - 12, box.y + 100);
        await page.mouse.up();
        assert((await page.locator('.ui-right-pane').boundingBox()).width > narrower, `${width}: pointer resize starts at actual width`);
      }
      const openGap = await railGap(page);
      await page.getByTitle('关闭预览', { exact: true }).click();
      await screenshot(page, `${width}-${theme}-panel-closed`);
      await noOverflow(page, `${width}-${theme}-panel-closed`);
      assert(Math.abs(await railGap(page) - openGap) <= 1, 'Opening the pane preserves rail/avatar spacing');
      await page.getByTitle('设置', { exact: true }).click();
      await page.getByRole('heading', { name: '模型供应商', exact: true }).waitFor();
      await modalCheck(page, `${width}-${theme}-settings`);
      await screenshot(page, `${width}-${theme}-settings`);
      await page.keyboard.press('Escape');
      await page.getByTitle('Agents', { exact: true }).click();
      await page.getByTitle('新建 Agent', { exact: true }).click();
      await page.getByRole('button', { name: '详细配置', exact: false }).click();
      await page.getByRole('tab', { name: '工具记录', exact: true }).click();
      await modalCheck(page, `${width}-${theme}-tools`);
      await screenshot(page, `${width}-${theme}-tools`);
      await page.getByRole('tab', { name: '系统提示词', exact: true }).click();
      await modalCheck(page, `${width}-${theme}-prompt`);
      await screenshot(page, `${width}-${theme}-prompt`);
      await page.keyboard.press('Escape');
      await page.close();
      results.push({ width, theme, result: 'passed' });
    }
  }
  const page = await newPage(1280, 600);
  await page.getByTitle('关闭预览', { exact: true }).click();
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('heading', { name: '模型供应商', exact: true }).waitFor();
  await page.getByRole('button', { name: '发布与预览', exact: true }).click();
  const publishSwitch = page.getByRole('switch', { name: '外部静态发布', exact: true });
  if (await publishSwitch.getAttribute('aria-checked') !== 'true') await publishSwitch.click();
  await page.getByLabel('发布根目录', { exact: true }).fill('UI unsaved publishing draft');
  await page.keyboard.press('Escape');
  await modalCheck(page, 'unsaved-confirmation');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('发布根目录', { exact: true }).inputValue(), 'UI unsaved publishing draft');
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press('Tab');
    assert(await page.locator('dialog[open]').evaluate(node => node.contains(document.activeElement)), 'Tab must be trapped in modal');
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('title')), '设置');
  await page.getByRole('button', { name: '新建对话', exact: false }).first().click();
  await modalCheck(page, 'new-conversation-short-window');
  await screenshot(page, 'new-conversation-short-window');
  await page.keyboard.press('Escape');
  await page.getByTitle('管理会话 Agent', { exact: true }).click();
  await modalCheck(page, 'team');
  await screenshot(page, 'team');
  await page.keyboard.press('Escape');
  await page.getByTitle('会话文件', { exact: true }).click();
  await modalCheck(page, 'files');
  await screenshot(page, 'files');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await modalCheck(page, 'search');
  await screenshot(page, 'search');
  await page.keyboard.press('Escape');
  await page.getByTitle('Artifact Workspace', { exact: true }).click();
  await page.getByTitle('版本历史', { exact: true }).click();
  await page.getByRole('tab', { name: '对比', exact: true }).click();
  await modalCheck(page, 'version-compare');
  await screenshot(page, 'version-compare');
  await page.keyboard.press('Escape');
  await page.locator('.ui-right-pane').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('文档内容').fill('Edited content that must not be lost');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await modalCheck(page, 'artifact-unsaved');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('文档内容').inputValue(), 'Edited content that must not be lost');
  await page.getByTitle('关闭预览', { exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.locator('.ui-right-pane').waitFor({ state: 'detached' });
  await page.locator('#message-ui_message_15').getByRole('button', { name: /工具调用 × 2/ }).click();
  await page.locator('#message-ui_message_15').getByText('读取文件', { exact: true }).waitFor();
  await page.locator('#message-ui_message_15').getByText('询问用户', { exact: true }).waitFor();
  await page.getByTitle('Artifact Workspace', { exact: true }).click();
  const resize = page.getByRole('separator', { name: '调整 Artifact Workspace 宽度' });
  const originalWidth = (await page.locator('.ui-right-pane').boundingBox()).width;
  await resize.focus();
  await page.keyboard.press('ArrowRight');
  const smallerWidth = (await page.locator('.ui-right-pane').boundingBox()).width;
  assert(smallerWidth < originalWidth, 'Keyboard resizing must change actual pane width');
  await page.route('**/workspace-files?**', route => route.fulfill({ json: route.request().url().includes('read=1') ? { content: '# Workspace acceptance\n\nNo stale scroll position.', truncated: false } : { entries: [{ name: 'acceptance.md', type: 'file' }] } }));
  await page.getByTitle('工作区文件', { exact: true }).click();
  await page.getByTitle('刷新文件树', { exact: true }).click();
  await page.getByRole('button', { name: 'acceptance.md', exact: true }).click();
  await page.getByText('Workspace acceptance', { exact: false }).waitFor();
  await page.locator('.ui-chat').getByRole('button', { name: '对话', exact: true }).click();
  const chatScroll = page.locator('.ui-chat .overflow-y-auto').first();
  assert(await chatScroll.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 125), 'Returning from a file must keep the chat at the bottom');
  await page.getByTitle('上下文统计与压缩', { exact: true }).click();
  await page.getByRole('dialog', { name: '上下文统计', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.route('**/api/context-trace/by-run/ui_trace_run', route => route.fulfill({ json: { attempt: { attemptId: 'ui_trace_attempt' } } }));
  await page.route('**/api/context-trace/ui_trace_attempt', route => route.fulfill({ json: {
    attempt: { attemptId: 'ui_trace_attempt', taskId: 't1', agentId: agent.id, executionStatus: 'complete', verificationStatus: 'verified', contextSnapshotId: null },
    snapshot: null, upstreamInputs: [], includedManifest: [], omittedManifest: [], evidence: [], verdicts: [], outputBindings: [], warnings: []
  } }));
  await page.locator('#message-ui_message_15').getByTitle('上下文追踪', { exact: true }).click();
  await modalCheck(page, 'trace-drawer');
  await screenshot(page, 'trace-drawer');
  await page.getByRole('tab', { name: '证据 0', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.close();
  for (const width of [1440, 390]) {
    const page = await newPage(width, 800, true);
    await page.getByText('编排计划待审批', { exact: true }).waitFor();
    await screenshot(page, `${width}-decisions`);
    await noOverflow(page, `${width}-decisions`);
    await page.getByTitle('关闭预览', { exact: true }).click();
    await screenshot(page, `${width}-decisions-panel-closed`);
    const submitted = [];
    await page.route('**/api/pending-questions/ui_question/answer', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.route('**/api/dispatch-plans/ui_plan/resolve', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.route('**/api/pending-bash/ui_bash/resolve', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.route('**/api/pending-writes/ui_write/resolve', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); });
    await page.getByLabel('选择待处理事项', { exact: true }).selectOption('question:ui_question');
    await page.getByRole('button', { name: '完整流程', exact: true }).click();
    await page.getByLabel('还有哪些验收要求？').fill('无横向溢出，保留任务证据');
    const answerResponse = page.waitForResponse(response => response.url().endsWith('/ui_question/answer'));
    await page.getByRole('button', { name: '提交回答', exact: true }).click();
    await answerResponse;
    await page.evaluate(event => window.uiEventSource.onmessage(new MessageEvent('message', { data: JSON.stringify(event) })), { type: 'ask_user.answered', conversationId: conversation.id, timestamp: now, pendingId: 'ui_question', answers: submitted[0].answers });
    await page.getByText('需要你的选择', { exact: true }).waitFor({ state: 'detached' });
    await page.getByLabel('选择待处理事项', { exact: true }).selectOption('plan:ui_plan');
    const planSurface = page.locator('.ui-decision').filter({ hasText: '编排计划待审批' });
    const planResponse = page.waitForResponse(response => response.url().endsWith('/ui_plan/resolve'));
    await planSurface.getByTitle('批准执行', { exact: true }).click();
    await planResponse;
    assert(await planSurface.getByTitle('批准执行', { exact: true }).isDisabled(), 'Resolved plan stays disabled until its stream event');
    await page.evaluate(event => window.uiEventSource.onmessage(new MessageEvent('message', { data: JSON.stringify(event) })), { type: 'dispatch.plan.resolved', conversationId: conversation.id, timestamp: now, pendingId: 'ui_plan', runId: 'ui_run', approved: true });
    await page.getByText('编排计划待审批', { exact: true }).waitFor({ state: 'detached' });
    await page.getByLabel('选择待处理事项', { exact: true }).selectOption('bash:ui_bash');
    const bashResponse = page.waitForResponse(response => response.url().endsWith('/ui_bash/resolve'));
    await page.getByTitle('拒绝执行', { exact: true }).click();
    await bashResponse;
    assert(await page.getByTitle('拒绝执行', { exact: true }).isDisabled(), 'Resolved command stays disabled until its stream event');
    await page.getByLabel('选择待处理事项', { exact: true }).selectOption('write:ui_write');
    await page.getByRole('button', { name: '查看修改差异', exact: true }).click();
    await page.getByText('export const ready = true;', { exact: false }).waitFor();
    await noOverflow(page, `${width}-file-diff`);
    const writeResponse = page.waitForResponse(response => response.url().endsWith('/ui_write/resolve'));
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await writeResponse;
    await page.evaluate(event => window.uiEventSource.onmessage(new MessageEvent('message', { data: JSON.stringify(event) })), { type: 'fs_write.resolved', conversationId: conversation.id, timestamp: now, pendingId: 'ui_write', applied: true });
    assert.equal(submitted.length, 4);
    assert.equal(submitted[1].action, 'approve');
    assert.equal(submitted[2].approved, false);
    assert.equal(submitted[3].approved, true);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Runtime page errors');
  await fs.writeFile(`${output}/results.json`, JSON.stringify({ results, errors, checkedAt: new Date().toISOString() }, null, 2));
  console.log(`Passed ${results.length} responsive/theme combinations plus modal and pending-state checks. Screenshots: ${output}`);
} finally {
  await browser.close();
}
