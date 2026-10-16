import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
assert.notEqual(new URL(base).port, '3018', 'Use the disposable fixture server');
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
const response = await context.request.get(`${base}/api/bootstrap`);
assert(response.ok(), 'Fixture browser must already be paired');
const bootstrap = await response.json();
const conversation = bootstrap.conversations[0];
const conductor = bootstrap.agents.find(agent => agent.isConductor) || bootstrap.agents[0];
const worker = bootstrap.agents.find(agent => !agent.isConductor) || conductor;
const now = Date.now();
const common = { conversationId: conversation.id, agentId: conductor.id, runId: 'polish_run', createdAt: now };
const question = { ...common, id: 'polish_question', questions: [
  { header: '验收范围', question: '先验证哪一部分？', options: [{ label: '完整流程' }, { label: '重点界面' }] },
  { header: '补充要求', question: '还有哪些验收要求？', options: [] }
] };
const plan = { ...common, id: 'polish_plan', plan: [{ id: 't1', agentId: worker.id, task: '检查页面布局、交互、验收证据与长任务恢复', dependsOn: [], acceptanceCriteria: ['构建通过', '小屏没有遮挡'] }] };
const write = { ...common, id: 'polish_write', path: 'src/App.tsx', oldContent: 'old', newContent: 'new' };
const command = { ...common, id: 'polish_bash', command: 'npm run build', cwd: 'workspace/app', reason: '验证构建' };
const artifacts = [1, 2].map(version => ({ id: `polish_art_${version}`, conversationId: conversation.id, createdByAgentId: worker.id, type: 'document', title: '验收清单', content: { type: 'document', format: 'markdown', content: `# 验收清单\n\n版本 ${version}\n\n- 保留草稿\n- 查看证据` }, version, createdAt: now, updatedAt: now }));
const calls = [
  ['job_start', { command: 'npm run build' }, { jobId: 'job_polish', status: 'running', exitCode: null }],
  ['job_wait', { jobId: 'job_polish' }, { jobId: 'job_polish', status: 'completed', exitCode: 0 }],
  ['browser_check', { path: 'dist' }, { passed: false, results: [], errors: ['Fixture assertion failed'], failedRequests: [], blockedRequests: [] }]
];
const message = { id: 'polish_message', conversationId: conversation.id, agentId: worker.id, role: 'agent', origin: 'agent', runId: 'polish_run', status: 'complete', mentionedAgentIds: [], parentMessageId: null, createdAt: now, updatedAt: now, parts: [
  { type: 'text', content: '构建已通过，网页验收发现一项需要继续处理的问题。' },
  ...calls.flatMap(([toolName, args, value], index) => [{ type: 'tool_use', callId: `polish_call_${index}`, toolName, args }, { type: 'tool_result', callId: `polish_call_${index}`, isError: false, result: { ok: true, value } }])
] };
const fixture = { ...bootstrap, messagesByConversation: { [conversation.id]: [message] }, artifactsByConversation: { [conversation.id]: artifacts } };
const trace = { attempt: { attemptId: 'polish_attempt', taskId: 't1', conductorRunId: 'polish_parent', executionStatus: 'reported_complete', verificationStatus: 'rejected', contextSnapshotId: 'polish_snapshot' }, snapshot: { tokenEstimate: 640 }, upstreamInputs: [], includedManifest: [], omittedManifest: [], evidence: [{ evidenceId: 'polish_ev', type: 'browser_checked', status: 'invalid', trustLevel: 'verified', subjectId: 'dist', subjectType: 'web_app', excerpt: '网页验收失败' }], verdicts: [{ id: 'v1', criterionId: 'ui-check', status: 'failed', reason: '需要处理验收问题', evidenceIds: ['polish_ev'] }], outputBindings: [], warnings: [] };
const output = '.tmp-ui-artifacts/workspace-polish'; await fs.mkdir(output, { recursive: true });
const errors = []; let screenshots = 0;
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', route => {
  const url = new URL(route.request().url());
  const json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/bootstrap') return json(fixture);
  if (url.pathname === '/api/stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\nretry: 60000\n\n' });
  if (url.pathname.endsWith('/pending-questions')) return json({ pendingQuestions: [question] });
  if (url.pathname.endsWith('/pending-dispatch-plans')) return json({ pendingDispatchPlans: [plan] });
  if (url.pathname.endsWith('/pending-writes')) return json({ pendingWrites: [write] });
  if (url.pathname.endsWith('/pending-bash-commands')) return json({ pendingBashCommands: [command] });
  if (url.pathname === '/api/context-trace/by-run/polish_run') return json({ attempt: { attemptId: 'polish_attempt' } });
  if (url.pathname === '/api/context-trace/polish_attempt') return json(trace);
  if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { error: 'Read-only UI fixture' } });
  return route.continue();
});
async function capture(name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name}: viewport overflow`);
  await page.screenshot({ path: `${output}/${name}.png` }); screenshots++;
}
async function decision(key) { await page.getByLabel('选择待处理事项', { exact: true }).selectOption(key); }
try {
  for (const [width, height, theme] of [[1440, 900, 'light'], [1024, 768, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light'], [1280, 420, 'light']]) {
    await page.setViewportSize({ width, height }); await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.ui-shell').waitFor();
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.getByTitle('对话', { exact: true }).click();
    await page.getByLabel('选择待处理事项', { exact: true }).waitFor();
    const group = page.getByRole('button', { name: /工具调用 × 3/ });
    assert((await group.innerText()).includes('成功 2 · 失败 1'));
    await group.click(); assert.equal(await page.getByRole('button', { name: /网页验收.*失败/ }).count(), 1);
    await decision('question:polish_question');
    await page.getByRole('button', { name: '完整流程', exact: true }).click(); await page.getByLabel('还有哪些验收要求？').fill('保留当前输入');
    await decision('plan:polish_plan'); await decision('question:polish_question');
    assert.equal(await page.locator('.decision-queue-content').evaluate(node => node.scrollTop), 0, 'Switching decisions starts at the item heading');
    assert.equal(await page.getByLabel('还有哪些验收要求？').inputValue(), '保留当前输入');
    assert.equal(await page.getByRole('button', { name: '完整流程', exact: true }).getAttribute('aria-pressed'), 'true');
    assert((await page.locator('.decision-queue').boundingBox()).height <= height * .30 + 65, 'Decision queue is bounded');
    await page.getByRole('button', { name: '收起待处理事项', exact: true }).click(); assert((await page.locator('.decision-queue').boundingBox()).height < 55);
    await page.getByRole('button', { name: '展开待处理事项', exact: true }).click();
    await decision('plan:polish_plan');
    await page.getByTitle('Artifact Workspace', { exact: true }).click();
    const right = page.locator('.ui-right-pane'); await right.waitFor();
    assert(await right.locator('.artifact-document').isVisible());
    await capture(`${width}-${height}-${theme}-workspace`);
    await page.getByTitle('关闭预览', { exact: true }).click();
    await page.locator('#message-polish_message').getByTitle('上下文追踪', { exact: true }).click();
    await page.getByLabel('上下文摘要', { exact: true }).waitFor();
    assert.equal(await page.getByText('已报告完成', { exact: true }).count(), 1);
    assert.equal(await page.getByText('polish_snapshot', { exact: true }).isVisible(), false);
    await page.getByRole('tab', { name: '证据 1', exact: true }).click();
    await page.getByRole('dialog', { name: '上下文追踪', exact: true }).getByText('网页验收', { exact: true }).waitFor(); await capture(`${width}-${height}-${theme}-trace`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await page.getByTitle('Agents', { exact: true }).click();
  await page.getByLabel('搜索 Agent', { exact: true }).fill(conductor.name); await page.getByRole('button', { name: '紧凑列表', exact: true }).click();
  assert.equal(await page.locator('.workspace-agent-row').count(), bootstrap.agents.filter(agent => `${agent.name} ${agent.description} ${agent.modelId ?? ''} ${agent.capabilities.join(' ')}`.toLowerCase().includes(conductor.name.toLowerCase())).length);
  await capture('agent-list');
  await page.getByLabel('搜索 Agent', { exact: true }).fill('no-such-agent-fixture'); await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  assert.equal(await page.locator('.workspace-agent-row').count(), bootstrap.agents.length);
  await page.getByTitle('新建 Agent', { exact: true }).click(); await page.getByRole('button', { name: /详细配置/ }).click();
  await page.getByRole('tab', { name: '工具记录', exact: true }).click();
  await page.getByLabel('搜索工具', { exact: true }).fill('fs_patch'); assert.equal(await page.getByRole('checkbox').count(), 2);
  await page.getByLabel('搜索工具', { exact: true }).fill('');
  await page.getByRole('checkbox', { name: '仅看已记录', exact: true }).check();
  for (const checkbox of await page.locator('.ui-tool-option input').all()) assert(await checkbox.isChecked());
  await capture('tool-filter');
  await page.getByRole('tab', { name: '模型与适配器', exact: true }).click(); await page.getByRole('button', { name: '供应商 *', exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Selection stays inside the Agent dialog');
  await page.getByLabel('搜索已配置供应商', { exact: true }).fill('no-such-provider'); await page.getByText('未找到匹配的供应商', { exact: true }).waitFor();
  await capture('inline-provider'); await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, screenshots, checks: ['decision-draft-retention', 'bounded-queue', 'tool-status-consistency', 'artifact-document', 'trace-summary', 'agent-filters', 'permission-filter', 'single-dialog-model-picker'], errors }));
} catch (error) { await page.screenshot({ path: `${output}/failure.png` }); throw error; }
finally { await page.close(); await browser.close(); }
