# DFSC 记忆中枢（memory-hub）设计

2026-11-23 · 状态：待批准

## 意图与为什么

DFSC 的会话默认记不住上一次的事：换会话就清零，跨天更是全新开始。OMP 用 `retain` / `recall` /
`reflect` / `memory_edit` 让代理自己维护项目记忆，每次会话开局注入「心智模型」，用得越久越懂这个仓库。

用户要的是同一种手感：插件装好之后，代理自己记得项目怎么分工、哪些文件是雷区、上次为什么选了方案二，
并且这些记忆会随时间合并、强化、淘汰，而不是一个只进不出的日志。

## 目标 / 非目标 / 反目标

**目标**
- 代理在会话里主动写记忆、按需召回，召回结果直接影响它下一步做什么。
- 记忆自己会进化：写入自动去重合并；每次召回给被用到的条目加权；长期没人用的自动归档；被推翻的条目失效而不是删除。
- 零配置：装上就能用，按项目自动分库，不需要用户填路径、填 Key、配模型。
- 数据只在本地，纯文本可审计，用户能人工打开看、能一键清空。

**非目标**
- 不做向量检索、不下载 embedding 模型、不连任何服务器。
- 不调用模型做摘要——插件进程拿不到宿主模型 Key，这条路由不走。
- 不写宿主侧新能力，不改 DFSC 核心，不依赖新版本构建。
- 不把记忆吹成「安全存储」：它就是一个本地 JSON 文件。

**反目标（做成了也算失败）**
- 记忆变成一份越长越糊的流水账，召回十条有八条是废话。
- 静默丢数据：没有告知就删条目的方案一律不通过。
- 偷偷把密钥、token、个人路径写进记忆文件。

## 约束（来自 DFSC 宿主与市场）

- 插件可挂载面只有 skills / commands / agents / MCP server；**没有 hooks**，拿不到会话开始与结束事件。
  因此「开局注入」「会话结束压缩」必须由代理按技能与命令执行，不能自动触发。
- MCP server 的工作目录被锚定到插件安装目录，**不是用户项目**；也不能从环境变量拿到项目路径。
- 插件进程拿不到宿主模型凭据（MCP 凭据默认隔离），不能自己调模型。
- 市场收录要求从固定上游提交同步资源副本，不能手改 `plugins/`；插件ID、元数据、许可证都要齐。

## 方案比较

**A. 代理驱动的工具集 + 确定性进化（选定）**
MCP 提供 `retain` / `recall` / `reflect` / `memory_edit` 等工具；去重合并、命中加权、衰减归档、
失效替代由服务器代码完成，不需要模型。代理通过技能知道「什么时候该召回、什么时候该巩固」，
通过 `/memory` 命令手动巩固。
代价：开局不会自动注入，得靠技能提示代理先 recall 一次。收益：零额外成本、不依赖新宿主、可离线验收。

**B. 全自动后台巩固**
最接近 OMP 原版，但需要宿主模型 broker（新构建 + 用户逐项授权）或用户自配独立 Key，
且没有会话结束事件仍要轮询会话文件。成本、失败面、审核风险都高一个量级。

**C. 只做 retain / recall**
最轻，但「自进化」只剩检索加权，记忆会单调增长直到糊掉。

选 A：现在就能落地，进化机制真实存在且可测，B 以后想加也只是在 A 之上补一个调用方。

## 关键设计决定

### 1. 项目归属：三级解析

MCP 进程不知道自己在哪个项目里，所以按顺序解析：

1. 工具参数 `project`（绝对路径）——代理最清楚当前工作区，命令与技能都要求优先传；
2. 环境变量 `MEMORY_HUB_PROJECT`——给自动化与测试用；
3. 自动探测：读 `~/.stepcode/agent/sessions/` 下**最近修改**的会话文件第一行，取它的 `cwd`
   （此刻正在写的会话就是最新的）。损坏或缺失时回退到 `_default`。

