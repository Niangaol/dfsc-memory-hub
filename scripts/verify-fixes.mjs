#!/usr/bin/env node
/**
 * 0.2.0 修复项逐条实测：每条断言对应 CHANGELOG 里的一个修复，
 * 用真实子进程 + 临时目录跑，不碰用户的真实记忆库。
 *
 * 运行：node scripts/verify-fixes.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../plugins/memory-hub/server/memory-hub.mjs');
const project = 'D:\\AgentPrograms\\verify-fixture';

const home = await mkdtemp(join(tmpdir(), 'mh-verify-'));
const sessions = await mkdtemp(join(tmpdir(), 'mh-verify-sessions-'));

function open(env = {}) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessions, MEMORY_HUB_PROJECT: project, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const lines = [];
  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));
  let nextId = 1;
  const call = async (name, args = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const line = lines.find((value) => {
        try { return JSON.parse(value).id === id; } catch { return false; }
      });
      if (line) {
        const reply = JSON.parse(line);
        return JSON.parse(reply.result.content[0].text);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no reply for ${name}; stderr=${stderr.slice(0, 400)}`);
  };
  return { call, close: () => child.kill(), stderr: () => stderr };
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const bankFile = (slug = '--D--AgentPrograms-verify-fixture--') => join(home, slug, 'memory.json');

try {
  const s = open();

  // ---- 1. 命中只记给返回的条目
  for (let i = 0; i < 5; i++) await s.call('retain', { text: `构建细节编号 ${i}`, tags: ['构建'] });
  const one = await s.call('recall', { query: '构建细节', limit: 1 });
  const stored = JSON.parse(await readFile(bankFile(), 'utf8'));
  const hits = stored.memories.map((m) => m.hits).sort((a, b) => a - b);
  check('命中只记给返回的条目',
    hits.filter((h) => h === 1).length === 1 && hits.filter((h) => h === 0).length === 4,
    `limit=1 之后命中分布 ${JSON.stringify(hits)}（应为 4 个 0、1 个 1）`);

  // ---- 2. 纯查询无匹配时不写盘
  const before = await stat(bankFile());
  await new Promise((r) => setTimeout(r, 30));
  const miss = await s.call('recall', { query: '完全无关的量子色动力学话题' });
  const after = await stat(bankFile());
  check('查询无匹配时不写盘',
    miss.memories.length === 0 && after.mtimeMs === before.mtimeMs,
    `返回 ${miss.memories.length} 条，文件未被改写`);

  // ---- 3. 合并分支也跑衰减（同一主题反复写入）
  const s2 = open();
  // 手工把已有条目的时间推到 61 天前，再走一次「合并」路径
  const aged = JSON.parse(await readFile(bankFile(), 'utf8'));
  const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
  for (const memory of aged.memories) {
    memory.updatedAt = old;
    memory.createdAt = old;
    memory.hits = 0;
    memory.lastHitAt = null;
  }
  await writeFile(bankFile(), JSON.stringify(aged, null, 2));
  const merged = await s2.call('retain', { text: '构建细节编号 0', tags: ['构建'] });
  const afterMerge = JSON.parse(await readFile(bankFile(), 'utf8'));
  const archived = afterMerge.memories.filter((m) => m.status === 'archived').length;
  check('合并分支也执行衰减',
    merged.action === 'merged' && archived >= 4,
    `动作=${merged.action}，归档 ${archived} 条（旧实现该分支不衰减，会一直是 0）`);
  s2.close();

  // ---- 4. source 去重并限长
  for (let i = 0; i < 8; i++) {
    await s.call('retain', { text: '构建细节编号 1', source: `session:${i}` });
  }
  const srcBank = JSON.parse(await readFile(bankFile(), 'utf8'));
  const mergedMemory = srcBank.memories.find((m) => m.text === '构建细节编号 1');
  const parts = String(mergedMemory.source).split(',').map((p) => p.trim());
  check('source 去重且限长',
    new Set(parts).size === parts.length && parts.length <= 4 && mergedMemory.source.length <= 200,
    `${parts.length} 个条目、无重复、${mergedMemory.source.length} 字符`);

  // ---- 5. memory_edit 跨库定位
  const globalOne = await s.call('retain', { text: '回答一律用中文', scope: 'global' });
  const edited = await s.call('memory_edit', { op: 'update', id: globalOne.id, text: '回答一律用中文，命令要能直接复制' });
  check('memory_edit 自动定位全局库',
    edited.ok === true && edited.bank === 'global' && edited.memory.text.includes('直接复制'),
    `bank=${edited.bank}（不传 scope 也能改到全局条目）`);

  const missing = await s.call('memory_edit', { op: 'update', id: 'm_does_not_exist', text: 'x' });
  check('未知 id 报出搜索范围',
    missing.status === 'not_found' && JSON.stringify(missing.searched) === '["project","global"]',
    `searched=${JSON.stringify(missing.searched)}`);

  // ---- 6. 合并保留干净文本
  await s.call('retain', { text: '测试   保留   干净文本' });
  await s.call('retain', { text: '测试 保留 干净文本' });
  const cleanBank = JSON.parse(await readFile(bankFile(), 'utf8'));
  const clean = cleanBank.memories.filter((m) => m.text.includes('保留'));
  check('合并保留干净文本',
    clean.length === 1 && clean[0].text === '测试 保留 干净文本',
    `只剩 1 条且为折叠后文本：「${clean[0]?.text}」`);

  // ---- 7. 工具调用失败不拖垮连接
  const bad = await s.call('memory_edit', { op: 'update', id: 'm_nope', text: 'x' });
  const alive = await s.call('stats');
  check('单次失败不影响后续请求',
    bad.ok === false && alive.ok === true,
    '失败之后 stats 仍正常');

  s.close();

  // ---- 8. 损坏库：读取报 corrupt，清空仍保留原内容
  // 用确定存在的绝对路径，避免手写转义后 project 被 resolve 成别的目录。
  const corruptProject = join(home, 'corrupt-project');
  const brokenDir = join(home, '--' + corruptProject.replace(/[\\/:]/gu, '-') + '--');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(join(brokenDir, 'memory.json'), 'this is not json');
  const s3 = open();
  const corruptStats = await s3.call('stats', { project: corruptProject });
  check('损坏库被如实报告',
    corruptStats.corrupt.project === true && corruptStats.banks.project.total === 0,
    `corrupt=${corruptStats.corrupt.project}，不伪装成空库（slug=${corruptStats.project.slug}）`);

  const purged = await s3.call('memory_purge', { scope: 'project', confirm: 'DELETE', project: corruptProject });
  const trash = (await readdir(brokenDir)).find((n) => n.includes('.trash-'));
  const trashBody = trash ? await readFile(join(brokenDir, trash), 'utf8') : '';
  check('清空损坏库时原内容留在回收站',
    purged.ok === true && purged.moved[0].corrupt === true && trashBody === 'this is not json',
    `回收站文件保留原始 ${trashBody.length} 字节`);
  s3.close();

  // ---- 9. 版本号
  const s4 = open();
  const versionProbe = spawn(process.execPath, [entry], {
    env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessions },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let raw = '';
  versionProbe.stdout.on('data', (c) => { raw += c; });
  versionProbe.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await new Promise((r) => setTimeout(r, 400));
  const info = JSON.parse(raw.trim().split('\n')[0]).result.serverInfo;
  versionProbe.kill();
  check('服务版本为 0.2.0', info.version === '0.2.0', `${info.name} v${info.version}`);
  s4.close();
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(sessions, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项修复实测通过`);
if (failed.length) {
  for (const item of failed) console.error(`  FAIL: ${item.label} — ${item.detail}`);
  process.exitCode = 1;
}
