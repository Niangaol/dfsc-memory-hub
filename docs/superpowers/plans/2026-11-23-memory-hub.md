# memory-hub 实现计划

> **For agentic workers:** 按任务顺序执行，每个任务先写失败测试再实现。步骤用 `- [ ]` 跟踪。

**Goal:** 交付 DFSC 社区市场可收录的本地记忆插件 `memory-hub`：`retain` / `recall` / `reflect` / `memory_edit` 四工具 + 确定性进化（合并、强化、衰减、失效）。

**Architecture:** 零依赖 Node.js stdio MCP server。存储为按项目分库的 JSON 单文件，写入走锁 + 读-改-写 + 原子替换；进化逻辑全部是纯函数，独立于存储，便于单测。技能与命令是给代理的指令层，负责「什么时候写、什么时候取」。

**Tech Stack:** Node.js ≥ 18（`node:test`、`node:fs`、`node:readline`），无第三方依赖。

**Spec:** [2026-11-23-dfsc-memory-hub-design.md](../specs/2026-11-23-dfsc-memory-hub-design.md)

## Global Constraints

- 零第三方依赖；`package.json` 的 `dependencies` 必须为空。
- 不联网、不调用模型、不读凭据。
- 所有写盘路径在 `MEMORY_HUB_HOME` 之下（默认 `~/.stepcode/agent/memories`），测试必须能整体重定向。
- 文本上限 2000 字符；标签 ≤ 8 个、每个 ≤ 32 字符；项目库 600 条、全局库 300 条。
- 数值常数（合并阈值 0.82、衰减 60 天、强化系数 0.05）在 `evolve.mjs` 顶部集中声明。

## 文件结构

```
D:\AgentPrograms\dfsc-memory-hub\
  package.json                 # type: module, test 脚本
  LICENSE                      # MIT
  README.md                    # 用户向说明（同步时会作为市场说明覆盖）
  plugins/memory-hub/
    step.plugin.json           # 原生清单：id/version/skills/commands/mcpServers
    dfsc.plugin.json           # 展示声明：作者、dfsc 版本范围、外部依赖、分类
    icon.png                   # 128×128 PNG
    README.md
    server/
      memory-hub.mjs           # 协议层：MCP over stdio
      tools.mjs                # 工具定义与实现
      store.mjs                # 记忆语义层（retain/recall/edit/purge 编排）
      json-store.mjs           # 通用锁 + 原子读写（无业务语义）
      evolve.mjs               # 纯函数：相似度、打分、合并、衰减
      text.mjs                 # 归一化、分词、脱敏、截断
      project.mjs              # 项目解析与 slug
      digest.mjs               # 会话摘要
    skills/
      memory-recall/SKILL.md
      memory-curate/SKILL.md
    commands/
      memory.md
      remember.md
  tests/
    text.test.mjs
    project.test.mjs
    evolve.test.mjs
    json-store.test.mjs
    store.test.mjs
    digest.test.mjs
    protocol.test.mjs
    plugin-files.test.mjs
```

## 接口约定（跨任务共享）

```js
// text.mjs
export function normalize(s)                    // 折叠空白、小写、去首尾
export function tokens(s)                       // 英文/数字整词 + 中文二元组 -> string[]
export function cosine(aTokens, bTokens)        // number 0..1
export function redact(s)                       // { text, redacted }
export function clip(s, max)                    // string

// project.mjs
export function projectSlug(absPath)            // "--D--AgentPrograms-x--"
export function resolveProject({ project, env, sessionsRoot })  // { root, slug, source }

// evolve.mjs
export function effectiveWeight(memory, now)    // number
export function score(memory, query, now)       // number
export function findMergeCandidate(memories, candidate, threshold)  // memory | null
export function applyDecay(memories, now, days) // { archived: id[] }
export function evictOverflow(memories, cap)    // { evicted: id[] }

// json-store.mjs
export class JsonStore {
  constructor(file, { lockTimeoutMs, staleMs, log })
  read()          // 只读，失败返回 { data: null, corrupt: boolean }
  mutate(fn)      // 锁内读-改-写-原子替换；fn(data) 返回 { result, next }
}

// store.mjs
export class MemoryBank {
  constructor({ home, sessionsRoot, log })
  retain(input)            // { ok, id, action, bank, total, evicted, redacted }
  recall(input)            // { ok, bank, project, memories: [{...mem, score}] }
  reflect(input)           // { ok, question, groups, conflicts, stats }
  edit(input)              // { ok, status, memory? }
  stats(input)             // { ok, project, source, banks, storage }
  purge(input)             // { ok, movedTo, removed }
}

// digest.mjs
export function digestSessions({ sessionsRoot, slug, count, maxChars })  // { ok, sessions: [...], truncated }

// tools.mjs
export const TOOLS          // MCP tool definitions
export async function callTool(name, args, ctx)   // result object
export function createToolContext({ log, env })

// memory-hub.mjs: 协议层，stdout 只写 JSON-RPC
```

