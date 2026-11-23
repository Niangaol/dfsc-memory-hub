#!/usr/bin/env node
/**
 * 跨会话应用效果测试：用两个独立的 server 进程模拟两次会话。
 *
 * 会话 A 写入若干条真实项目结论（来自本仓库的实际开发过程），
 * 会话 B 是全新进程，用「不知道那些结论」的提问去查，看能不能取回。
 *
 * 这是「实际应用效果」的检验：不看单测断言，看检索结果像不像有人记得这个项目。
 *
 * 运行：node scripts/eval.mjs [--home <目录>]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../plugins/memory-hub/server/memory-hub.mjs');
const project = argValue('--project') ?? 'D:\\AgentPrograms\\dfsc-memory-hub';
const keepHome = argValue('--home');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function openSession(home) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_PROJECT: project },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const lines = [];
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  let nextId = 1;
  const call = async (name, args = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { ...args, project } } })}\n`);
    // 轮询而不是固定 sleep：库变大或磁盘慢时 200ms 不够，固定等待会偶发假失败。
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const line = lines.find((value) => {
        try { return JSON.parse(value).id === id; } catch { return false; }
      });
      if (line) return JSON.parse(JSON.parse(line).result.content[0].text);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no reply for ${name}; stderr=${stderr.slice(0, 400)}`);
  };
  return { call, close: () => child.kill() };
}

// 会话 A 要写下的结论：都来自本仓库真实发生过的事
const LESSONS = [
  { text: '构建与测试用 node --test tests/*.test.mjs，零第三方依赖，package.json 的 dependencies 必须为空',
    type: 'fact', tags: ['构建', '测试'], importance: 0.9 },
  { text: '记忆库是 ~/.stepcode/agent/memories/<项目slug>/memory.json，slug 与 DFSC 会话目录同一套规则',
    type: 'fact', tags: ['存储', '路径'], importance: 0.85 },
  { text: '合并阈值定 0.92 而不是 0.82：中文二字组让「构建用 pnpm」和「构建用 npm」相似度就到 0.83，阈值一松会把矛盾结论合并掉',
    type: 'decision', tags: ['进化', '阈值'], importance: 0.9 },
  { text: 'MCP 进程的 cwd 被宿主锚定到插件目录，拿不到用户项目路径，所以必须靠工具参数 project 显式传；缺省会退化到读最近会话的 cwd',
    type: 'pitfall', tags: ['项目解析', 'MCP'], importance: 0.95 },
  { text: '衰减与淘汰挂在写入路径上，项目长期不写就不会自动清理，需要手动调 memory_maintain',
    type: 'pitfall', tags: ['维护', '衰减'], importance: 0.8 },
  { text: 'DFSC 没有会话钩子，无法自动注入记忆到 system prompt，只能靠 memory-recall 技能提示代理开局主动 recall',
    type: 'lesson', tags: ['宿主限制'], importance: 0.9 },
  { text: '用户要求所有产出中文、命令可直接复制、不要浮夸语气',
    type: 'preference', tags: ['沟通'], importance: 0.7 },
  { text: 'Windows 上本机安装的 D:/StepCode 是官方 StepFun 外壳，没有插件中心，做不了市场插件的实机验收',
    type: 'pitfall', tags: ['验收', 'Windows'], importance: 0.75 },
];

// 会话 B 会用这些「自然的提问」去查，模拟真实会话里的检索。
// expect 是「目标条目的唯一标识串」；null 表示这题应当查不到（负样本）。
const QUERIES = [
  { query: '构建怎么跑测试', expect: 'node --test' },
  { query: '记忆文件存在哪', expect: 'memories' },
  { query: '为什么合并阈值是0.92', expect: '矛盾结论' },
  { query: 'project 参数为什么必须传', expect: '锚定' },
  { query: '长期不写会自动清理吗', expect: 'memory_maintain' },
  { query: '为什么不能自动注入记忆', expect: '钩子' },
  { query: '用户喜欢什么风格', expect: '浮夸' },
  { query: '实机验收为什么做不了', expect: 'StepFun' },
  // 只提到 SQLite 弃用语境里的 pnpm，「构建用 pnpm」那句已不存在；命中任一含 pnpm 的条目都算
  { query: 'pnpm', expect: null, topMustInclude: 'pnpm' },
  { query: '数据库索引优化', expect: null },
];

const home = keepHome ?? await mkdtemp(join(tmpdir(), 'memory-hub-eval-'));
const report = { project, home, written: [], queries: [], stats: null };

try {
  // ---- 会话 A：积累记忆 ----
  const a = await openSession(home);
  try {
    for (const lesson of LESSONS) {
      const result = await a.call('retain', lesson);
      report.written.push({ text: lesson.text.slice(0, 40), action: result.action, id: result.id, redacted: result.redacted });
    }
    // 一次真实的「改主意」：旧结论被推翻
    const old = await a.call('retain', { text: '记忆存 SQLite 方便查询', type: 'decision', importance: 0.6 });
    const now = await a.call('retain', { text: '不用 SQLite，改 JSON 单文件，为了零依赖且可人工审计', type: 'decision', importance: 0.8 });
    await a.call('memory_edit', { op: 'invalidate', id: old.id, replacementId: now.id });
    report.invalidated = { old: old.id, replacement: now.id };
  } finally {
    a.close();
  }

  // ---- 会话 B：全新进程，只有查询，没有上下文 ----
  const b = await openSession(home);
  try {
    for (const item of QUERIES) {
      const result = await b.call('recall', { query: item.query, limit: 3 });
      const top = result.memories[0];
      const hit = item.topMustInclude
        ? Boolean(top && top.text.includes(item.topMustInclude))
        : item.expect === null
          ? result.memories.length === 0 || (top?.score ?? 0) < 0.35
          : Boolean(top && top.text.includes(item.expect));
      report.queries.push({
        query: item.query,
        returned: result.memories.length,
        topScore: top ? Number(top.score.toFixed(3)) : null,
        topText: top ? top.text.slice(0, 46) : null,
        expected: item.expect,
        hit,
      });
    }
    const reflected = await b.call('reflect', { question: '记忆存储与进化' });
    report.reflectGroups = Object.fromEntries(Object.entries(reflected.groups).map(([key, list]) => [key, list.length]));
    report.reflectConflicts = reflected.conflicts.length;
    report.stats = await b.call('stats');
    const digest = await b.call('history_digest', { sessions: 2, maxChars: 2000 });
    report.digest = { sessions: digest.sessions.length, chars: digest.chars, truncated: digest.truncated };
  } finally {
    b.close();
  }

  const hits = report.queries.filter((item) => item.hit).length;
  console.log('=== 会话 A：写入 ===');
  for (const item of report.written) console.log(` ${item.action.padEnd(7)} ${item.id}  ${item.text}`);
  console.log(` 改主意：${report.invalidated.old} 失效 → ${report.invalidated.replacement}`);
  console.log('\n=== 会话 B：检索（全新进程） ===');
  for (const item of report.queries) {
    const mark = item.hit ? '✔' : '✖';
    console.log(` ${mark} "${item.query}" → ${item.returned} 条，最高 ${item.topScore ?? '-'}`);
    if (item.topText) console.log(`     ${item.topText}`);
  }
  console.log(`\n相关查询命中：${hits}/${report.queries.length}`);
  console.log('reflect 分组：', JSON.stringify(report.reflectGroups), '冲突组：', report.reflectConflicts);
  console.log('stats：active=' + report.stats.banks.project.active, 'invalidated=' + report.stats.banks.project.invalidated,
    'topTags=' + report.stats.topTags.map((tag) => tag.tag).join('|'));
  console.log('digest：', JSON.stringify(report.digest));
  console.log('\nhome:', home);

  const relevant = report.queries.filter((item) => item.expected !== null || item.topMustInclude).length;
  const relevantHits = report.queries.filter((item) => (item.expected !== null || item.topMustInclude) && item.hit).length;
  if (relevantHits < relevant) {
    console.error(`\nFAIL: 相关查询只命中 ${relevantHits}/${relevant}`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: 相关查询全部命中 ${relevantHits}/${relevant}`);
  }
} finally {
  if (!keepHome) await rm(home, { recursive: true, force: true }).catch(() => {});
}
