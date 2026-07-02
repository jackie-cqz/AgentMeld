# Spec 16 — 消息全文搜索

> 目标：在 AgentMeld 内提供一个跨会话的消息全文搜索能力。用户通过 ⌘K 命令面板输入查询，命中后能跳转到对应消息并短暂高亮。
>
> **关键决策（已定）**：
> - 搜索范围：**仅 `text` 类型 MessagePart**（不含 thinking、tool_use、tool_result、artifact 内容；后续可按需扩展触发器 WHERE 条件一行）
> - 索引方案：**SQLite FTS5 虚拟表 + DB 触发器同步**（已在本地验证 `ENABLE_FTS5=1` 可用，`trigram` tokenizer 支持中英文）
> - 中文短词（< 3 中文字符）：走 **LIKE 兜底**（snippet 不带高亮，换取"短词也能搜"）

> **实现状态（2026-06-18）**：已实现。FTS 表、触发器与幂等回填位于 `src/db/bootstrap.ts`；服务/API 位于 `src/server/search-service.ts`、`src/app/api/search/route.ts`；搜索状态沿用规范化 `app-store`；UI 位于 `src/components/global-search.tsx`，消息锚点与高亮位于 `src/components/chat-panel.tsx`。

---

## 1. 定位

当前 AgentMeld 缺少在历史会话中定位内容的能力：
- Sidebar 顶部的 search input 只按**会话标题**做 `includes` 过滤，不进 message 内部
- 用户要找回"上周关于渲染管线的那段讨论"必须手动翻会话
- 随着使用时长增加（1k–50k 消息区间），这变成高频痛点

本 spec 加一个**全文搜索层**，不动 message schema、不动 LLM 上下文、纯增量。

---

## 2. 目标与非目标

### 目标

- 用户按 `⌘K` 唤起全局搜索弹窗，输入关键词
- 200ms 内（1k messages 库）看到跨所有会话的命中结果
- 命中结果含：会话标题、发送者（用户/Agent 名+头像）、时间、上下文片段（命中词 `<mark>` 高亮）
- 点击命中结果：跳转到该会话 → 滚到对应消息 → 2 秒高亮闪烁
- 支持中英文混合：英文按词 + `*` 前缀；中文按 trigram 子串；中文 < 3 字走 LIKE 兜底
- 可选过滤：限定单会话 `?conversationId=xxx`、按角色 `?role=user|agent`

### 非目标

- 不搜索 `thinking` / `tool_use` / `tool_result` / artifact 文件内容
- 不做拼写纠错、语义搜索、向量检索
- 不跨用户、不做权限隔离（本地单用户场景）
- 不暴露 FTS5 原始语法给用户（只透出 `*` 前缀 + 短语引号）
- 不做搜索结果缓存（每次实时查 FTS5，1k–50k 规模够快）

---

## 3. 用户场景

| 场景 | 行为 |
|---|---|
| 找回讨论细节 | "上周那个关于渲染管线的讨论在哪" → ⌘K → 输入"渲染管线" → 看到 3 个会话各命中几条 → 点开看 |
| 找回代码片段 | "Claude 帮我写过那个 debounce 函数" → ⌘K → 输入"debounce" → 直接看到代码片段上下文 |
| 在当前会话内搜 | "这段长对话里我刚才说的'切换模型'在哪里" → 不切会话（暂时不暴露此入口；可后续加 "搜索本会话" toggle） |
| 模糊中文 | ⌘K → 输入"模型"（2 字）→ 走 LIKE 兜底，结果多；输入"模型切"（3 字）→ 走 FTS5，结果带高亮 |

---

## 4. 架构

### 4.1 改动一览

| 层 | 改动 | 文件 |
|---|---|---|
| L1 DB | 加 `messages_fts` 虚拟表 + 3 触发器 + 迁移 | `src/db/migrate-add-message-search.ts` |
| L3 Service | 新 `search-service.ts`（纯函数） | `src/server/search-service.ts` |
| L3 API | 新 `/api/search` GET 路由 | `src/app/api/search/route.ts` |
| L4 Store | 新 `searchStore`（Zustand + Immer） | `src/stores/search-store.ts` |
| L5 UI | 顶栏触发器 + 弹窗 + 结果项 | `src/components/global-search.tsx` 等 |
| L5 Hook | debounce + 跳转定位 | `src/lib/search-hooks.ts` |
| L5 Chat | message 容器加 `id` 锚点；订阅 `highlightedMessageId` | `src/components/chat/` |