---

### Task 1: text.mjs

**Files:** Create `plugins/memory-hub/server/text.mjs`, `tests/text.test.mjs`

- [ ] **Step 1: 写失败测试** `tests/text.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tokens, cosine, redact, clip } from '../plugins/memory-hub/server/text.mjs';

test('normalize folds whitespace and case', () => {
  assert.equal(normalize('  Build   Uses\tpnpm\n'), 'build uses pnpm');
});
test('tokens keeps latin words and adds CJK bigrams', () => {
  assert.deepEqual(tokens('构建用 pnpm').slice(0, 3), ['构建', '建用', 'pnpm'].sort((a, b) => 0) || tokens('构建用 pnpm'));
  assert.ok(tokens('构建用 pnpm').includes('pnpm'));
  assert.ok(tokens('构建用 pnpm').includes('构建'));
});
test('cosine is 1 for identical token sets and 0 for disjoint', () => {
  assert.equal(cosine(tokens('alpha beta'), tokens('alpha beta')), 1);
  assert.equal(cosine(tokens('alpha'), tokens('beta')), 0);
});
test('redact removes common credential shapes', () => {
  const out = redact('key sk-abcdef123456 and ghp_0123456789abcdef');
  assert.equal(out.redacted, 2);
  assert.ok(!out.text.includes('sk-abcdef123456'));
  assert.ok(!out.text.includes('ghp_0123456789abcdef'));
});
test('clip keeps short text and marks long text', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('abcdefghijk', 5).length, 6);
});
```

- [ ] **Step 2: 跑测确认红** `node --test tests/text.test.mjs` → 模块不存在
- [ ] **Step 3: 实现** `text.mjs`：`normalize` 折叠空白、`tokens` 用 `/[\p{Script=Han}]/u` 切中文二元组 + `/[\p{L}\p{N}_-]+/u` 切拉丁词，`cosine` 用多重集合向量，`redact` 覆盖 `sk-`、`ghp_`、`github_pat_`、`Bearer`、`*_API_KEY=`、长 hex/base64、PEM，`clip` 超出加 `…`
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 2: project.mjs

**Files:** Create `plugins/memory-hub/server/project.mjs`, `tests/project.test.mjs`

- [ ] **Step 1: 写失败测试**：含 4 例——`projectSlug('D:\\AgentPrograms\\x')` 得 `--D--AgentPrograms-x--`；参数优先；env 次之；会话探测取**最新 mtime** 的 `.jsonl` 首行 `cwd`；全缺回退 `_default` 且 `source: 'fallback'`。会话探测用临时目录造两个文件，把较新的 mtime 设到目标上。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：`projectSlug` 把 `[^A-Za-z0-9]+` 折成 `-` 并首尾包 `--`；`resolveProject` 依赖注入 `sessionsRoot`，探测只读每个候选文件首行且限制 200 字节，找不到 `cwd` 跳过。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 3: evolve.mjs

**Files:** Create `plugins/memory-hub/server/evolve.mjs`, `tests/evolve.test.mjs`

- [ ] **Step 1: 写失败测试**：`effectiveWeight` 随 hits 增长但有上限；`findMergeCandidate` 归一化相同必合并、相似度低于阈值不合并；`applyDecay` 只归档 60 天无命中的 active 条目；`evictOverflow` 超限按有效权重淘汰最弱的并返回 id；`score` 对完全匹配查询高于无关查询。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：常数 `MERGE_THRESHOLD = 0.82`、`DECAY_DAYS = 60`、`HIT_BOOST = 0.05`、`PROJECT_CAP = 600`、`GLOBAL_CAP = 300`；`score` 权重 0.45/0.25/0.20/0.10，时间新近用 `1 / (1 + days/30)`。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 4: json-store.mjs

**Files:** Create `plugins/memory-hub/server/json-store.mjs`, `tests/json-store.test.mjs`

- [ ] **Step 1: 写失败测试**：写入后能读回；`read()` 对损坏文件返回 `corrupt: true` 且**不改文件**；`mutate` 在损坏时把原文件改名备份再重建；两个并发 `mutate` 都成功且最终包含两次改动；锁超时抛错。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：`wx` 建锁、15 秒陈旧锁接管、5 秒超时；`read` 用内容缓存比对；`mutate` 持锁读、`fn` 返回 `{ result, next }`，写 `.tmp` 后 `rename`。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 5: store.mjs

