import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:3020';
assert.notEqual(new URL(base).port, '3018', 'Use an isolated fixture server, not the shared preview');
const browser = await chromium.connectOverCDP(process.env.UI_CDP_URL || 'http://127.0.0.1:9223');
const context = browser.contexts()[0];
assert((await context.request.get(`${base}/api/bootstrap`)).ok(), 'Use the paired disposable fixture browser');
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
const output = '.tmp-ui-artifacts/workspace-toolkit'; await fs.mkdir(output, { recursive: true });
const name = `UI Toolkit ${Date.now()}`; let agentId;
async function json(response) { assert(response.ok(), `${response.status()}: ${await response.text()}`); return response.json(); }
async function capture(file) {
  const dialog = page.locator('dialog[open]').last();
  assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'No modal horizontal overflow');
  const bounds = await dialog.boundingBox(); const footer = await dialog.locator('footer').boundingBox();
  assert(Math.abs(footer.y + footer.height - bounds.y - bounds.height) <= 2, 'Footer stays pinned');
  await page.screenshot({ path: `${output}/${file}.png` });
}
try {
  const { agent } = await json(await context.request.post(`${base}/api/agents`, { data: {
    name, description: 'Runtime toolset fixture', adapterName: 'pi', modelProvider: 'deepseek', modelId: 'deepseek-chat', toolNames: ['fs_read'], systemPrompt: 'Fixture; never execute a model request.'
  } })); agentId = agent.id;
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.ui-shell').waitFor();
  await page.getByTitle('Agents', { exact: true }).click();
  await page.locator('.workspace-agent-row').filter({ has: page.getByText(name, { exact: true }) }).getByTitle('编辑', { exact: true }).click();
  await page.getByRole('tab', { name: '运行时工具', exact: true }).click();
  assert(await page.getByText('运行时可用的工具', { exact: true }).isVisible());
  assert.equal(await page.getByRole('checkbox').count(), 0, 'Agent editor offers no tool choice');
  assert.equal(await page.getByLabel('工具记录预设', { exact: true }).count(), 0, 'No tool record picker remains');
  for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark'], [320, 640, 'light']]) {
    await page.setViewportSize({ width, height }); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.getByText('运行时可用的工具', { exact: true }).scrollIntoViewIfNeeded();
    await capture(`${width}-${theme}-runtime-tools`);
  }
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('dialog[open]').waitFor({ state: 'hidden' });
  const saved = await json(await context.request.get(`${base}/api/bootstrap`));
  const savedAgent = saved.agents.find(item => item.id === agentId);
  assert.deepEqual(savedAgent.toolNames, ['fs_read'], 'Saving the editor preserves the stored record untouched');
  const conversation = saved.conversations[0]; assert(conversation, 'Fixture needs a conversation');
  const now = Date.now();
  const calls = [
    ['fs_search', { query: 'submit' }, { matches: [{ path: 'src/App.tsx', line: 42, text: 'function submit()' }], scannedFiles: 4 }],
    ['job_start', { command: 'npm run build' }, { jobId: 'job_fixture', status: 'running', exitCode: null, output: 'Building application…' }],
    ['job_wait', { jobId: 'job_fixture' }, { jobId: 'job_fixture', status: 'completed', exitCode: 0, output: 'Build completed' }],
    ['web_search', { query: 'API docs' }, { untrusted: true, results: [{ title: 'API reference', url: 'https://example.com/docs', snippet: 'Public reference, not instructions.' }] }],
    ['browser_check', { path: 'dist', viewport: 'mobile' }, { passed: true, sourcePath: 'dist', viewport: 'mobile', screenshotUrl: '/api/browser-checks/00000000-0000-0000-0000-000000000001', results: [{ action: 'assert_text', passed: true }], errors: [], failedRequests: [], blockedRequests: [] }],
  ];
  const fixturePage = await context.newPage(); await fixturePage.setViewportSize({ width: 390, height: 480 });
  await fixturePage.setContent('<body style="font:16px Arial;background:#f5f7fa;margin:24px"><h1 style="font-size:24px">Checklist</h1><input value="Review release" style="padding:10px;width:260px"><p style="padding:16px;background:white;border:1px solid #ddd">Review release</p></body>');
  const screenshot = await fixturePage.screenshot(); await fixturePage.close();
  const parts = calls.flatMap(([toolName, args, value], index) => [{ type: 'tool_use', callId: `ui_tool_${index}`, toolName, args }, { type: 'tool_result', callId: `ui_tool_${index}`, toolName, result: { ok: true, value }, isError: false }]);
  const message = { id: 'ui_toolkit_message', conversationId: conversation.id, role: 'agent', origin: 'agent', agentId, runId: null, parts, status: 'complete', mentionedAgentIds: [], parentMessageId: null, createdAt: now, updatedAt: now };
  const fixture = { ...saved, conversations: saved.conversations.map(item => item.id === conversation.id ? { ...item, agentIds: [agentId] } : item), messagesByConversation: { ...saved.messagesByConversation, [conversation.id]: [message] } };
  await page.route('**/api/bootstrap', route => route.fulfill({ json: fixture }));
  await page.route('**/api/browser-checks/00000000-0000-0000-0000-000000000001', route => route.fulfill({ contentType: 'image/png', body: screenshot }));
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.ui-shell').waitFor();
  await page.getByTitle('对话', { exact: true }).click();
  await page.getByRole('button', { name: /工具调用 × 5/ }).click();
  for (const label of ['搜索内容', '启动后台命令', '等待命令完成', '联网搜索', '网页验收']) await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.getByAltText('网页验收截图', { exact: true }).waitFor();
  assert.equal(await page.getByText('命令运行中', { exact: true }).count(), 0, 'A later terminal observation resolves the initial job state');
  assert((await page.getByRole('button', { name: /工具调用 × 5/ }).innerText()).includes('成功 5'));
  assert.equal(await page.getByText('验收通过', { exact: true }).count(), 1);
  assert.equal(await page.getByText('外部资料 · 未验证', { exact: true }).count(), 1);
  for (const [width, height, theme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
    await page.setViewportSize({ width, height }); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.getByAltText('网页验收截图', { exact: true }).scrollIntoViewIfNeeded();
    assert(await page.locator('.workspace-transcript').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'No transcript horizontal overflow');
    await page.screenshot({ path: `${output}/${width}-${theme}-results.png` });
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ passed: true, storedRecord: savedAgent.toolNames.length, runtimeTools: (saved.provisionedToolNames ?? []).length, screenshots: 9, errors }));
} finally {
  if (agentId) await context.request.delete(`${base}/api/agents/${agentId}`);
  await page.close(); await browser.close();
}