### 4.2 数据流

```
[user types in command palette]
  └─ searchStore.setQuery()
      └─ debounce 200ms
          └─ searchStore.runSearch()
              └─ GET /api/search?q=...&limit=20&offset=0[&conversationId=...][&role=...][&fallback=like]
                  └─ search-service.searchMessages()
                      ├─ short Chinese query → LIKE 路径
                      └─ otherwise          → FTS5 MATCH 路径
                          └─ SELECT ... bm25() + snippet() + JOIN conv/agent
                  └─ envelope { ok, data: { hits, total, tookMs } }
              └─ searchStore.setHits()

[user clicks a hit]
  └─ searchStore.jumpToHit(hit)
      ├─ closeSearch() (关弹窗)
      ├─ setActiveConversation(hit.conversationId)
      │   └─ ChatWindow 拉 messages
      │       └─ ChatMessage 监听 highlightedMessageId 变化
      │           └─ scrollIntoView({ block: 'center' })
      │           └─ 加 2s 高亮 class
      │           └─ 2s 后 clearHighlight()
```

### 4.3 关键边界

- `search-service.ts` 是**纯函数**，不知道 store / UI / 用户存在；可单测
- API 路由只做：zod 校验 → 调 service → 包 envelope；与其他 API 路由风格一致
- 跳转行为通过 `useAppStore` 的 `setActiveConversation` action 触发；UI 不直接调 `router.push` 加内部状态
- FTS5 同步是**纯 DB 层**（触发器），应用层不感知；这避免了"漏写一处导致索引漂移"

---

## 5. 数据模型

### 5.1 虚拟表

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  tokenize = 'trigram'
);
```

- 只索引 `content` 一列；其他字段通过 `messages.rowid` JOIN 拿
- `messages_fts.rowid` 与 `messages.rowid` 对齐（FTS5 约定）
- `trigram` tokenizer 对中英文子串都友好；3 字以上中文才能精准匹配（短词走 LIKE 兜底，见 §7.2）

### 5.2 三个触发器

**关键优化**：`WHEN new.status != 'streaming'` —— 流式中的消息**不**同步进 FTS（用户搜半截无意义，且避免流式期间反复触发；终态 `'complete'` / `'error'` / `'aborted'` 一次性同步）。

**实现细节**：`text` part 用 `GROUP_CONCAT(..., ' ')` 合并到单条 FTS 行。**原因**：FTS5 对 `rowid` 强制 UNIQUE 约束；同一 message 有 ≥ 2 个 text part 时直接 `INSERT ... SELECT` 会报 `constraint failed`。把全部 text part 拼成一个 content 字段后，1 个 message 对应 1 个 FTS 行，避免冲突。

**取舍**：snippet 可能跨越多个 part 边界（在 FTS5 snippet 视图里它们已合并成一整段）。对搜索结果展示可接受——用户关心的是"这段话在哪"，不关心 part 边界。

```sql
-- INSERT：仅当消息不在 streaming 状态
CREATE TRIGGER IF NOT EXISTS messages_fts_ai
AFTER INSERT ON messages
WHEN new.status != 'streaming'
BEGIN
  INSERT INTO messages_fts(rowid, content)
  SELECT new.rowid,
    (SELECT GROUP_CONCAT(json_extract(value, '$.content'), ' ')
     FROM json_each(new.parts)
     WHERE json_extract(value, '$.type') = 'text');
END;

-- UPDATE：先删后插，仅当消息不在 streaming 状态
CREATE TRIGGER IF NOT EXISTS messages_fts_au
AFTER UPDATE ON messages
WHEN new.status != 'streaming'
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, content)
  SELECT new.rowid,
    (SELECT GROUP_CONCAT(json_extract(value, '$.content'), ' ')
     FROM json_each(new.parts)
     WHERE json_extract(value, '$.type') = 'text');
END;