**Files:** Create `plugins/memory-hub/server/store.mjs`, `tests/store.test.mjs`

- [ ] **Step 1: 写失败测试**：retain 新增返回 `action: 'added'`；重复文本返回 `merged` 且条目数不变；recall 命中后 `hits` 增加；invalidate 后默认 recall 不返回、`scope: 'all', status: 'invalidated'` 能查到；restore 恢复；forget 需要 `confirm`；purge 把文件移到 `.trash-*`；密钥写入被脱敏且 `redacted > 0`；超过上限时 `evicted > 0` 且 active 数 ≤ 上限；`stats` 报出解析来源与路径。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：`MemoryBank` 负责选择库文件、加元数据、调 `evolve`；`retain` 同时尝试衰减与淘汰；`recall` 先打分过滤再写命中（一次 `mutate`）；`reflect` 纯读、按类型分组并标出同标签冲突项。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 6: digest.mjs

**Files:** Create `plugins/memory-hub/server/digest.mjs`, `tests/digest.test.mjs`

- [ ] **Step 1: 写失败测试**：跳过 `*subagent*.jsonl`；按 mtime 倒序取前 N 个；输出含 user/assistant 文本且被 `redact`；总长不超 `maxChars`，超出标 `truncated: true`；空目录返回空数组。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：流式按行读、单行 > 8 KB 跳过、累计超预算立即停。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 7: tools.mjs + memory-hub.mjs

**Files:** Create `plugins/memory-hub/server/tools.mjs`, `plugins/memory-hub/server/memory-hub.mjs`, `tests/protocol.test.mjs`

- [ ] **Step 1: 写失败测试**：起真实子进程走 stdio——`initialize` 返回 `serverInfo.name === 'memory-hub'`；`tools/list` 含 7 个工具且每个有 `inputSchema`；`tools/call retain` 成功；未知工具返回错误；未知方法 `-32601`；畸形 JSON 不崩；stdout 每行都能 `JSON.parse`。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 实现**：`TOOLS` 数组含 7 个定义；`createToolContext` 读 `MEMORY_HUB_HOME` / `MEMORY_HUB_PROJECT`；协议层照 `team-gate` 的形态（换行分隔 JSON-RPC 2.0、日志走 stderr、EPIPE 安静退出）。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 8: 插件资源与图标

**Files:** Create `step.plugin.json`、`dfsc.plugin.json`、`README.md`、`icon.png`、`skills/memory-recall/SKILL.md`、`skills/memory-curate/SKILL.md`、`commands/memory.md`、`commands/remember.md`，以及 `tests/plugin-files.test.mjs`

- [ ] **Step 1: 写失败测试**：清单 `id === 'memory-hub'`、`version` 符合 semver、`mcpServers.memory.args` 指向真实存在的文件、`skills`/`commands` 声明的目录存在且每个技能有 `name`/`description` frontmatter；`dfsc.plugin.json` 的 `categories` 在八类词表内、`requirements.external` 是非空数组且 URL 为 HTTPS；`icon.png` 是 PNG 且宽高 ≤ 512、≤ 128 KiB。
- [ ] **Step 2: 跑测确认红**
- [ ] **Step 3: 生成图标**：用 Node 手写 PNG 编码（无依赖），画 128×128 深底 + 亮色记忆块；`skills`/`commands`/清单按接口写。
- [ ] **Step 4: 跑测转绿**
- [ ] **Step 5: 提交**

### Task 9: 全套验证

- [ ] `node --test tests/` 全绿
- [ ] 手工冒烟：临时 `MEMORY_HUB_HOME` 下跑一次 `retain → recall → stats → purge`
- [ ] 按 CONTRIBUTING 逐条核对 `dfsc.plugin.json` 字段（作者、`dfsc` 范围、外部依赖说明）
- [ ] 记录未验证项：DFSC 实机安装、`/mcp` 挂载、市场同步

## Review Focus

- **代理传错 `project`**：传相对路径或带引号时是否仍解析出稳定 slug，还是悄悄落到 `_default`。
- **并发两个会话同时写**：锁失效或原子替换失败时是否报错而不是静默丢写。
- **记忆文件被人手工改坏**：`read` 是否只是报告而不清空，写路径是否备份后才重建。
- **密钥变体**：`sk-` 之外的 `AKIA…`、`-----BEGIN`、`*_SECRET=` 是否都被抹掉。
- **超长输入**：2000 字符以上文本、50 个标签、20000 字符查询是否被截断而不是整份写盘。
