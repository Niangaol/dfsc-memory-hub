#!/usr/bin/env node
/**
 * 真实闭环冒烟：像一个客户端那样把 server 跑起来，走完
 * retain → recall → reflect → memory_edit → history_digest → stats → purge，
 * 并检查落盘文件、脱敏、以及数据确实只在临时目录里。
 *
 * 不联网、不调模型，全部使用临时 MEMORY_HUB_HOME / MEMORY_HUB_SESSIONS。
 * 运行：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../plugins/memory-hub/server/memory-hub.mjs');
const home = await mkdtemp(join(tmpdir(), 'memory-hub-smoke-'));
const sessions = await mkdtemp(join(tmpdir(), 'memory-hub-smoke-sessions-'));
const project = join(home, 'demo-project');
const steps = [];

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_SESSIONS: sessions, MEMORY_HUB_PROJECT: project },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });
const lines = [];
createInterface({ input: child.stdout, terminal: false }).on('line', (line) => lines.push(line));

let nextId = 1;
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
async function call(name, args = {}) {
  const id = nextId++;
  send({ id, method: 'tools/call', params: { name, arguments: args } });
  await settle();
  const line = lines.find((value) => {
    try { return JSON.parse(value).id === id; } catch { return false; }
  });
  assert.ok(line, `no reply for ${name}; stderr=${stderr.slice(0, 800)}`);
  const message = JSON.parse(line);
  assert.equal(message.error, undefined, `${name} returned an error: ${JSON.stringify(message.error)}`);
  return JSON.parse(message.result.content[0].text);
}

function step(label, detail) {
  steps.push(`${label}: ${detail}`);
  process.stdout.write(`✔ ${label} — ${detail}\n`);
}

let failure;
try {
  // 造一份真实形状的会话文件，让 history_digest 有素材
  const sessionDir = join(sessions, `--${project.replace(/[\\/:]/gu, '-')}--`);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, '2026-11-23T00-00-00-000Z_smoke.jsonl'), [
    JSON.stringify({ type: 'session', cwd: project }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '构建到底用 pnpm 还是 npm？' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '仓库里是 pnpm-lock.yaml，所以用 pnpm。' }] } }),
  ].join('\n') + '\n');

  send({ id: nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await settle();
  const init = lines.map((line) => JSON.parse(line)).find((message) => message.result?.serverInfo);
  assert.equal(init.result.serverInfo.name, 'memory-hub');
  step('initialize', `serverInfo ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

  const added = await call('retain', { text: '构建用 pnpm workspaces', type: 'fact', tags: ['构建'], importance: 0.8 });
  step('retain', `action=${added.action} id=${added.id} total=${added.total}`);

  const merged = await call('retain', { text: '构建用  pnpm workspaces', type: 'fact', tags: ['构建'] });
  assert.equal(merged.action, 'merged');
  step('retain(dedup)', `action=${merged.action} total=${merged.total}（未新增条目）`);

  const secret = await call('retain', { text: '登录用 token sk-live-abcdef1234567890abcd', type: 'pitfall' });
  assert.ok(secret.redacted >= 1);
  step('retain(redact)', `redacted=${secret.redacted}`);

  const recalled = await call('recall', { query: '构建', limit: 5 });
  assert.ok(recalled.memories.length >= 1);
  assert.equal(recalled.project.source, 'env');
  step('recall', `hit=${recalled.memories[0].text} hits=${recalled.memories[0].hits} source=${recalled.project.source}`);

  const replacement = await call('retain', { text: '构建迁移到 bun，pnpm 已弃用', type: 'decision', tags: ['构建'] });
  const invalidated = await call('memory_edit', { op: 'invalidate', id: added.id, replacementId: replacement.id });
  assert.equal(invalidated.status, 'invalidated');
  const active = await call('recall', { query: '构建', limit: 10 });
  assert.equal(active.memories.some((memory) => memory.id === added.id), false, '被推翻的条目不该再出现在默认召回里');
  step('memory_edit', `invalidate ${added.id} → supersededBy ${replacement.id}`);

  const digest = await call('history_digest', { sessions: 2, maxChars: 4000 });
  assert.ok(digest.text.includes('pnpm-lock.yaml'));
  step('history_digest', `${digest.sessions.length} 个会话 / ${digest.chars} 字符 / truncated=${digest.truncated}`);

  const reflected = await call('reflect', { question: '构建' });
  assert.ok(Object.keys(reflected.groups).length >= 1);
  step('reflect', `groups=${Object.keys(reflected.groups).join(',')} conflicts=${reflected.conflicts.length}`);

  const stats = await call('stats');
  assert.equal(stats.corrupt.project, false);
  step('stats', `active=${stats.banks.project.active} invalidated=${stats.banks.project.invalidated} tags=${stats.topTags.map((tag) => tag.tag).join('|')}`);

  // 落盘检查：密钥不落盘、库文件在 home 内、无残留锁与临时文件
  const dir = join(home, stats.project.slug);
  const names = await readdir(dir);
  const raw = await readFile(join(dir, 'memory.json'), 'utf8');
  assert.ok(!raw.includes('sk-live-abcdef1234567890abcd'), '密钥不得出现在记忆文件里');
  assert.ok(!names.some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), `残留临时文件: ${names}`);
  step('disk', `${stats.project.slug}/memory.json ${raw.length} 字节，无密钥、无残留锁`);

  const purged = await call('memory_purge', { scope: 'project', confirm: 'DELETE' });
  assert.match(purged.movedTo, /\.trash-/);
  const after = await call('stats');
  assert.equal(after.banks.project.total, 0);
  step('memory_purge', `movedTo=${purged.movedTo.split(/[\\/]/u).pop()} total=${after.banks.project.total}`);

  // 坏输入不能拖垮连接
  child.stdin.write('{ broken }\n');
  await settle(150);
  const ping = await call('stats');
  assert.equal(ping.ok, true);
  step('resilience', '畸形 JSON 行之后连接仍可用');
} catch (error) {
  failure = error;
  throw error;
} finally {
  child.kill();
  await rm(home, { recursive: true, force: true });
  await rm(sessions, { recursive: true, force: true });
  process.stdout.write(`\n${steps.length} 步通过\n`);
  if (failure) process.stderr.write(`${stderr}\n`);
}