-- DELETE：级联清（无 WHEN 守卫，删除时总该清）
CREATE TRIGGER IF NOT EXISTS messages_fts_ad
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
```

注：`messages` 的 `onDelete: 'cascade'` 已经把 `conversations` 删除时连带清掉 messages，所以 `messages_fts_ad` 触发后 FTS 也会被清。

### 5.3 迁移

文件名：`src/db/migrate-add-message-search.ts`（与项目其他 `migrate-add-*.ts` 平级，不另开 migrations 目录）。

风格与现有迁移一致（参考 `migrate-add-conversation-pin.ts`）：

- 顶层脚本，运行时直接 `db.run(sql.raw(...))`
- 用 `safeRun(stmt, marker)` 工具函数 + try/catch 实现幂等
- DDL 用 `IF NOT EXISTS` 守卫；DML（回填）查重后跳过

内容顺序：
1. `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts ...`
2. `CREATE TRIGGER IF NOT EXISTS messages_fts_ai/au/ad ...` × 3
3. **回填**（只在 `messages` 表非空时执行）：

```sql
INSERT INTO messages_fts(rowid, content)
SELECT m.rowid, json_extract(value, '$.content')
FROM messages m, json_each(m.parts)
WHERE json_extract(value, '$.type') = 'text';
```

4. 输出 `console.log('done')`，与现有脚本风格一致

迁移必须**幂等**（重跑不报错、不重复插入）。

### 5.4 风险与边界

| 风险 | 应对 |
|---|---|
| `better-sqlite3` 是否带 FTS5 | 已验证 `PRAGMA compile_options` 含 `ENABLE_FTS5`；trigram 工作正常 |
| 流式消息反复 UPDATE 触发器 | 触发器带 `WHEN new.status != 'streaming'`，流式期间不触发；只在终态一次性同步 |
| 中文 2 字查询无匹配 | 走 LIKE 兜底路径（见 §7.2） |
| 回填大表慢 | 1k–50k 范围 < 1s；50k+ 才需分批 INSERT |

---

## 6. 共享类型

`src/shared/types.ts` 新增：

```ts
export interface SearchHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: 'user' | 'agent' | 'system'
  agentId: string | null
  agentName: string | null
  agentAvatar: string | null
  createdAt: number
  /** 已含 <mark>...</mark> 标签的 HTML 片段；FTS5 路径生成，LIKE 路径不含高亮 */
  snippetHtml: string
}
```

---

## 7. Service 层契约

### 7.1 `search-service.ts`

```ts
export interface SearchOptions {
  query: string
  limit?: number         // 默认 20，范围 1–100
  offset?: number        // 默认 0
  conversationId?: string  // 可选：限定单会话
  role?: 'user' | 'agent'  // 可选：按角色过滤
  /** 客户端判定为短中文时传 true，走 LIKE 兜底 */
  fallback?: 'like'
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  tookMs: number
}