`stats` 会回报本次解析结果与来源（`arg` / `env` / `session` / `fallback`），归属错了当场看得见。

### 2. 存储：项目分库的单文件 JSON

```
~/.stepcode/agent/memories/
  --D--AgentPrograms-DFSC-Plugin--/
    memory.json          # 版本化、人可读
  _global/
    memory.json          # 跨项目的用户偏好
```

- 目录名沿用 DFSC 会话目录的 slug 规则（路径里非字母数字一律折成 `-`，前后加 `--`），
  这样用户找记忆和找会话是同一个习惯。
- 单文件而不是 SQLite：零依赖、能直接打开看、能进 git 备份；600 条上限时体积约 600 KB。
- 写入走「锁文件 + 读-改-写 + 同目录原子替换」，读路径绝不改文件（损坏文件的备份只在写路径做）。
- 损坏时备份成 `memory.json.corrupt-<时间戳>` 再从空库重建，`stats` 会标记 `corrupt: true`。

### 3. 记忆模型

每条记录：

```json
{
  "id": "m_1a2b3c4d",
  "type": "fact | decision | lesson | preference | pitfall",
  "text": "一句话，最长 2000 字符",
  "tags": ["构建", "测试"],
  "importance": 0.6,
  "status": "active | invalidated | archived",
  "createdAt": "2026-11-23T10:00:00.000Z",
  "updatedAt": "...",
  "hits": 3,
  "lastHitAt": "...",
  "source": "session:01a2... 或 manual",
  "supersedes": "m_...",
  "supersededBy": "m_..."
}
```

类型分工：`fact` 客观事实（技术栈、目录约定）、`decision` 决策与理由、`lesson` 可复用做法、
`preference` 用户口味与规范、`pitfall` 踩过的坑。写成什么类型影响它被召回的权重与排序分组。

### 4. 进化机制（全部确定性，无模型）

| 机制 | 触发 | 行为 |
| --- | --- | --- |
| 去重合并 | 每次 `retain` | 归一化文本相同，或词元余弦相似度 ≥ 0.82：并入旧条目，取较高 importance，命中数相加，刷新 `updatedAt`，返回 `action: "merged"` |
| 命中强化 | 每次 `recall` | 被返回的条目 `hits += 1`、`lastHitAt` 刷新；有效权重 `min(1, importance + 0.05·ln(1+hits))` |
| 衰减归档 | 每次写操作 | `active` 且 `hits == 0` 且超过 60 天 → `archived`（留在文件里，默认召回不再返回） |
| 矛盾处理 | `memory_edit invalidate` | 旧条目 `status: invalidated` 并记 `supersededBy`；不删除，历史仍可查 |
| 容量淘汰 | 写操作超过上限 | 按有效权重从低到高归档，把归档条数写进返回值，不静默丢 |

上限：项目库 600 条 active，全局库 300 条；单条文本 2000 字符，标签最多 8 个、每个 32 字符。

召回打分：

```
score = 0.45·文本相似 + 0.25·有效权重 + 0.20·时间新近 + 0.10·标签命中
```

中文没有空格，词元按「英文/数字整词 + 中文相邻二字组」切分，再用余弦相似度。

### 5. 工具契约（MCP，server 名 `memory`）

| 工具 | 输入 | 输出要点 |
| --- | --- | --- |
| `retain` | `text`（必填）、`type`、`tags`、`importance`、`scope`、`project`、`source` | `{ok,id,action,bank,total,evicted}` |
| `recall` | `query`、`type`、`tags`、`limit(1–20)`、`scope(project/global/all)`、`project` | 条目数组 + 分值 + 库信息 |
| `reflect` | `question`、`limit`、`project` | 按类型分组的证据包 + 冲突条目 + 统计；**明示是组装不是生成** |
| `memory_edit` | `op(update/invalidate/restore/forget/archive)`、`id`、`text`、`importance`、`tags`、`replacementId`、`project` | 变更后条目或 `not_found` |
| `stats` | `project`、`verbose` | 各类型/状态计数、上限、热门标签、可归档数、损坏标记、解析来源、存储路径 |
| `history_digest` | `sessions(1–10)`、`maxChars(1000–60000)`、`project` | 最近若干会话的压缩正文，供代理巩固时当素材 |
| `memory_purge` | `scope`、`confirm: "DELETE"`、`project` | 移到 `.trash-<时间戳>.json` 而不是直接删除 |

