# DFSC 记忆中枢（memory-hub）

本地、按项目分库、会自我进化的长期记忆。灵感来自 Oh My Pi 的 `retain` / `recall` /
`reflect` / `memory_edit`，但按 DFSC 的实际能力重做：**不依赖会话钩子、不调用模型、不联网**。

资源版本 **0.2.0**，许可证 MIT。

## 它解决什么

DFSC 的会话默认记不住上一次的事。装好之后，代理可以自己写下「这个仓库构建走 pnpm」
「上次放弃 SQLite 是为了零依赖」「Windows 上子进程测试偶发 EBUSY」，
下次开工前自己取回来，并且这些记忆会随时间合并、强化、淘汰。

## 和 OMP 的差别（以及为什么）

| OMP | 这里 | 原因 |
| --- | --- | --- |
| 会话结束自动压缩成心智模型 | `/memory consolidate` + `memory-curate` 技能 | DFSC 没有会话结束钩子，做不到自动触发 |
| 开局自动注入 system prompt | `memory-recall` 技能要求代理先 recall | 同上 |
| 可接 Hindsight / Mnemopi 后端 | 只有本地 JSON | 插件进程拿不到宿主模型 Key，外部后端也无从调用 |
| 向量检索 | 词元相似度（拉丁整词 + 汉字单字与二字组） | 零依赖、零下载、可离线验证 || 模型驱动的摘要 | 确定性规则：合并、加权、衰减、淘汰 | 不需要模型也能真实地"进化"，且每一行都可测 |

所以「自进化」在这里不是宣传词，是四条能单独测试的规则：写入合并、召回强化、
过期归档、容量淘汰。

## 结构

```
plugins/memory-hub/
  step.plugin.json        MCP + 技能 + 命令声明
  dfsc.plugin.json        作者、版本范围、外部依赖、分类
  icon.png                128×128
  README.md               安装、数据位置、权限、边界
  server/
    memory-hub.mjs        协议层（MCP over stdio）
    tools.mjs             八个工具的定义与分发
    store.mjs             分库与条目生命周期
    evolve.mjs            纯函数：合并、打分、衰减、淘汰
    json-store.mjs        锁 + 原子读写
    text.mjs              归一化、分词、相似度、脱敏
    project.mjs           项目解析与 slug
    digest.mjs            会话素材摘录
  skills/memory-recall    何时取回、怎么用结果
  skills/memory-curate    怎么收敛地整理
  commands/memory.md      /memory
  commands/remember.md    /remember
```

## 开发

```bash
node --test tests/*.test.mjs     # 109 项：单元 + 协议层 + 边界 + 健壮性
node scripts/smoke.mjs           # 真实 stdio 闭环 12 步
node scripts/eval.mjs            # 两次会话的检索效果评估（8 正样本 + 2 负样本）
node scripts/verify-fixes.mjs    # 逐条实测 0.2.0 的每个修复项（11 项）
node scripts/make-icon.mjs       # 重新生成图标
```

实机验收需要一台装了 DFSC 构建的机器（官方 StepFun 外壳没有插件中心）：

```bash
node scripts/verify-native.mjs --exe "<DFSC 可执行文件>" --playwright "<含 node_modules/playwright 的目录>"
```

它用临时 profile 与本地市场完成「发现 → 安装 → MCP 连接（8 个工具）→ 技能与命令加载 → 卸载」，
不发任何模型请求。

零第三方依赖，`package.json` 的 `dependencies` 保持为空。

设计文档：[docs/superpowers/specs/2026-11-23-dfsc-memory-hub-design.md](docs/superpowers/specs/2026-11-23-dfsc-memory-hub-design.md)
实现计划：[docs/superpowers/plans/2026-11-23-memory-hub.md](docs/superpowers/plans/2026-11-23-memory-hub.md)
变更记录：[CHANGELOG.md](CHANGELOG.md)

## 收录到 DFSC 社区市场

这个仓库是上游来源。市场收录需要：推送到 GitHub → 取完整提交 SHA →
在 `7oMB2006/dfsc-community-plugins` 的 `registry.json` 登记 →
写 `docs/plugins/memory-hub.md`（市场说明，会覆盖包内 README）→
跑同步脚本与 `validate-marketplace.py` / `check-plugin-metadata.mjs`。

未完成前，这个仓库的 `plugins/memory-hub` 只是本地资源，不会被市场发现。

## 许可证

MIT。见 [LICENSE](LICENSE)。