export async function searchMessages(opts: SearchOptions): Promise<SearchResult>
export async function countSearchMatches(query: string): Promise<number>
```

行为：
- `query` 为空 / 只含空白 → 直接返回 `{ hits: [], total: 0, tookMs: 0 }`，不打 DB
- `query` 含 FTS5 非法语法 → try/catch 吞 `SQLITE_ERROR`，返回 `{ hits: [], total: 0, error: 'INVALID_QUERY' }`（错误通过 Result 类型变体表达，**不抛**）
- **FTS5 连字符陷阱**：用户输入含 `-`（如 `render-pipeline`）时，FTS5 会把连字符解释为 column-restricted 查询的语法（`no such column: pipeline`）。Service 层用 `maybeQuote(s)` 做**条件包裹**：
  - 含 `-` → `"render-pipeline"`（避免 column-ref）
  - 以 `*` 结尾 → 透传（让 FTS5 走 prefix 匹配 `render*`）
  - 含 `(` → 透传（让 FTS5 报语法错误，我们转成 `INVALID_QUERY`）
  - 其他 → 透传
  理由：plan 早期版本"全部用双引号包裹"是错的——会把 `render*` 变成字面 phrase，prefix 搜索失效；会把 `(unclosed` 错误地"修复"成合法 query，丢失 `INVALID_QUERY` 检测。LIKE 路径不需要这层处理（LIKE 是普通子串匹配）。
- `snippetHtml` 在 SQL 里生成（`snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)`），前端用 `dangerouslySetInnerHTML` 渲染；源头是用户自己的消息内容（不是 LLM 输出），XSS 风险低
- LIKE 兜底路径**不生成** `<mark>`（LIKE 没有 snippet 函数），snippet 是裸文本

### 7.2 LIKE 兜底 SQL

```sql
SELECT
  m.id, m.conversation_id, m.role, m.agent_id, m.created_at,
  substr(m.parts, max(1, instr(m.parts, ?) - 30), 80) AS snippet_html,
  c.title AS conversation_title,
  a.name AS agent_name,
  a.avatar AS agent_avatar
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
LEFT JOIN agents a ON a.id = m.agent_id
WHERE m.parts LIKE '%' || ? || '%'
  AND (? IS NULL OR m.conversation_id = ?)
  AND (? IS NULL OR m.role = ?)
ORDER BY m.created_at DESC
LIMIT ? OFFSET ?;
```

### 7.3 FTS5 主路径 SQL

```sql
SELECT
  m.id, m.conversation_id, m.role, m.agent_id, m.created_at,
  snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet_html,
  bm25(messages_fts) AS rank,
  c.title AS conversation_title,
  a.name AS agent_name,
  a.avatar AS agent_avatar
FROM messages_fts
JOIN messages m        ON m.rowid = messages_fts.rowid
JOIN conversations c   ON c.id = m.conversation_id
LEFT JOIN agents a     ON a.id = m.agent_id
WHERE messages_fts MATCH ?
  AND (? IS NULL OR m.conversation_id = ?)
  AND (? IS NULL OR m.role = ?)
ORDER BY rank
LIMIT ? OFFSET ?;
```

---

## 8. API 路由

`src/app/api/search/route.ts`：

```
GET /api/search?q=foo&limit=20&offset=0&conversationId=xxx&role=user&fallback=like
```

- zod schema 校验：
  - `q`: 必填，1–200 字符
  - `limit`: 1–100（默认 20）
  - `offset`: ≥ 0（默认 0）
  - `conversationId`: 可选 UUID
  - `role`: 可选字面量联合
  - `fallback`: 可选字面量 `'like'`
- 校验失败 → 400，envelope `{ ok: false, error: { code: 'INVALID_QUERY', message: '...' } }`
- 调 `searchMessages()`，包 envelope 返回：

```ts
{ ok: true, data: { hits: SearchHit[], total: number, tookMs: number } }
```

---

## 9. Store & UI

### 9.1 `searchStore`（Zustand + Immer）

```ts
interface SearchState {
  isOpen: boolean
  query: string
  hits: SearchHit[]
  total: number
  loading: boolean
  error: string | null
  highlightedMessageId: string | null

  openSearch: () => void
  closeSearch: () => void
  setQuery: (q: string) => void
  runSearch: () => Promise<void>   // 内部 debounce 200ms
  jumpToHit: (hit: SearchHit) => void
  clearHighlight: () => void
}
```

`runSearch` 内部判定策略（顺序）：
1. 如果 `query.trim().length < 2` → 清空 hits，不发请求
2. 计算查询中**中文字符数**（用 `/\p{Script=Han}/gu`）：
   - 中文字符数 < 3（如 "模型"、"render 渲染"、"ai 模"）→ 带 `fallback=like`（LIKE 对中英都能兜底，不会因中文太短而漏掉）
   - 中文字符数 ≥ 3 → 走 FTS5 路径
3. 简单规则：宁愿走 LIKE 兜底，**不**做"中英分词后分别查"的复杂逻辑

`jumpToHit` 内部：
- `closeSearch()`
- `setActiveConversation(hit.conversationId)`（已有 action）
- `setHighlightedMessageId(hit.messageId)`
- 2s 后 `clearHighlight()`

### 9.2 UI 组件

```
src/components/global-search.tsx           // 弹窗主组件
src/components/global-search-trigger.tsx   // 顶栏按钮 + ⌘K 监听
src/components/search-result-item.tsx      // 单条结果
src/components/message-highlight-layer.tsx // 在 ChatWindow 监听 highlightedMessageId
```

`<MessageList>` 渲染的每个 message 容器加 `id={`message-${msg.id}`}`，方便 `scrollIntoView` 定位；高亮通过临时 CSS class（2s 后移除）实现。

### 9.3 不动的东西

- Sidebar 现有的"按标题过滤" input 不动（行为不变，UI 可与新搜索共存）
- 任何 adapter / tool / conductor 路径不动
- 任何流式事件协议不动（search 是查询功能，不在事件总线里）

---

## 10. 错误处理

| 场景 | 表现 | 处理 |
|---|---|---|
| 极短查询（< 2 字符 或 中文 < 2 字） | 不发请求 | store 拦截，提示"输入更多字符" |
| 查询超长（> 200 字符） | 400 | API 校验，UI 限制 maxlength |
| FTS5 语法错误（`(`、`*` 误用） | service 吞错 | 返回 `INVALID_QUERY`，弹窗显示"搜索词无效"灰提示 |
| DB 不可用 | 500 | envelope 返回 INTERNAL，弹窗显示重试按钮 |
| 命中 0 条 | 正常 | 空态："未找到匹配消息" + 清除按钮 |
| LIKE 兜底命中 | 正常 | snippet 不带高亮，弹窗小字提示"短词搜索" |

---

## 11. 测试

| 层级 | 文件 | 关键 case |
|---|---|---|
| Unit: service | `src/server/search-service.test.ts` | 空 query、含特殊字符、超长、纯空格、参数边界 |
| Integration: 触发器 | `src/server/messages-fts-triggers.test.ts` | insert/update/delete 后 FTS 行数正确；多 text part 拆出多条；非 text part 忽略；**`status='streaming'` 时不触发**；`status` 从 streaming → complete 时一次性同步 |
| Integration: 搜索 | `src/app/api/search/route.test.ts` | 中文 3+ 字匹配；英文前缀 `render*`；`bm25` 排序；`snippetHtml` 含 `<mark>`；`conversationId` / `role` 过滤；分页；fallback=like 路径 |
| Integration: 回填 | `src/db/migrations/migration-backfill.test.ts` | 已有 N 条 messages 跑迁移后，FTS 行数 = N 条消息中 text part 总数 |
| E2E | `e2e/global-search.spec.ts`（Playwright） | ⌘K 唤起 → 输入 → 看到结果 → 点击 → 跳转到消息并高亮 → 2s 后高亮消失 |

目标：**80%+ 覆盖率**（service / api / 触发器 / 迁移是重点，UI 端 E2E 覆盖关键路径即可）。

---

## 12. 验收标准

- [x] ⌘/Ctrl+K 唤起弹窗，ESC 关闭
- [x] 输入使用 200ms debounce 后搜索
- [x] 结果含：会话标题 / 发送者 / 时间 / 上下文片段
- [x] 点击结果：跳转到正确会话 → 滚到正确消息 → 临时高亮
- [x] 中文 1–2 字走 LIKE 兜底，能搜到
- [x] 中文 3+ 字走 FTS5，带 `<mark>` 高亮
- [x] 英文 `render*` 前缀匹配工作
- [x] 英文精确短语匹配工作
- [x] `conversationId` 过滤生效
- [x] `role` 过滤生效
- [x] 启动时幂等回填已有终态消息
- [x] 现有 sidebar "按标题过滤" 功能不受影响
- [x] service / API / Store / trigger 回归测试通过
- [x] `pnpm typecheck` / `pnpm lint` 无错误

---

## 13. 不在本 spec 范围（后续可加）

- 搜索 `thinking` part：改触发器 WHERE 一行即可
- 搜索 artifact 文件内容：要扫文件 + 单独索引，复杂度高
- 搜索结果向量 / 语义检索：超本 spec 目标
- 按时间范围过滤：UI 后续按需加
- 高亮多关键词：snippet 函数支持，UI 配合调整
- "在本会话内搜索" toggle：UI 加 toggle → API 加 `conversationId` 默认值

---

## 14. 风险与决策记录

| 决策 | 备选 | 选定理由 |
|---|---|---|
| 触发器同步（DB 层） | 应用层同步 | 写路径多、流式 append 频繁，应用层同步容易漏；触发器锁在 DB 层零漂移 |
| 触发器带 `WHEN status != 'streaming'` | 无条件触发 | 流式期间不索引半截内容（也无意义）；终态一次性同步，省 N 次触发 |
| trigram tokenizer | unicode61 | 中文支持 trigram 唯一可行；英文子串搜索 trigram 也工作 |
| LIKE 兜底 | 双索引（unicode61 + trigram union） | 实现简单、边界清晰、UX 好；索引大小不翻倍 |
| 弹窗入口（⌘K） | 顶栏常驻 input / 独立页面 | ⌘K 是 Slack/Discord/Linear 既定惯例，不打断主流程；常驻 input 占空间 |
| 不索引 thinking | 索引 | 描述里说"仅 text part"是用户明确选的范围；扩到 thinking 是一行改动 |

---

## 15. 实现里程碑

实现阶段再细化。本 spec 落地后用 writing-plans 技能拆任务，预计大致阶段：

1. **DB 层**：写迁移 + 验证回填 + 触发器
2. **Service + API**：search-service + 路由 + zod + 单测
3. **Store**：searchStore + 短词 fallback 判定
4. **UI**：触发器 + 弹窗 + 结果项 + ChatWindow 锚点
5. **联调 + 验收**：E2E 跑通验收清单