`recall` 会写命中计数，这是强化机制，属于有意的副作用，文档里写明。
`history_digest` 只读、严格限长，跳过子代理会话文件，正文同样过密钥脱敏。

### 6. 密钥脱敏

写入与输出的文本都过一遍规则：`sk-…`、`ghp_…`、`github_pat_…`、`Bearer <token>`、
`API_KEY=…` 一类赋值、32 位以上连续十六进制/Base64、PEM 私钥块。命中替换成 `[redacted]`，
`retain` 返回值带 `redacted: n`，让代理知道有内容被抹掉。

### 7. 技能与命令（代理真正读的那一层）

- `memory-recall` 技能：说明何时必须召回（用户提到「上次/之前/我们说好的」、开工前确认约定、
  选择实现路线）、如何把召回结果当启发而不是事实、怎么引用条目 id。
- `memory-curate` 技能：巩固流程——`history_digest` 取素材 → 先 `recall` 查重 → 分批 `retain`
  （一轮最多 12 条）→ `memory_edit invalidate` 推翻旧结论 → `stats` 复核上限。禁止凭空编造。
- `/memory` 命令：`load` / `save <内容>` / `consolidate` / `stats` / `clear` 分派。
- `/remember <一句话>` 命令：快速写一条事实。

### 8. 图标、元数据与市场路径

- 独立仓库 `D:\AgentPrograms\dfsc-memory-hub`，资源目录 `plugins/memory-hub`，MIT，
  作者 `Niangaol`；`dfsc.plugin.json` 声明 `requirements.dfsc >= 0.6.0`、外部依赖 Node.js ≥ 18。
- 图标：128×128 PNG，圆角底 + 记忆芯片线条，容量 ≤ 128 KiB。
- 市场收录放在本地验证通过之后：先推上游仓库拿到完整提交，再在 `DFSC Plugin` 仓库登记
  `registry.json`、写 `docs/plugins/memory-hub.md`、跑同步与校验。**不直接写 `plugins/` 绕过审核。**

## 测试策略

`node --test`，全部使用临时目录与临时 HOME，不触真实记忆、不发网络、不调模型：

1. 存储层：并发两进程交替写互不覆盖；读路径不改文件；损坏文件备份重建；上限淘汰不静默。
2. 进化：重复写入合并而不是新增；召回升权；60 天无命中归档；失效条目默认不返回。
3. 项目解析：参数 > 环境 > 会话探测 > 回退；slug 与 DFSC 会话目录一致；Windows 路径正确。
4. 脱敏：各类密钥被替换且原值不出现在文件里。
5. 协议：`initialize` / `tools/list` / `tools/call` / 未知方法 -32601 / stdout 只有 JSON-RPC。
6. 摘要：超长会话被截断而不是整段读入；子代理会话被跳过。

真实宿主验收（DFSC 安装、`/mcp` 挂载、技能加载）需要一次手动安装，单独记录，不与静态测试混写。

## 留给实现者的

- 排序权重、合并阈值、衰减天数这些常数先按本文取值，写进代码常量并标注，之后可调。
- 中文分词只做二元组，不加词典。
- `reflect` 的分组排版按类型固定顺序输出，不做花活。

## 明确不做的

- 不做桌面入口（`desktop`），避免要求新宿主构建。
- 不做自动注入 system prompt 的「心智模型」文件：没有会话开始事件，做成用户要手动点的开关不如不做，
  改由 `memory-recall` 技能在开局提示代理调用。
- 不做跨设备同步、不做加密存储、不做记忆评分榜。
